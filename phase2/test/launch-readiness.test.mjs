// Prepared, not executed during development: run with the final acceptance pass.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openPhase2Databases} from '../database.mjs';
import {seedPhase2,demoCredentials} from '../bootstrap.mjs';
import {buildPhase2App} from '../app.mjs';
import {secretVault,totp} from '../security.mjs';
import {safeLaunchRuntime} from '../launch-readiness.mjs';
import {launchCatalogue} from '../launch-catalogue.mjs';

async function fixture(t){
  const databases=await openPhase2Databases('',{memory:true});t.after(()=>databases.close());await seedPhase2(databases);
  const db=databases.commercial,app=await buildPhase2App(databases,secretVault(Buffer.alloc(32,22)),{testing:true});t.after(()=>app.close());
  const call=(url,{method='GET',body,cookie,origin='http://127.0.0.1:3030'}={})=>app.inject({url,method,headers:{origin,...(cookie?{cookie}:{})},payload:body});
  const login=async credentials=>{const c=(await call('/api/commercial/login',{method:'POST',body:credentials})).json();const r=await call('/api/commercial/verify',{method:'POST',body:{challenge:c.challenge,code:totp(c.secret)}});assert.equal(r.statusCode,200,r.body);return{cookie:r.headers['set-cookie'].split(';')[0],user:r.json().user};};
  const admin=await login(demoCredentials.admin),seller=await login(demoCredentials.seller);
  const report=async()=>{const r=await call('/api/commercial/launch',{cookie:admin.cookie});assert.equal(r.statusCode,200,r.body);return r.json();};
  const body=async(id,change={})=>{const data=await report(),item=data.items.find(i=>i.id===id);return{revision:item.revision,state:'ready_for_test',owner_id:admin.user.id,due_date:null,note:'Prepared for final validation',evidence:'',fingerprint:data.fingerprint,...change};};
  const save=async(id,change={})=>call('/api/commercial/launch/checks/'+id,{method:'PUT',cookie:admin.cookie,body:await body(id,change)});
  return{db,app,call,admin,seller,report,body,save};
}

test('launch catalogue dependencies are unique and ordered; safe runtime never includes secret values',()=>{
  const ids=new Set();for(const item of launchCatalogue){assert.ok(!ids.has(item.id));for(const dependency of item.dependencies)assert.ok(ids.has(dependency),'Dependency must precede consumer: '+dependency);ids.add(item.id);}
  const data=safeLaunchRuntime({origin:'https://demo.example.invalid',config:{mailMode:'smtp',smtp:{host:'example.invalid',auth:{user:'private-user',pass:'PRIVATE-SMTP-PASSWORD'}},stripeKey:'sk_test_PRIVATE',stripeWebhookSecret:'whsec_PRIVATE'},
    databaseDriver:'postgres',identityStatus:{},connectionEnvironment:{PHASE2_SHOPIFY_ACCESS_TOKEN:'PRIVATE-SHOPIFY-TOKEN'},paymentProvider:'stripe',sourceRevision:'a'.repeat(64)});
  const text=JSON.stringify(data);for(const secret of ['PRIVATE-SMTP-PASSWORD','private-user','sk_test_PRIVATE','whsec_PRIVATE','PRIVATE-SHOPIFY-TOKEN'])assert.ok(!text.includes(secret));
  assert.equal(data.adapters.shopify,false);assert.equal(data.smtp_ready,true);assert.equal(data.stripe_test_key,true);
});

test('admin-only planning has no production switch, does not run tests and reads without writes',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/api/commercial/launch')).statusCode,401);
  for(const url of ['/api/commercial/launch','/api/commercial/launch/export','/api/commercial/launch/checks/team_access/history'])assert.equal((await f.call(url,{cookie:f.seller.cookie})).statusCode,403);
  const initial=await f.report();assert.equal(initial.production_enabled,false);assert.equal(initial.independently_verified,false);assert.equal(initial.totals.passed,0);assert.equal(initial.missing_recorded_approvals.length,12);
  assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM launch_checks')).rows[0].n,0);
  const ready=await f.save('team_access');assert.equal(ready.statusCode,200,ready.body);
  const history=(await f.call('/api/commercial/launch/checks/team_access/history',{cookie:f.admin.cookie})).json().items;assert.equal(history.length,1);assert.equal(history[0].snapshot.verification,'manual_team_report');
  const body=await f.body('customer_email');assert.equal((await f.call('/api/commercial/launch/checks/customer_email',{method:'PUT',body,cookie:f.seller.cookie})).statusCode,403);
  assert.equal((await f.call('/api/commercial/launch/checks/customer_email',{method:'PUT',body,cookie:f.admin.cookie,origin:'https://outside.invalid'})).statusCode,403);
});

