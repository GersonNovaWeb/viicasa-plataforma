import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {configuredQuote,emptyPricing} from '../pricing-calculation.mjs';
import {plannedVisits} from '../agreement-content.mjs';
import {openPhase2Databases} from '../database.mjs';
import {seedPhase2,demoCredentials} from '../bootstrap.mjs';
import {buildPhase2App} from '../app.mjs';
import {secretVault,totp} from '../security.mjs';
import {decimalMinor,quoteBreakdown} from '../public/pricing-workspace.js';
import {contractBody,invoiceBody} from '../service-documents.mjs';

const selection={service_id:'commercial-fixed-weekly',rate_minor:10000,quantity:1,visits:2,frequency:'weekly',term:'annual',properties:[{address:'100 Example Street',sqft:1000},{address:'200 Example Street',sqft:2000}]};
const rules={approved:true,min_visit_minor:4000,taxes:[{id:'sample-tax',label:'Sample demo tax',basis_points:500}],extras:[{id:'supplies',label:'Demo supplies',basis:'visit',amount_minor:300,taxable:true},{id:'travel',label:'Demo travel',basis:'schedule',amount_minor:1001,taxable:false}],note:'Isolated technical fixture, not real tax or pricing policy'};
const input={...selection,pricing_revision:1,extras:[{id:'supplies',quantity:2},{id:'travel',quantity:1}]};

test('negotiated weekly package counted once across properties; cents, minimums, selected fees and taxes allocate exactly',()=>{
  const policy={...emptyPricing('commercial'),...rules,revision:1},q=configuredQuote(input,policy);
  assert.equal(q.subtotal_minor,20000);assert.equal(q.intro_discount_minor,6000);assert.equal(q.total_minor,20321);
  assert.deepEqual(q.pricing.totals,{service_minor:14000,discount_minor:6000,minimum_minor:2000,extras_minor:3401,tax_minor:920,amount_minor:20321});
  assert.deepEqual(q.pricing.rows.map(v=>v.amount_minor),[5081,5080,5080,5080]);
  const details={first_service_date:'2027-01-04',arrival_window:'09:00–12:00',properties:selection.properties};
  const visits=plannedVisits(q,details);assert.equal(visits.reduce((n,v)=>n+v.amount_minor,0),q.total_minor);assert.equal(visits.reduce((n,v)=>n+v.discount_minor,0),q.intro_discount_minor);
  assert.throws(()=>plannedVisits(q,{...details,properties:[selection.properties[0]]}),e=>e.statusCode===409);
  const noAnnual=configuredQuote({...input,term:'month_to_month'},policy);assert.equal(noAnnual.intro_discount_minor,0);
  const noExtras=configuredQuote({...input,extras:[]},policy);assert.equal(noExtras.pricing.totals.extras_minor,0);
  assert.throws(()=>configuredQuote({...input,quantity:2},policy));assert.throws(()=>configuredQuote({...input,frequency:'daily'},policy));
});
test('unknown configuration never imposes fees; no invented tax or floating-point frontend amounts',()=>{
  const pending=configuredQuote(selection,emptyPricing('commercial'));assert.equal(pending.total_minor,14000);assert.equal(pending.pricing.status,'not_approved');
  assert.throws(()=>configuredQuote({...selection,extras:input.extras},emptyPricing('commercial')),e=>e.statusCode===409);
  const q=configuredQuote({...selection,pricing_revision:1},{...emptyPricing('commercial'),approved:true,revision:1});assert.equal(q.total_minor,14000);assert.equal(q.pricing.taxes_defined,false);assert.ok(q.exclusions.some(e=>e.includes('Taxes are not configured')));
  const noTax=configuredQuote({...selection,pricing_revision:1},{...emptyPricing('commercial'),approved:true,revision:1,taxes:[],min_visit_minor:0});assert.equal(noTax.pricing.taxes_defined,true);assert.equal(noTax.pricing.minimum_defined,true);assert.ok(!noTax.exclusions.some(e=>e.includes('not configured')));
  assert.throws(()=>configuredQuote({...input,extras:[...input.extras,input.extras[0]]},{...emptyPricing('commercial'),...rules,revision:1}),e=>e.statusCode===400);
  assert.equal(decimalMinor('99.99'),9999);assert.equal(decimalMinor('0.05'),5);assert.equal(decimalMinor('5'),500);
  for(const bad of ['1.001','-1','1e3','NaN',''])assert.throws(()=>decimalMinor(bad));
});

