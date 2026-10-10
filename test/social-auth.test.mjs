import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {enabledSocialProviders,validateSocialIdentity,isAllowedGoogleAdmin} from '../viicasa-backend/src/social-auth.js';
import {saveSocialCustomer,publicCustomer,listRegisteredCustomers} from '../viicasa-backend/src/customer-registration.js';
import {key,openFirestore} from '../viicasa-backend/src/firestore-store.js';
import {configFromEnv} from '../viicasa-backend/src/config.js';

const enabled={google:true,apple:true,email:true,facebook:false};
const identity=(provider='google.com',uid='qa-user')=>({uid,email:'qa@example.invalid',name:'QA Customer',email_verified:true,auth_time:1000,firebase:{sign_in_provider:provider}});
test('social providers are opt-in and unavailable in isolated local mode',()=>{
  assert.deepEqual(enabledSocialProviders({},false),{google:false,apple:false,email:false,facebook:false});
  assert.deepEqual(enabledSocialProviders({FIREBASE_WEB_API_KEY:'public-fixture'},false),{google:true,apple:false,email:false,facebook:false});
  const env={FIREBASE_WEB_API_KEY:'public-fixture',AUTH_APPLE_ENABLED:'true',AUTH_EMAIL_ENABLED:'true',AUTH_FACEBOOK_ENABLED:'true'};
  assert.deepEqual(enabledSocialProviders(env,false),enabled);
  assert.deepEqual(enabledSocialProviders(env,true),{google:false,apple:false,email:false,facebook:false});
});
test('three verified Firebase social providers accepted with recent authentication',()=>{
  for(const p of ['google.com','apple.com','password'])assert.equal(validateSocialIdentity(identity(p),enabled,{fresh:true,now:1100}),p);
});
test('unverified or missing email is never trusted, including for email/password',()=>{
  for(const email_verified of [false,undefined,'true'])assert.throws(()=>validateSocialIdentity({...identity('password'),email_verified},enabled),/Verifica/);
  for(const email of [undefined,'',' '])assert.throws(()=>validateSocialIdentity({...identity(),email},enabled),/correo/);
  assert.throws(()=>validateSocialIdentity({...identity(),uid:''},enabled),/Identidad/);
});
test('disabled, unknown and mismatched providers cannot create a session',()=>{
  assert.throws(()=>validateSocialIdentity(identity('facebook.com'),enabled),/Proveedor/);
  assert.throws(()=>validateSocialIdentity(identity('apple.com'),{...enabled,apple:false}),/Proveedor/);
  assert.throws(()=>validateSocialIdentity(identity('apple.com'),enabled,{expectedProvider:'google.com'}),/Proveedor/);
});
test('rejects stale, missing and future auth_time; existing session needs no fresh login',()=>{
  for(const auth_time of [undefined,NaN,'1000',699,1200])assert.throws(()=>validateSocialIdentity({...identity(),auth_time},enabled,{fresh:true,now:1100}),/Vuelve/);
  assert.equal(validateSocialIdentity(identity(),enabled,{now:99999}),'google.com');
});
test('only verified Google identities on the exact admin allowlist can administer',()=>{
  assert.equal(isAllowedGoogleAdmin(identity(),' QA@example.invalid '),true);
  for(const p of ['apple.com','facebook.com','password'])assert.equal(isAllowedGoogleAdmin(identity(p),'qa@example.invalid'),false);
  assert.equal(isAllowedGoogleAdmin({...identity(),email_verified:false},'qa@example.invalid'),false);
  assert.equal(isAllowedGoogleAdmin(identity(),'other@example.invalid'),false);
  assert.equal(Boolean(isAllowedGoogleAdmin(null,'qa@example.invalid')),false);
});

function memoryStore(){
  const rows=new Map();
  const store={
    async get(c,k){return rows.get(c+'/'+k)||null;},
    put(c,k,v){rows.set(c+'/'+k,{...v,id:k});},
    create(c,k,v){assert.ok(!rows.has(c+'/'+k));this.put(c,k,v);},
    async list(c,{limit=100}={}){return [...rows].filter(([k])=>k.startsWith(c+'/')).map(([,v])=>v).slice(0,limit);},
    async transaction(fn){return fn(store);},
  };return store;
}
test('legacy Google history is preserved; linked providers share UID without duplicate accounts',async()=>{
  const store=memoryStore();
  store.put('platform_accounts',key('google','qa-user'),{guest_id:'old-guest'});
  store.put('guests','old-guest',{google_uid:'qa-user',name:'Existing name',email:'qa@example.invalid',created_at:'2026-01-01'});
  const result=await saveSocialCustomer(store,{...identity('apple.com'),name:undefined},'CA','fixture-session');
  assert.equal(result.firebase_uid,'qa-user');assert.equal(result.name,'Existing name');
  assert.equal(result.login_provider,'apple.com');assert.equal(result.created_at,'2026-01-01');
  assert.equal(result.registration.region,'unknown');assert.equal(result.email_verified,true);
  assert.equal((await store.get('platform_accounts',key('google','qa-user'))).guest_id,'old-guest');
  assert.equal((await store.list('platform_accounts')).length,1);
});
test('different Firebase UIDs never merge by email; relay emails and all providers appear in admin list',async()=>{
  const store=memoryStore();
  for(const [i,p]of ['google.com','apple.com','password'].entries())await saveSocialCustomer(store,identity(p,'user-'+i),'CA','fixture-'+i);
  await saveSocialCustomer(store,{...identity('apple.com','relay'),email:'example@privaterelay.appleid.com'},'US','fixture-relay');
  const page=await listRegisteredCustomers(store);
  assert.equal(page.items.length,4);
  assert.equal(new Set((await store.list('platform_accounts')).map(a=>a.guest_id)).size,4);
  assert.ok(page.items.some(p=>p.login_provider==='password'));
  for(const row of page.items){assert.equal(row.email_verified,true);assert.equal(row.firebase_uid,undefined);assert.equal(row.google_uid,undefined);}
});
test('old records have unknown verification status, not a fabricated verification badge',()=>{
  const row=publicCustomer({google_uid:'legacy',email:'old@example.invalid'});
  assert.equal(row.login_provider,'google.com');assert.equal(row.email_verified,null);
});
test('multi-provider persistence works in the isolated Firestore emulator',{skip:!process.env.TEST_FIRESTORE_HOST},async()=>{
  const store=await openFirestore(configFromEnv({DATABASE_DRIVER:'firestore',FIREBASE_MODE:'emulator',FIREBASE_PROJECT_ID:'demo-social-'+randomUUID().slice(0,8),FIRESTORE_EMULATOR_HOST:process.env.TEST_FIRESTORE_HOST,PAYMENT_PROVIDER:'demo'}));
  try{
    for(const [i,p]of ['google.com','apple.com','password'].entries())await saveSocialCustomer(store,identity(p,'user-'+i),'CA','test-'+i);
    const index=await store.get('platform_accounts',key('google','user-0'));
    await saveSocialCustomer(store,identity('apple.com','user-0'),'US','test-linked');
    assert.equal((await store.get('platform_accounts',key('google','user-0'))).guest_id,index.guest_id);
    const page=await listRegisteredCustomers(store);
    assert.equal(page.items.length,3);
    assert.equal(page.items.filter(x=>x.login_provider==='apple.com').length,2);
    assert.ok(page.items.every(x=>x.email_verified===true&&x.registration.region==='canada'));
  }finally{await store.close();}
});
