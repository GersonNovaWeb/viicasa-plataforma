import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openPhase2Databases} from '../database.mjs';
import {seedPhase2,demoCredentials} from '../bootstrap.mjs';
import {buildPhase2App} from '../app.mjs';
import {secretVault,totp} from '../security.mjs';
import {quoteService} from '../service-menu.mjs';
import {configuredQuote,emptyPricing} from '../pricing-calculation.mjs';
import {plannedVisits,snapshotHash} from '../agreement-content.mjs';
import {serviceDay,addServiceDays} from '../service-time.mjs';

const properties=[{address:'100 Fictional Office',sqft:1000},{address:'200 Fictional Office',sqft:2000}];
const selection={service_id:'commercial-fixed-weekly',rate_minor:10001,quantity:1,visits:2,frequency:'weekly',term:'month_to_month',properties,weekly_days:[1,3,5]};
const details={first_service_date:'2027-01-27',arrival_window:'09:00-12:00',properties};
test('weekly package counts its price once per rolling block and allocates exact cents to multiple weekdays',()=>{
  const q=quoteService(selection),visits=plannedVisits(q,details);assert.equal(q.total_minor,20002);assert.equal(q.execution_visits,12);assert.equal(visits.length,12);
  assert.deepEqual(visits.slice(0,6).map(v=>v.service_date),['2027-01-27','2027-01-29','2027-02-01','2027-02-03','2027-02-05','2027-02-08']);
  for(const block of [0,1])assert.equal(visits.filter(v=>v.block_index===block).reduce((n,v)=>n+v.amount_minor,0),10001);
  assert.equal(visits.reduce((n,v)=>n+v.amount_minor,0),q.total_minor);
});
test('per-execution minimums, extras and taxes use every actual visit while package rate remains unchanged',()=>{
  const p={...emptyPricing('commercial'),approved:true,revision:1,min_visit_minor:null,taxes:[],extras:[{id:'supplies',label:'Fictional supplies',basis:'visit',amount_minor:100,taxable:true}]};
  const q=configuredQuote({...selection,pricing_revision:1,extras:[{id:'supplies',quantity:1}]},p);assert.equal(q.pricing.rows.length,12);assert.equal(q.pricing.totals.extras_minor,1200);assert.equal(q.total_minor,21202);
  const visits=plannedVisits(q,details);assert.equal(visits.reduce((n,v)=>n+v.amount_minor,0),q.total_minor);
  assert.ok(visits.every(v=>v.pricing.block_index===v.block_index));
});
test('invalid weekday scopes, duplicates, wrong first date and oversized schedules are rejected; legacy schedule stays unchanged',()=>{
  for(const days of [[1,1],[7],[-1],['1']])assert.throws(()=>quoteService({...selection,weekly_days:days}));
  assert.throws(()=>quoteService({...selection,service_id:'commercial-team',rate_minor:7500,quantity:2}));
  assert.throws(()=>plannedVisits(quoteService(selection),{...details,first_service_date:'2027-01-28'}));
  assert.throws(()=>quoteService({...selection,visits:100}));
  const legacy=quoteService({...selection,weekly_days:[]});assert.equal(legacy.weekly_days,undefined);assert.equal(plannedVisits(legacy,details).length,4);
  const tooLong=quoteService({...selection,visits:13,term:'annual',weekly_days:[0,6]});
  // The last block starts within the introductory window, but its Saturday visit does not.
  assert.throws(()=>plannedVisits(tooLong,{...details,first_service_date:'2027-01-31'}));
});
test('weekday packages persist through approved quote, acceptance, immutable pricing and monthly invoices',async t=>{
  const dbs=await openPhase2Databases('',{memory:true});t.after(()=>dbs.close());await seedPhase2(dbs);const db=dbs.commercial;
  const app=await buildPhase2App(dbs,secretVault(Buffer.alloc(32,26)),{testing:true});t.after(()=>app.close());
  const origin='http://127.0.0.1:3030',call=(url,{method='GET',body,cookie}={})=>app.inject({url,method,headers:{origin,...(cookie?{cookie}:{})},payload:body});
  const login=async credentials=>{const c=(await call('/api/commercial/login',{method:'POST',body:credentials})).json(),r=await call('/api/commercial/verify',{method:'POST',body:{challenge:c.challenge,code:totp(c.secret)}});assert.equal(r.statusCode,200,r.body);return r.headers['set-cookie'].split(';')[0];};
  const admin=await login(demoCredentials.admin),seller=await login(demoCredentials.seller),email='weekly@example.invalid';
  const registration=(await call('/api/client/register',{method:'POST',body:{name:'Alex Example',email,password:'Weekly-Test-2026!'}})).json();
  const mail=(await db.query('SELECT body FROM commercial_mail WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1',[email])).rows[0],verification=await call('/api/client/verify',{method:'POST',body:{challenge:registration.challenge,code:mail.body.match(/code is (\d{6})/)[1]}});assert.equal(verification.statusCode,200,verification.body);const buyer=verification.headers['set-cookie'].split(';')[0];
  const leadResponse=await call('/api/commercial/leads',{method:'POST',cookie:seller,body:{name:'Alex Example',email,phone:'+12505550100',company:'Fictional office',service:'commercial',stage:'proposal',priority:'normal',source:'Isolated weekly fixture',notes:''}});assert.equal(leadResponse.statusCode,200,leadResponse.body);const lead=leadResponse.json().id;
  const policy={revision:0,approved:true,min_visit_minor:null,taxes:[],extras:[{id:'supplies',label:'Fictional supplies',basis:'visit',amount_minor:100,taxable:true}],note:'Fictional test values only'};
  assert.equal((await call('/api/commercial/pricing/commercial',{method:'PUT',cookie:admin,body:policy})).statusCode,200);
  const body={...selection,lead_id:lead,pricing_revision:1,extras:[{id:'supplies',quantity:1}]},preview=await call('/api/commercial/quotes/preview',{method:'POST',cookie:seller,body});assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.json().execution_visits,12);
  const quoteResponse=await call('/api/commercial/quotes',{method:'POST',cookie:seller,body});assert.equal(quoteResponse.statusCode,200,quoteResponse.body);const quote=quoteResponse.json();
  assert.equal((await call('/api/commercial/quotes/'+quote.id+'/review',{method:'POST',cookie:admin,body:{revision:1,action:'approve'}})).statusCode,200);
  let first=addServiceDays(serviceDay(),7);while(new Date(first+'T12:00:00Z').getUTCDay()!==1)first=addServiceDays(first,1);
  const response=await call('/api/commercial/contracts',{method:'POST',cookie:seller,body:{quote_id:quote.id,scope:'Fictional multi-day weekly package',first_service_date:first,arrival_window:'09:00-12:00',billing_contact:'Alex Example',properties:properties.map(p=>({...p,type:'office'}))}});assert.equal(response.statusCode,200,response.body);const contract=response.json();assert.equal(contract.snapshot.visits.length,12);
  await call('/api/commercial/contracts/'+contract.id+'/send',{method:'POST',cookie:seller,body:{}});
  const accepted=await call('/api/client/contracts/'+contract.id+'/accept',{method:'POST',cookie:buyer,body:{snapshot_hash:snapshotHash(contract.snapshot),signed_name:'Alex Example',consent:true,subcontractors:true,access_method:'arrival',photo_marketing_optout:true}});assert.equal(accepted.statusCode,200,accepted.body);
  assert.equal((await call('/api/commercial/pricing/commercial',{method:'PUT',cookie:admin,body:{...policy,revision:1,min_visit_minor:9000,note:'Changed rule must not affect accepted schedule'}})).statusCode,200);
  const visits=(await call('/api/client/visits',{cookie:buyer})).json().items;assert.equal(visits.length,12);
  for(const v of visits)assert.equal((await call('/api/commercial/visits/'+v.id+'/status',{method:'POST',cookie:admin,body:{status:'completed'}})).statusCode,200);
  let total=0;for(const period of new Set(visits.map(v=>v.service_date.slice(0,7)))){
    const invoice=await call('/api/commercial/invoices',{method:'POST',cookie:admin,body:{contract_id:contract.id,period}});assert.equal(invoice.statusCode,200,invoice.body);total+=invoice.json().total_minor;
  }
  assert.equal(total,quote.total_minor);assert.deepEqual((await db.query('SELECT snapshot FROM service_contracts WHERE id=$1',[contract.id])).rows[0].snapshot,contract.snapshot);
  const html=await call('/api/client/contracts/'+contract.id+'/print',{cookie:buyer});assert.equal(html.statusCode,200);assert.ok(html.body.includes('weekly blocks; 12 execution visits'));
  const editor=await call('/quote-editor.js');assert.ok(editor.body.includes('data-weekday'));
});