async function fixture(t){
  const dbs=await openPhase2Databases('',{memory:true});t.after(()=>dbs.close());await seedPhase2(dbs);const db=dbs.commercial;
  const app=await buildPhase2App(dbs,secretVault(Buffer.alloc(32,19)),{testing:true});t.after(()=>app.close());
  const origin='http://127.0.0.1:3030',call=(url,{method='GET',cookie,body,headers={}}={})=>app.inject({url,method,headers:{origin,...(cookie?{cookie}:{}),...headers},payload:body});
  const login=async credentials=>{const c=(await call('/api/commercial/login',{method:'POST',body:credentials})).json();const r=await call('/api/commercial/verify',{method:'POST',body:{challenge:c.challenge,code:totp(c.secret)}});assert.equal(r.statusCode,200,r.body);return{cookie:r.headers['set-cookie'].split(';')[0],user:r.json().user};};
  const admin=await login(demoCredentials.admin),seller=await login(demoCredentials.seller);
  const email='priced-customer@example.invalid',registration=(await call('/api/client/register',{method:'POST',body:{name:'Alex Example',email,password:'Priced-Customer-2026!'}})).json();
  const mail=(await db.query('SELECT body FROM commercial_mail WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1',[email])).rows[0];
  const verified=await call('/api/client/verify',{method:'POST',body:{challenge:registration.challenge,code:mail.body.match(/code is (\d{6})/)[1]}});assert.equal(verified.statusCode,200,verified.body);const buyer=verified.headers['set-cookie'].split(';')[0];
  const lead=randomUUID();await db.query("INSERT INTO crm_leads(id,owner_id,name,email,service,stage,priority,source) VALUES($1,$2,'Alex Example',$3,'commercial','proposal','normal','Isolated pricing fixture')",[lead,seller.user.id,email]);
  const save=async(revision,changes={})=>call('/api/commercial/pricing/commercial',{method:'PUT',cookie:admin.cookie,body:{revision,...rules,...changes}});
  return{db,call,admin,seller,buyer,lead,save};
}
test('configured pricing integrates with immutable agreements, invoices, receipt attachments and protected roles',async t=>{
  const f=await fixture(t),{db,call,admin,seller,buyer,lead}=f;let quoteId,contractId,invoiceId,quote;
  await t.test('pending defaults, admin-only mutation, stale and malformed rules rejected',async()=>{
    const p=(await call('/api/commercial/pricing',{cookie:seller.cookie})).json().items.find(p=>p.segment==='commercial');assert.equal(p.approved,false);assert.equal(p.taxes,null);assert.equal(p.min_visit_minor,null);assert.deepEqual(p.extras,[]);
    assert.equal((await call('/api/commercial/pricing',{cookie:buyer})).statusCode,401);
    assert.equal((await call('/api/commercial/pricing/commercial',{method:'PUT',cookie:seller.cookie,body:{revision:0,...rules}})).statusCode,403);
    assert.equal((await call('/api/commercial/pricing/commercial',{method:'PUT',cookie:admin.cookie,headers:{origin:'https://other.invalid'},body:{revision:0,...rules}})).statusCode,403);
    assert.equal((await f.save(0,{extras:[...rules.extras,rules.extras[0]]})).statusCode,400);
    assert.equal((await f.save(0,{taxes:[{id:'bad',label:'Invalid percentage',basis_points:10001}]})).statusCode,400);
    assert.equal((await f.save(0,{approved:false})).statusCode,200);
    assert.equal((await f.save(0)).statusCode,409);
    const pending=await call('/api/commercial/quotes',{method:'POST',cookie:seller.cookie,body:{...selection,lead_id:lead,pricing_revision:1}});assert.equal(pending.statusCode,200,pending.body);assert.equal(pending.json().total_minor,14000);
    assert.equal((await call('/api/commercial/quotes',{method:'POST',cookie:seller.cookie,body:{...input,lead_id:lead}})).statusCode,409);
    assert.equal((await f.save(1)).statusCode,200);
  });
  await t.test('server preview has no quote/sale side effects and stale drafts cannot be approved',async()=>{
    const count=(await db.query('SELECT count(*)::integer AS n FROM service_quotes')).rows[0].n;
    const body={...input,pricing_revision:2,lead_id:lead},preview=await call('/api/commercial/quotes/preview',{method:'POST',cookie:seller.cookie,body});assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.json().total_minor,20321);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM service_quotes')).rows[0].n,count);
    assert.equal((await call('/api/commercial/quotes',{method:'POST',cookie:seller.cookie,body:{...body,total_minor:1}})).statusCode,400);
    const created=await call('/api/commercial/quotes',{method:'POST',cookie:seller.cookie,body});assert.equal(created.statusCode,200,created.body);quoteId=created.json().id;
    assert.equal((await f.save(2,{min_visit_minor:4100})).statusCode,200);
    assert.equal((await call('/api/commercial/quotes/'+quoteId+'/review',{method:'POST',cookie:admin.cookie,body:{action:'approve',revision:1}})).statusCode,409);
    const edit=await call('/api/commercial/quotes/'+quoteId,{method:'PUT',cookie:seller.cookie,body:{...body,pricing_revision:3,revision:1}});assert.equal(edit.statusCode,200,edit.body);assert.equal(edit.json().total_minor,20741);
    assert.equal((await call('/api/commercial/quotes/'+quoteId+'/review',{method:'POST',cookie:admin.cookie,body:{action:'approve',revision:2}})).statusCode,200);
    quote=(await db.query('SELECT result FROM service_quotes WHERE id=$1',[quoteId])).rows[0].result;
  });
  await t.test('agreement acceptance freezes gross visit prices and invoice breakdown at the approved version',async()=>{
    const date=new Date();date.setUTCMonth(date.getUTCMonth()+1,3);
    const created=await call('/api/commercial/contracts',{method:'POST',cookie:seller.cookie,body:{quote_id:quoteId,scope:'Weekly care across the two agreed offices',first_service_date:date.toISOString().slice(0,10),arrival_window:'09:00–12:00',billing_contact:'Alex Example',properties:selection.properties.map(p=>({...p,type:'office'}))}});assert.equal(created.statusCode,200,created.body);contractId=created.json().id;
    await call('/api/commercial/contracts/'+contractId+'/send',{method:'POST',cookie:seller.cookie,body:{}});
    const contract=(await call('/api/client/contracts/'+contractId,{cookie:buyer})).json();
    const accept=await call('/api/client/contracts/'+contractId+'/accept',{method:'POST',cookie:buyer,body:{snapshot_hash:contract.snapshot_hash,signed_name:'Alex Example',consent:true,subcontractors:true,access_method:'arrival',photo_marketing_optout:true}});assert.equal(accept.statusCode,200,accept.body);
    const visits=(await call('/api/commercial/visits',{cookie:admin.cookie})).json().items.filter(v=>v.contract_id===contractId);assert.equal(visits.length,4);assert.equal(visits.reduce((n,v)=>n+v.amount_minor,0),quote.total_minor);
    for(const v of visits)assert.equal((await call('/api/commercial/visits/'+v.id+'/status',{method:'POST',cookie:admin.cookie,body:{status:'completed'}})).statusCode,200);
    assert.equal((await f.save(3,{taxes:null,extras:[],min_visit_minor:null})).statusCode,200);
    const first=visits[0];await db.query('UPDATE service_visits SET pricing=$2 WHERE id=$1',[first.id,JSON.stringify({...first.pricing,tax_minor:first.pricing.tax_minor+1})]);
    const damaged=await call('/api/commercial/invoices',{method:'POST',cookie:admin.cookie,body:{contract_id:contractId,period:visits[0].service_date.slice(0,7)}});assert.equal(damaged.statusCode,409,damaged.body);
    await db.query('UPDATE service_visits SET pricing=$2 WHERE id=$1',[first.id,JSON.stringify(first.pricing)]);
    const issued=await call('/api/commercial/invoices',{method:'POST',cookie:admin.cookie,body:{contract_id:contractId,period:visits[0].service_date.slice(0,7)}});assert.equal(issued.statusCode,200,issued.body);invoiceId=issued.json().id;assert.equal(issued.json().total_minor,20741);
    const invoice=(await db.query('SELECT * FROM service_invoices WHERE id=$1',[invoiceId])).rows[0];assert.equal(invoice.snapshot.pricing.policy_revision,3);assert.equal(invoice.snapshot.pricing.totals.tax_minor,940);assert.equal(invoice.snapshot.pricing.rows.length,4);
    assert.ok(invoiceBody(invoice).includes('Demo travel'));assert.ok(contractBody(contract).includes('Sample demo tax'));
    const pdf=await call('/api/client/invoices/'+invoiceId+'/pdf',{cookie:buyer});assert.equal(pdf.statusCode,200,pdf.body);assert.equal(pdf.rawPayload.subarray(0,5).toString(),'%PDF-');
    const unchanged=(await call('/api/client/contracts/'+contractId,{cookie:buyer})).json();assert.equal(unchanged.snapshot_hash,contract.snapshot_hash);assert.equal(unchanged.snapshot.quote.pricing.policy_revision,3);
  });
  await t.test('gross CAD amount flows into settlement; buyer receives immutable pricing receipt, not the current policy',async()=>{
    assert.equal((await call('/api/client/invoices/'+invoiceId+'/payment',{method:'POST',cookie:buyer,body:{}})).statusCode,200);
    assert.equal((await call('/api/commercial/invoices/'+invoiceId+'/simulate-payment',{method:'POST',cookie:admin.cookie,body:{}})).statusCode,200);
    const m=(await db.query('SELECT * FROM commercial_mail WHERE dedupe=$1',['invoice:'+invoiceId+':paid:customer'])).rows[0];assert.equal(m.recipient,'priced-customer@example.invalid');assert.equal(m.attachments[0].record.snapshot.pricing.policy_revision,3);assert.equal(Number(m.attachments[0].record.total_minor),20741);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM pricing_policy_versions WHERE segment=$1',['commercial'])).rows[0].n,4);
    const current=(await call('/api/commercial/pricing',{cookie:admin.cookie})).json().items.find(p=>p.segment==='commercial');assert.equal(current.revision,4);
  });
  await t.test('new ES/EN editor and pricing panel are served; outputs escape arbitrary labels',async()=>{
    for(const url of ['/quote-editor.js','/pricing-workspace.js'])assert.equal((await call(url)).statusCode,200);
    const text=quoteBreakdown({...quote,service:'<script>example</script>'},{L:(_,en)=>en,esc:v=>String(v).replaceAll('<','&lt;'),money:n=>n+' CAD'});assert.ok(!text.includes('<script>example'));assert.ok(text.includes('Minimum adjustment'));
  });
});
