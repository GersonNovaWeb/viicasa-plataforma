import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {configFromEnv} from '../viicasa-backend/src/config.js';
import {buildFirestoreApp} from '../viicasa-backend/src/firestore-app.js';
import {createUser} from '../viicasa-backend/src/firestore-auth.js';
import {hash,passwordHash,passwordMatches} from '../viicasa-backend/src/lib.js';
import {key,now} from '../viicasa-backend/src/firestore-store.js';
import {adminPasswordEnabled,passwordAdminLogin,adminCookieSecret} from '../viicasa-frontend-prototype/admin-password-session.mjs';
import {ensureConfiguredAdmin} from '../viicasa-frontend-prototype/admin-bootstrap.mjs';
import {adminPasswordForm} from '../viicasa-frontend-prototype/admin-access-ui.js';

const password='Fixture-only-Strong-Pass-123!';
function memoryStore(){
  let rows=new Map(),tail=Promise.resolve();const clone=v=>v==null?v:structuredClone(v);
  const ops=map=>({get:async(c,k)=>clone(map.get(c+'/'+k)||null),put:(c,k,v)=>map.set(c+'/'+k,clone({...v,id:k})),create:(c,k,v)=>{assert.ok(!map.has(c+'/'+k));map.set(c+'/'+k,clone({...v,id:k}));},remove:(c,k)=>map.delete(c+'/'+k),list:async(c,o={})=>[...map.entries()].filter(([k,r])=>k.startsWith(c+'/')&&(o.where||[]).every(([f,op,v])=>op==='=='?r[f]===v:op==='in'?v.includes(r[f]):op==='<='?r[f]<=v:true)).map(([,v])=>clone(v)).slice(0,o.limit||100)});
  return {get:(...a)=>ops(rows).get(...a),set:(...a)=>ops(rows).put(...a),list:(...a)=>ops(rows).list(...a),transaction:fn=>{const run=tail.then(async()=>{const next=structuredClone(rows),result=await fn(ops(next));rows=next;return result;});tail=run.catch(()=>{});return run;}};
}
async function fixture(t){
  const store=memoryStore(),config=configFromEnv({FIREBASE_MODE:'emulator',FIREBASE_PROJECT_ID:'demo-admin-access',PAYMENT_PROVIDER:'demo'});
  const app=await buildFirestoreApp(config,{store,logger:false,testing:true});t.after(()=>app.close());
  const primary=await createUser(store,{name:'Primary admin',email:'primary@example.invalid',password});
  const login=await passwordAdminLogin(app,{email:primary.email,password},{remoteAddress:'127.0.0.2'});
  return {app,store,primary,secret:login.secret};
}
const request=(app,secret,method,url,payload,remoteAddress='127.0.0.1')=>app.inject({method,url,payload,remoteAddress,headers:secret?{authorization:`Bearer ${secret}`}:{}});

test('password admin switch is independent from Google and client Firebase email login',()=>{
  assert.equal(adminPasswordEnabled({},false),true);
  assert.equal(adminPasswordEnabled({ADMIN_PASSWORD_ENABLED:'false'},false),false);
  assert.equal(adminPasswordEnabled({ADMIN_PASSWORD_ENABLED:'true'},true),false);
  const es=adminPasswordForm((es)=>es,true),en=adminPasswordForm((es,en)=>en,true);
  for(const html of [es,en]){assert.match(html,/type="password"/);assert.match(html,/autocomplete="current-password"/);assert.match(html,/autocomplete="username"/);assert.ok(!html.includes(password));}
  assert.equal(adminPasswordForm(()=>'',false),'');
});

