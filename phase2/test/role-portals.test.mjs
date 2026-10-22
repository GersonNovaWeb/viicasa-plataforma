import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {openPhase2Databases} from '../database.mjs';
import {seedPhase2,demoCredentials} from '../bootstrap.mjs';
import {buildPhase2App} from '../app.mjs';
import {secretVault,totp} from '../security.mjs';

test('separate admin and seller portals preserve MFA, roles, canonical links and platform management',async t=>{
  const databases=await openPhase2Databases('',{memory:true});t.after(()=>databases.close());await seedPhase2(databases);
  const app=await buildPhase2App(databases,secretVault(Buffer.alloc(32,6)),{testing:true});t.after(()=>app.close());
  const origin='http://127.0.0.1:3030';
  const call=(url,{method='GET',body,cookie}={})=>app.inject({url,method,headers:{origin,...(cookie?{cookie}:{})},payload:body});
  await t.test('public role login pages do not grant access; trailing slashes canonicalise',async()=>{
    for(const [path,role]of [['/admin','admin'],['/vendedor','seller'],['/equipo','team']]){
      const page=await call(path);assert.equal(page.statusCode,200);assert.match(page.body,new RegExp('data-team-portal="'+role+'"'));assert.equal(page.headers['cache-control'],'no-store');
      const trailing=await call(path+'/');assert.equal(trailing.statusCode,303);assert.equal(trailing.headers.location,path);
    }
    assert.equal((await call('/api/commercial/users')).statusCode,401);
    assert.equal((await call('/admin/plataforma')).headers.location,'/admin');
    assert.equal((await call('/admin/not-a-route')).statusCode,404);
    const platformScript=await readFile(new URL('../../viicasa-frontend-prototype/platform.js',import.meta.url),'utf8');
    assert.ok(platformScript.includes("settings.phase===2?'/commercial/logout':'/auth/logout'"));
    assert.ok(platformScript.includes("location.pathname==='/admin/plataforma'?'/admin':location.pathname"));
    const portalScript=await readFile(new URL('../public/portal.js',import.meta.url),'utf8');
    assert.ok(portalScript.includes("history.replaceState(null,'',rolePath(user.role))"));
  });
  await t.test('wrong roles fail before creating or exposing MFA challenges; portal spoofing is invalid',async()=>{
    for(const [credentials,portal]of [[demoCredentials.admin,'seller'],[demoCredentials.seller,'admin']]){
      const response=await call('/api/commercial/login',{method:'POST',body:{...credentials,portal}});assert.equal(response.statusCode,403);assert.equal(response.headers['set-cookie'],undefined);assert.equal(response.json().secret,undefined);
    }
    assert.equal((await databases.commercial.query('SELECT count(*)::integer AS n FROM team_challenges')).rows[0].n,0);
    assert.equal((await databases.commercial.query('SELECT count(*)::integer AS n FROM team_users WHERE totp_secret IS NOT NULL')).rows[0].n,0);
    const bad=await call('/api/commercial/login',{method:'POST',body:{...demoCredentials.seller,portal:'owner'}});assert.equal(bad.statusCode,400);
  });
  let admin,seller;
  const login=async(credentials,portal)=>{
    const first=await call('/api/commercial/login',{method:'POST',body:{...credentials,portal}});assert.equal(first.statusCode,200,first.body);const challenge=first.json();
    const code=totp(challenge.secret);
    const wrong=await call('/api/commercial/verify',{method:'POST',body:{challenge:challenge.challenge,code,portal:portal==='admin'?'seller':'admin'}});assert.equal(wrong.statusCode,401);assert.equal(wrong.headers['set-cookie'],undefined);
    const correct=await call('/api/commercial/verify',{method:'POST',body:{challenge:challenge.challenge,code,portal}});assert.equal(correct.statusCode,200,correct.body);
    const replay=await call('/api/commercial/verify',{method:'POST',body:{challenge:challenge.challenge,code,portal}});assert.equal(replay.statusCode,401);
    return{cookie:correct.headers['set-cookie'].split(';')[0],...correct.json()};
  };
  await t.test('verified sessions open only their assigned portal; APIs reject seller administration',async()=>{
    admin=await login(demoCredentials.admin,'admin');seller=await login(demoCredentials.seller,'seller');
    assert.equal(admin.portal_url,'/admin');assert.equal(seller.portal_url,'/vendedor');
    for(const [session,path,wrong]of [[admin,'/admin','/vendedor'],[seller,'/vendedor','/admin']]){
      assert.equal((await call(path,{cookie:session.cookie})).statusCode,200);
      assert.equal((await call(wrong,{cookie:session.cookie})).headers.location,path);
      assert.equal((await call('/equipo',{cookie:session.cookie})).headers.location,path);
    }
    assert.equal((await call('/api/commercial/users',{cookie:seller.cookie})).statusCode,403);
    assert.equal((await call('/api/commercial/setup',{cookie:seller.cookie})).statusCode,403);
    assert.equal((await call('/api/admin/products',{cookie:seller.cookie})).statusCode,403);
    assert.equal((await call('/admin/plataforma',{cookie:seller.cookie})).headers.location,'/vendedor');
    const platform=await call('/admin/plataforma',{cookie:admin.cookie});assert.equal(platform.statusCode,200);assert.match(platform.body,/platform\.js/);
    assert.equal((await call('/api/admin/products',{cookie:admin.cookie})).statusCode,200);
  });
  await t.test('logout removes the session, without allowing access through a different portal',async()=>{
    await call('/api/commercial/logout',{method:'POST',body:{},cookie:admin.cookie});
    assert.equal((await call('/admin/plataforma',{cookie:admin.cookie})).headers.location,'/admin');
    assert.equal((await call('/api/commercial/users',{cookie:admin.cookie})).statusCode,401);
    assert.equal((await call('/api/commercial/me',{cookie:seller.cookie})).json().role,'seller');
  });
});
