import {id,token,hash,passwordHash,passwordMatches,bearer,fail} from './lib.js';
import {now,afterMinutes,key,auditDoc,claimUnique,must} from './firestore-store.js';
import {object,email,str} from './schemas.js';

const safeUser=u=>({id:u.id,name:u.name,email:u.email,role:u.role});
export async function createUser(store,{email,name,password,role='admin'}){
  const user={id:id(),email:email.trim().toLowerCase(),name,password_hash:await passwordHash(password),role,active:true,auth_version:1,created_at:now()};
  await store.transaction(async tx=>{
    await claimUnique(tx,'email',user.email,user.id);tx.create('users',user.id,user);auditDoc(tx,user.id,'user.bootstrap',user.id);
  });return safeUser(user);
}
export function guards(store){
  return{
    guest:async request=>{
      const index=await store.get('guest_tokens',bearer(request));
      const guest=index?await store.get('guests',index.guest_id):null;
      if(!guest||guest.expires_at<=now())fail(401,'La sesión de visitante expiró');request.guest={id:guest.id};
    },
    admin:(roles=['admin','catalog','support','viewer'])=>async request=>{
      const session=await store.get('sessions',bearer(request));
      if(!session||session.expires_at<=now())fail(401,'Sesión administrativa inválida');
      const user=await store.get('users',session.user_id);
      if(!user||!user.active||session.auth_version!==user.auth_version)fail(401,'Sesión administrativa inválida');
      if(!roles.includes(user.role))fail(403,'No tienes permiso para esta operación');request.user=safeUser(user);
    }
  };
}
export async function registerAuth(app,store,config,guard){
  const dummyHash=await passwordHash(token());
  app.post('/v1/guest-sessions',{schema:{tags:['Sesiones'],summary:'Crear sesión de visitante'},config:{rateLimit:{max:20,timeWindow:'1 minute'}}},async(_,reply)=>{
    const secret=token(),guestId=id(),expires_at=afterMinutes(30*24*60);
    await store.transaction(async tx=>{
      tx.create('guests',guestId,{created_at:now(),expires_at});tx.create('guest_tokens',hash(secret),{guest_id:guestId,expires_at});
    });reply.code(201);return{id:guestId,expires_at,token:secret};
  });
  app.post('/v1/auth/login',{schema:{tags:['Acceso'],body:object({email,password:str(128)})},config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async request=>{
    const index=await store.get('unique_keys',key('email',request.body.email.toLowerCase()));
    const user=index?await store.get('users',index.owner):null;
    const matches=await passwordMatches(request.body.password,user?.password_hash||dummyHash);
    if(!user||!user.active||!matches)fail(401,'Credenciales incorrectas');
    const secret=token();
    await store.transaction(async tx=>{
      const current=await tx.get('users',user.id);
      if(!current?.active||current.password_hash!==user.password_hash)fail(401,'Credenciales incorrectas');
      tx.create('sessions',hash(secret),{user_id:user.id,expires_at:afterMinutes(config.sessionHours*60),auth_version:current.auth_version});
      auditDoc(tx,user.id,'auth.login',user.id);
    });return{token:secret,expires_in:config.sessionHours*3600,user:safeUser(user)};
  });
  const schema={tags:['Acceso'],security:[{bearerAuth:[]}]};
  app.get('/v1/auth/me',{preHandler:guard.admin(),schema},async request=>request.user);
  app.post('/v1/auth/logout',{preHandler:guard.admin(),schema},async(request,reply)=>{
    await store.transaction(async tx=>{tx.remove('sessions',bearer(request));});reply.code(204).send();
  });
  app.post('/v1/auth/password',{preHandler:guard.admin(),schema:{...schema,body:object({current_password:str(128),new_password:str(128,12)})}},async(request,reply)=>{
    const user=must(await store.get('users',request.user.id));
    if(!await passwordMatches(request.body.current_password,user.password_hash))fail(401,'Contraseña actual incorrecta');
    const encoded=await passwordHash(request.body.new_password);
    await store.transaction(async tx=>{
      const current=must(await tx.get('users',user.id));if(current.password_hash!==user.password_hash)fail(409,'La contraseña cambió; vuelve a iniciar sesión');
      tx.put('users',user.id,{...current,password_hash:encoded,auth_version:current.auth_version+1});auditDoc(tx,user.id,'auth.password_changed',user.id);
    });reply.code(204).send();
  });
}