test('private provisioning creates one full admin with a hash and actor audit; duplicate and roles are rejected',async t=>{
  const {app,store,primary,secret}=await fixture(t);
  const body={name:'Additional admin',email:'additional@example.invalid',password};
  assert.equal((await request(app,null,'POST','/v1/admin/users',body)).statusCode,401);
  assert.equal((await request(app,secret,'POST','/v1/admin/users',{...body,role:'admin'})).statusCode,400);
  assert.equal((await request(app,secret,'POST','/v1/admin/users',{...body,password:'short'})).statusCode,400);
  const response=await request(app,secret,'POST','/v1/admin/users',body);assert.equal(response.statusCode,201,response.body);
  const user=response.json();assert.equal(user.role,'admin');assert.equal(user.password_hash,undefined);
  const saved=await store.get('users',user.id);assert.equal(await passwordMatches(password,saved.password_hash),true);assert.notEqual(saved.password_hash,password);
  const duplicate=await request(app,secret,'POST','/v1/admin/users',{...body,password:password+'other'});assert.equal(duplicate.statusCode,409);
  assert.equal((await store.get('users',user.id)).password_hash,saved.password_hash);
  const audit=(await store.list('audit_log')).find(a=>a.action==='admin.user_created');assert.equal(audit.actor_id,primary.id);assert.equal(audit.resource_id,user.id);assert.ok(!JSON.stringify(audit).includes(password));
  const viewer=await createUser(store,{name:'Viewer',email:'viewer@example.invalid',password,role:'viewer'});
  const session=await passwordAdminLogin(app,{email:viewer.email,password},{remoteAddress:'127.0.0.3'});
  assert.equal((await request(app,session.secret,'POST','/v1/admin/users',{...body,email:'forbidden@example.invalid'},'127.0.0.9')).statusCode,403);
});

test('password cookie sessions are checked against server roles, expiration, active status and version',async t=>{
  const {app,store,primary,secret}=await fixture(t);
  assert.equal(await adminCookieSecret(app,secret),secret);
  assert.equal(await adminCookieSecret(app,randomUUID()),null);
  assert.equal(await adminCookieSecret(app,'X'.repeat(43)),null);
  const original=await store.get('users',primary.id);
  await store.set('users',primary.id,{...original,active:false});assert.equal(await adminCookieSecret(app,secret),null);
  await store.set('users',primary.id,{...original,role:'customer'});assert.equal(await adminCookieSecret(app,secret),null);
  await store.set('users',primary.id,{...original,auth_version:2});assert.equal(await adminCookieSecret(app,secret),null);
  await store.set('users',primary.id,original);
  const session=await store.get('sessions',hash(secret));await store.set('sessions',hash(secret),{...session,expires_at:now()});
  assert.equal(await adminCookieSecret(app,secret),null);
});

test('a privately assigned 12-character password is accepted without a Google identity',async t=>{
  const {app,secret}=await fixture(t);
  const assigned='Fixture123!A';assert.equal(assigned.length,12);
  const email='non-google@example.invalid';
  const response=await request(app,secret,'POST','/v1/admin/users',{name:'Password admin',email,password:assigned});
  assert.equal(response.statusCode,201,response.body);
  const login=await passwordAdminLogin(app,{email,password:assigned},{remoteAddress:'127.0.0.20'});
  assert.equal(await adminCookieSecret(app,login.secret),login.secret);
});

test('login rejects fake role fields, wrong credentials and throttles attempts',async t=>{
  const {app}=await fixture(t);
  await assert.rejects(passwordAdminLogin(app,{email:'primary@example.invalid',password,role:'admin'}),e=>e.statusCode===400);
  for(let n=0;n<5;n++)await assert.rejects(passwordAdminLogin(app,{email:'primary@example.invalid',password:'wrong'},{remoteAddress:'127.0.0.7'}),e=>e.statusCode===401);
  await assert.rejects(passwordAdminLogin(app,{email:'primary@example.invalid',password},{remoteAddress:'127.0.0.7'}),e=>e.statusCode===429);
  await assert.rejects(passwordAdminLogin(app,{email:'missing@example.invalid',password},{remoteAddress:'127.0.0.8'}),e=>e.statusCode===401);
});

test('password changes and logout revoke sessions; a new login replaces the old cookie secret',async t=>{
  const {app,store,primary,secret}=await fixture(t);
  const second=await passwordAdminLogin(app,{email:primary.email,password},{remoteAddress:'127.0.0.4',previousSecret:secret});
  assert.equal(await adminCookieSecret(app,secret),null);assert.equal(await adminCookieSecret(app,second.secret),second.secret);
  const response=await request(app,second.secret,'POST','/v1/auth/password',{current_password:password,new_password:password+'Changed!'});assert.equal(response.statusCode,204,response.body);
  assert.equal(await adminCookieSecret(app,second.secret),null);
  await assert.rejects(passwordAdminLogin(app,{email:primary.email,password},{remoteAddress:'127.0.0.5'}),e=>e.statusCode===401);
  const last=await passwordAdminLogin(app,{email:primary.email,password:password+'Changed!'},{remoteAddress:'127.0.0.6'});
  assert.equal((await request(app,last.secret,'POST','/v1/auth/logout')).statusCode,204);
  assert.equal(await adminCookieSecret(app,last.secret),null);
  assert.equal((await store.get('users',primary.id)).auth_version,2);
});

