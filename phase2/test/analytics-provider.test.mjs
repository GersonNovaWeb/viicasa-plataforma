import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {moduleFixture} from './module-fixture.mjs';
import {analyticsGateway} from '../analytics-provider.mjs';
const event=()=>({id:randomUUID(),consent_id:randomUUID(),event_key:'a'.repeat(64),name:'purchase',section:'viilife',created_at:new Date().toISOString(),params:{amount_minor:12345,currency:'CAD'}});
test('analytics provider payloads are pseudonymous, CAD and versioned; sources cannot overlap',async()=>{
  const calls=[],fetcher=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response(url.includes('/debug/')?JSON.stringify({validationMessages:[]}):url.includes('facebook')?JSON.stringify({events_received:1}):null,{status:url.includes('/mp/collect')&&!url.includes('/debug/')?204:200});};
  const env={PHASE2_GA4_ENABLED:'true',PHASE2_GA4_MEASUREMENT_ID:'G-EXAMPLE',PHASE2_GA4_API_SECRET:'fixture-only',PHASE2_META_ENABLED:'true',PHASE2_META_PIXEL_ID:'123456789',PHASE2_META_GRAPH_VERSION:'v24.0',PHASE2_META_ACCESS_TOKEN:'fixture-only',PHASE2_META_TEST_EVENT_CODE:'TEST1'},g=analyticsGateway(env,{fetcher}),e=event();
  await g.send('ga4',e);await g.send('meta',e);assert.equal(calls.length,3);assert.equal(calls[1].body.events[0].params.value,123.45);assert.equal(calls[1].body.events[0].params.currency,'CAD');assert.equal(calls[2].body.data[0].event_id,e.id);assert.equal(calls[2].body.data[0].user_data.external_id[0].length,64);assert.ok(!JSON.stringify(calls.map(c=>c.body)).includes(e.consent_id));assert.ok(!JSON.stringify(calls.map(c=>c.body)).includes('email'));
  assert.throws(()=>analyticsGateway({...env,PHASE2_GTM_ENABLED:'true'}),/duplicate/);assert.throws(()=>analyticsGateway({PHASE2_META_ENABLED:'true'}),/Test Events/);
});
async function privacy(f){assert.equal((await f.call('/api/commercial/setup/approvals/privacy',{method:'PUT',cookie:f.admin.cookie,body:{approved:true,note:'Technical fixture only',revision:0}})).statusCode,200);assert.equal((await f.call('/api/commercial/measurement/settings',{method:'PUT',cookie:f.admin.cookie,body:{journal_enabled:true,retention_days:30,revision:0}})).statusCode,200);}
async function choice(f,cookie){const p=(await f.call('/api/privacy/preferences',{cookie})).json(),r=await f.call('/api/privacy/preferences',{method:'PUT',cookie,body:{statistics:true,marketing:true,policy_version:p.policy_version}});assert.equal(r.statusCode,200,r.body);return r.headers['set-cookie'].split(';')[0];}
const page=(f,cookie)=>f.post('/api/measurement/events',{event_id:randomUUID(),name:'page_view',section:'viilife'},cookie);
const share=f=>f.call('/api/commercial/analytics/settings',{method:'PUT',cookie:f.admin.cookie,body:{revision:0,approved:true,note:'Separate sharing approval fixture'}});
test('external analytics needs separate approval, fresh consent and exactly-once claims; withdrawal stops queued sends',async t=>{
  const sent=[],f=await moduleFixture(t,{providerGateways:{analytics:{providers:['ga4','meta'],gtm:null,send:async(provider,e)=>{sent.push({provider,id:e.id});return{accepted:true};}}}});
  assert.equal((await share(f)).statusCode,409);await privacy(f);let cookie=await choice(f);await page(f,cookie);
  assert.equal((await f.post('/api/commercial/analytics/process',{confirmed:true})).json().accepted,0);
  assert.equal((await f.call('/api/commercial/analytics/settings',{method:'PUT',cookie:f.seller.cookie,body:{revision:0,approved:true,note:'No permission'}})).statusCode,403);assert.equal((await share(f)).statusCode,200);
  assert.equal((await f.call('/api/privacy/preferences',{cookie})).json().chosen,false);await f.post('/api/commercial/analytics/process',{confirmed:true});assert.equal(sent.length,0);
  cookie=await choice(f,cookie);await page(f,cookie);await Promise.all([f.post('/api/commercial/analytics/process',{confirmed:true}),f.post('/api/commercial/analytics/process',{confirmed:true})]);assert.equal(sent.length,2);
  await page(f,cookie);const p=(await f.call('/api/privacy/preferences',{cookie})).json();await f.call('/api/privacy/preferences',{method:'PUT',cookie,body:{statistics:false,marketing:false,policy_version:p.policy_version}});await f.post('/api/commercial/analytics/process',{confirmed:true});assert.equal(sent.length,2);
});
test('GTM bootstrap is consent-gated and GPC wins; uncertain direct sends are not automatically resent',async t=>{
  let sends=0;const f=await moduleFixture(t,{providerGateways:{analytics:{providers:['ga4'],gtm:'GTM-EXAMPLE',send:async()=>{sends++;throw Error('Uncertain network delivery');}}}});assert.equal((await f.call('/api/analytics/bootstrap')).json().gtm,null);await privacy(f);await share(f);const cookie=await choice(f);assert.equal((await f.call('/api/analytics/bootstrap',{cookie})).json().gtm,'GTM-EXAMPLE');
  const gpc=await f.app.inject({url:'/api/analytics/bootstrap',headers:{cookie,'sec-gpc':'1'}});assert.equal(gpc.json().gtm,null);assert.equal((await f.call('/analytics-external.js')).statusCode,200);
  await page(f,cookie);await f.post('/api/commercial/analytics/process',{confirmed:true});await f.post('/api/commercial/analytics/process',{confirmed:true});assert.equal(sends,1);assert.equal((await f.db.query('SELECT status FROM analytics_deliveries')).rows[0].status,'unknown');
});
