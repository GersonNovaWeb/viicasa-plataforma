import {initializeApp,applicationDefault,cert,deleteApp} from 'firebase-admin/app';
import {getFirestore,FieldPath} from 'firebase-admin/firestore';
import {id,hash,fail} from './lib.js';

export const now=()=>new Date().toISOString();
export const afterMinutes=n=>new Date(Date.now()+n*60000).toISOString();
export const key=(namespace,value)=>hash(`${namespace}:${value}`);
export const must=(value,message='Registro no encontrado')=>{if(!value)fail(404,message);return value;};
export const clean=row=>{
  if(!row)return row;
  const {search_terms,auth_version,token_hash,password_hash,...result}=row;
  return result;
};
export function searchTerms(text){
  const words=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return [...new Set(words.flatMap(word=>Array.from({length:Math.min(word.length,24)},(_,i)=>word.slice(0,i+1))))].slice(0,300);
}
export async function openFirestore(config){
  const emulator=config.firebaseMode==='emulator';
  // Explicit endpoint prevents accidental fallback to the real project during local tests.
  if(emulator && (!config.firebaseProjectId.startsWith('demo-') || !/^(localhost|127\.0\.0\.1):\d+$/.test(config.firestoreEmulatorHost)))throw new Error('Configuración de emulador inválida');
  if(!emulator && process.env.FIRESTORE_EMULATOR_HOST)throw new Error('FIRESTORE_EMULATOR_HOST no debe existir en modo live');
  let credential;
  if(!emulator){
    try{
      if(process.env.FIREBASE_SERVICE_ACCOUNT_JSON){
        const value=JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        if(value.type!=='service_account'||value.project_id!==config.firebaseProjectId)throw new Error();
        credential=cert(value);
      }else credential=applicationDefault();
    }catch{throw new Error('Credencial privada de Firebase inválida; revisa tipo y proyecto.');}
  }
  const firebase=initializeApp({projectId:config.firebaseProjectId,
    ...(emulator?{}:{credential}),storageBucket:config.firebaseStorageBucket},`viicasa-${id()}`);
  const database=getFirestore(firebase);
  database.settings(emulator?{host:config.firestoreEmulatorHost,ssl:false,credentials:{client_email:'emulator@example.invalid',private_key:'unused'}}:{});
  const ref=(collection,docId)=>database.collection(collection).doc(docId);
  const result=snap=>snap.exists?{...snap.data(),id:snap.id}:null;
  function query(collection,options={}){
    let q=database.collection(collection);
    for(const [field,op,value]of options.where||[])q=q.where(field,op,value);
    for(const [field,direction]of options.order||[])q=q.orderBy(field==='__name__'?FieldPath.documentId():field,direction);
    if(options.cursor)q=q.startAfter(...options.cursor);
    if(options.offset)q=q.offset(options.offset);
    return q.limit(options.limit??100);
  }
  const store={
    database,
    get:async(c,k)=>result(await ref(c,k).get()),
    list:async(c,o)=> (await query(c,o).get()).docs.map(result),
    count:async(c,where=[])=>{let q=database.collection(c);for(const [f,op,v]of where)q=q.where(f,op,v);return(await q.count().get()).data().count;},
    set:(c,k,value)=>ref(c,k).set(value),
    close:async()=>{await database.terminate();await deleteApp(firebase);},
    async transaction(fn){
      return database.runTransaction(async native=>{
        const reads=new Map(),writes=new Map();
        const path=(c,k)=>`${c}/${k}`;
        const tx={
          async get(c,k){
            const p=path(c,k);
            if(!reads.has(p))reads.set(p,result(await native.get(ref(c,k))));
            const pending=writes.get(p);
            if(!pending)return reads.get(p);
            if(pending.kind==='delete')return null;
            return pending.value;
          },
          async list(c,o){
            if(writes.size)throw new Error('Las consultas transaccionales deben preceder a las escrituras');
            return(await native.get(query(c,o))).docs.map(s=>{const r=result(s);reads.set(s.ref.path,r);return r;});
          },
          put(c,k,value){writes.set(path(c,k),{kind:'set',ref:ref(c,k),value:{...value,id:k}});},
          create(c,k,value){writes.set(path(c,k),{kind:'create',ref:ref(c,k),value:{...value,id:k}});},
          remove(c,k){writes.set(path(c,k),{kind:'delete',ref:ref(c,k)});},
        };
        const value=await fn(tx);
        // Buffering ensures the SDK always performs all reads before any writes.
        for(const change of writes.values()){
          if(change.kind==='delete')native.delete(change.ref);
          else if(change.kind==='create')native.create(change.ref,change.value);
          else native.set(change.ref,change.value);
        }
        return value;
      },{maxAttempts:8});
    },
  };
  return store;
}
export async function initializeStore(store){
  await store.transaction(async tx=>{
    for(const currency of ['MXN','USD','CAD']){
      if(!await tx.get('shop_settings',currency))tx.create('shop_settings',currency,{currency,pickup_enabled:true,shipping_enabled:false,
        shipping_minor:0,pickup_instructions:'',terms:''});
    }
    if(!await tx.get('system','schema'))tx.create('system','schema',{version:1,created_at:now()});
  });
}
export function auditDoc(tx,actor,action,resource,detail={}){
  const auditId=id();tx.create('audit_log',auditId,{actor_id:actor,action,resource_id:resource,detail,created_at:now()});
}
export async function claimUnique(tx,namespace,value,owner){
  const index=key(namespace,value),existing=await tx.get('unique_keys',index);
  if(existing && existing.owner!==owner)fail(409,'Ya existe un registro con ese identificador');
  tx.put('unique_keys',index,{owner});
}