test('deployment bootstrap is live-only, atomic, one-time and never resets an existing or revoked account',async()=>{
  const store=memoryStore(),encoded=await passwordHash(password);
  const env={ADMIN_BOOTSTRAP_ENABLED:'true',ADMIN_BOOTSTRAP_EMAIL:'additional@example.invalid',ADMIN_BOOTSTRAP_PASSWORD_HASH:encoded};
  assert.equal((await ensureConfiguredAdmin(store,{},{})).state,'disabled');
  await assert.rejects(ensureConfiguredAdmin(store,env,{demo:true,projectId:'viicasa'}));
  await assert.rejects(ensureConfiguredAdmin(store,env,{demo:false,projectId:'other-project'}));
  await assert.rejects(ensureConfiguredAdmin(store,{...env,ADMIN_BOOTSTRAP_PASSWORD_HASH:password},{demo:false,projectId:'viicasa'}));
  const results=await Promise.all([1,2].map(()=>ensureConfiguredAdmin(store,env,{demo:false,projectId:'viicasa'})));
  assert.deepEqual(results.map(r=>r.state).sort(),['already_configured','created']);
  assert.equal((await store.list('users')).length,1);
  const index=await store.get('unique_keys',key('email',env.ADMIN_BOOTSTRAP_EMAIL)),user=await store.get('users',index.owner);
  assert.equal(user.role,'admin');assert.equal(await passwordMatches(password,user.password_hash),true);
  const changed=await passwordHash(password+'changed');await store.set('users',user.id,{...user,active:false,password_hash:changed,auth_version:2});
  await ensureConfiguredAdmin(store,env,{demo:false,projectId:'viicasa'});
  assert.equal((await store.get('users',user.id)).password_hash,changed);assert.equal((await store.get('users',user.id)).active,false);
  await assert.rejects(ensureConfiguredAdmin(store,{...env,ADMIN_BOOTSTRAP_EMAIL:'other@example.invalid'},{demo:false,projectId:'viicasa'}),e=>e.statusCode===409);
  const existing=memoryStore();await createUser(existing,{email:env.ADMIN_BOOTSTRAP_EMAIL,name:'Existing',password,role:'viewer'});
  await assert.rejects(ensureConfiguredAdmin(existing,env,{demo:false,projectId:'viicasa'}),e=>e.statusCode===409);
  assert.equal((await existing.list('users'))[0].role,'viewer');assert.equal(await existing.get('system','password_admin_bootstrap'),null);
});

test('HTTP bridge checks same-origin writes, hides bearer tokens and keeps server-only helpers private',async()=>{
  const server=await readFile(new URL('../viicasa-frontend-prototype/platform-server.mjs',import.meta.url),'utf8');
  const staticServer=await readFile(new URL('../viicasa-frontend-prototype/server.mjs',import.meta.url),'utf8');
  assert.match(server,/req\.headers\.origin!==origin/);
  assert.match(server,/HttpOnly; SameSite=Lax/);assert.match(server,/Secure/);
  assert.match(server,/secretCookie\(res,'vc_admin',session.secret,session.expiresIn\);json\(res,200,\{ok:true\}\)/);
  assert.match(server,/adminCookieSecret\(app,cookies\(req\).vc_admin\)/);
  assert.match(server,/identityUid&&!passwordSecret/);
  assert.match(server,/isAllowedGoogleAdmin\(verified,process.env.ADMIN_EMAILS\)/);
  assert.match(staticServer,/'admin-access-ui.js'/);
  assert.ok(!staticServer.includes("'admin-password-session.mjs'"));assert.ok(!staticServer.includes("'admin-bootstrap.mjs'"));
});