test('reported passes require owner/evidence and current prerequisites; missing adapters cannot be passed',async t=>{
  const f=await fixture(t);
  assert.equal((await f.save('team_access',{state:'passed',owner_id:null})).statusCode,400);
  assert.equal((await f.save('team_access',{state:'passed',evidence:''})).statusCode,400);
  assert.equal((await f.save('team_access',{state:'passed',evidence:'Final check reference 2026-10-13'})).statusCode,200);
  assert.equal((await f.save('customer_ownership',{state:'passed',evidence:'Ownership check reference'})).statusCode,409);
  assert.equal((await f.save('customer_email',{state:'passed',evidence:'Email login check reference'})).statusCode,200);
  assert.equal((await f.save('customer_ownership',{state:'passed',evidence:'Ownership check reference'})).statusCode,200);
  assert.equal((await f.save('shop_internal',{state:'passed',evidence:'Internal catalogue check reference'})).statusCode,200);
  assert.equal((await f.save('shopify_connection',{state:'passed',evidence:'Cannot bypass missing adapter'})).statusCode,409);
  const data=await f.report();assert.ok(data.items.find(i=>i.id==='shopify_connection').blockers.includes('requirement:shopify_adapter'));assert.equal(data.production_enabled,false);
  assert.equal((await f.save('team_access',{state:'pending',evidence:''})).statusCode,200);
  const stale=await f.report();assert.equal(stale.items.find(i=>i.id==='customer_ownership').effective_state,'stale');assert.equal(stale.items.find(i=>i.id==='shop_internal').effective_state,'stale');
});

test('optimistic revisions, fingerprints, date validation and secret guards protect recorded results',async t=>{
  const f=await fixture(t),original=await f.body('team_access');
  assert.equal((await f.call('/api/commercial/launch/checks/team_access',{method:'PUT',cookie:f.admin.cookie,body:original})).statusCode,200);
  assert.equal((await f.call('/api/commercial/launch/checks/team_access',{method:'PUT',cookie:f.admin.cookie,body:original})).statusCode,409);
  assert.equal((await f.save('team_access',{due_date:'2026-02-30'})).statusCode,400);
  assert.equal((await f.save('team_access',{note:'Do not record sk_test_SECRET'})).statusCode,400);
  assert.equal((await f.save('team_access',{state:'blocked',note:''})).statusCode,400);
  const before=await f.body('team_access');
  await f.db.query("INSERT INTO phase2_settings(key,value) VALUES('approval:prices','{\"approved\":true,\"revision\":1}')");
  assert.equal((await f.call('/api/commercial/launch/checks/team_access',{method:'PUT',cookie:f.admin.cookie,body:before})).statusCode,409);
  assert.equal((await f.save('team_access',{state:'passed',evidence:'Reviewed current source and configuration'})).statusCode,200);
  await f.db.query("UPDATE phase2_settings SET value='{\"approved\":false,\"revision\":2}' WHERE key='approval:prices'");
  assert.equal((await f.report()).items.find(i=>i.id==='team_access').effective_state,'stale');
});

test('CSV/JSON exports are private reports, preserve history and escape spreadsheet formulas',async t=>{
  const f=await fixture(t);assert.equal((await f.save('team_access',{note:'=HYPERLINK("https://example.invalid")'})).statusCode,200);
  const csv=await f.call('/api/commercial/launch/export?format=csv',{cookie:f.admin.cookie});assert.equal(csv.statusCode,200,csv.body);assert.match(csv.headers['cache-control'],/no-store/);assert.ok(csv.body.includes("'=HYPERLINK"));
  const json=await f.call('/api/commercial/launch/export?format=json',{cookie:f.admin.cookie});assert.equal(json.statusCode,200);assert.equal(json.json().verification,'manual_team_report');assert.equal(json.json().production_enabled,false);
  assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM launch_check_history')).rows[0].n,1);
  const script=await f.call('/launch-workspace.js');assert.equal(script.statusCode,200);assert.ok(script.body.includes('Plan de validación'));assert.ok(!script.body.includes('process.env'));
});
