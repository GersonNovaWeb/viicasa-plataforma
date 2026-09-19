import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {registrationRegion,saveGoogleCustomer,listRegisteredCustomers} from '../src/customer-registration.js';
import {buildApp} from '../src/app.js';
import {configFromEnv} from '../src/config.js';
import {key,afterMinutes} from '../src/firestore-store.js';
import {hash,token} from '../src/lib.js';

test('IP registration groups distinguish Canada, rest of world and unavailable',()=>{
  assert.deepEqual(registrationRegion('CA'),{country:'CA',region:'canada',source:'ip'});
  for(const c of ['US','MX','GB'])assert.equal(registrationRegion(c).region,'rest_of_world');
  for(const c of [null,undefined,'','invalid','ZZ','XX'])assert.equal(registrationRegion(c).region,'unknown');
});

test('registered customer persistence and admin-only listing in isolated emulator',{skip:!process.env.TEST_FIRESTORE_HOST},async t=>{
  const project='demo-reg-'+randomUUID().slice(0,8);
  const config=configFromEnv({DATABASE_DRIVER:'firestore',FIREBASE_MODE:'emulator',FIREBASE_PROJECT_ID:project,FIRESTORE_EMULATOR_HOST:process.env.TEST_FIRESTORE_HOST,PAYMENT_PROVIDER:'demo'});
  const app=await buildApp(config,{logger:false,testing:true}),store=app.store;
  const user={uid:'qa-google-canada',name:'QA Canada',email:'qa-canada@example.invalid'};
  const ok=(response,status=200)=>{assert.equal(response.statusCode,status,response.body);return response.json();};
  let first;
  try{
    await t.test('first verified registration stores a country estimate, not raw IP',async()=>{
      first=await saveGoogleCustomer(store,user,'CA',token());
      assert.equal(first.registration.region,'canada');assert.equal(first.registration.country,'CA');
      assert.ok(first.registration.recorded_at);assert.equal(first.registration.ip,undefined);
      const account=await store.get('platform_accounts',key('google',user.uid));
      assert.deepEqual((await store.get('guests',account.guest_id)).registration,first.registration);
    });
    await t.test('later login from another country keeps the original registration',async()=>{
      const again=await saveGoogleCustomer(store,{...user,name:'QA Updated'},'US',token());
      assert.deepEqual(again.registration,first.registration);assert.equal(again.name,'QA Updated');
      assert.equal(await store.count('platform_accounts'),1);
    });
    await t.test('legacy accounts remain unknown rather than inventing historical country',async()=>{
      await store.set('guests','legacy-guest',{google_uid:'legacy',name:'QA Legacy',email:'legacy@example.invalid',created_at:'2026-01-01T00:00:00.000Z'});
      await store.set('platform_accounts',key('google','legacy'),{guest_id:'legacy-guest'});
      const legacy=await saveGoogleCustomer(store,{uid:'legacy',name:'QA Legacy',email:'legacy@example.invalid'},'CA',token());
      assert.equal(legacy.registration.region,'unknown');assert.equal(legacy.registration.recorded_at,null);
      await saveGoogleCustomer(store,{uid:'qa-world',name:'QA World',email:'world@example.invalid'},'MX',token());
      await saveGoogleCustomer(store,{uid:'qa-unknown',name:'QA Unknown',email:'unknown@example.invalid'},null,token());
    });
    await t.test('pagination includes old accounts, excludes anonymous visitors and private identity fields',async()=>{
      await store.set('guests','anonymous',{created_at:new Date().toISOString()});
      const rows=[];let cursor;do{const page=await listRegisteredCustomers(store,{limit:2,cursor});rows.push(...page.items);cursor=page.next_cursor;}while(cursor);
      assert.equal(rows.length,4);assert.equal(new Set(rows.map(r=>r.id)).size,4);
      assert.ok(rows.some(r=>r.registration.region==='canada'));assert.ok(rows.some(r=>r.registration.region==='rest_of_world'));
      for(const row of rows){assert.equal(row.google_uid,undefined);assert.equal(row.expires_at,undefined);assert.equal(row.token,undefined);}
    });
    await t.test('anonymous and catalog roles cannot list clients; admin and support can',async()=>{
      ok(await app.inject({url:'/v1/admin/customers'}),401);
      for(const role of ['catalog','viewer','support','admin']){
        const secret=token(),uid=randomUUID();
        await store.set('users',uid,{email:role+'@example.invalid',name:role,role,active:true,auth_version:1});
        await store.set('sessions',hash(secret),{user_id:uid,auth_version:1,expires_at:afterMinutes(5)});
        const result=await app.inject({url:'/v1/admin/customers?limit=2',headers:{authorization:'Bearer '+secret}});
        if(role==='catalog')ok(result,403);else {const page=ok(result);assert.equal(page.items.length,2);assert.ok(page.next_cursor);}
        if(role==='admin')ok(await app.inject({url:'/v1/admin/customers?cursor=invalid',headers:{authorization:'Bearer '+secret}}),400);
      }
    });
  }finally{await app.close();}
});
