import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openPhase2Databases} from '../database.mjs';
import {seedPhase2,demoCredentials} from '../bootstrap.mjs';
import {buildPhase2App} from '../app.mjs';
import {secretVault,totp} from '../security.mjs';
import {snapshotHash} from '../agreement-content.mjs';
import {serviceDay,addServiceDays} from '../service-time.mjs';
import {closingCalculation} from '../service-closing.mjs';
import {prepareRecurring} from '../recurring.mjs';

async function fixture(t){
  const dbs=await openPhase2Databases('',{memory:true});t.after(()=>dbs.close());await seedPhase2(dbs);
  const db=dbs.commercial,app=await buildPhase2App(dbs,secretVault(Buffer.alloc(32,25)),{testing:true});t.after(()=>app.close());
  const origin='http://127.0.0.1:3030',call=(url,{method='GET',body,cookie,headers={}}={})=>app.inject({url,method,headers:{origin,...(cookie?{cookie}:{}),...headers},payload:body});
  const login=async credentials=>{const c=(await call('/api/commercial/login',{method:'POST',body:credentials})).json(),r=await call('/api/commercial/verify',{method:'POST',body:{challenge:c.challenge,code:totp(c.secret)}});assert.equal(r.statusCode,200,r.body);return{cookie:r.headers['set-cookie'].split(';')[0],user:r.json().user};};
  const admin=await login(demoCredentials.admin),seller=await login(demoCredentials.seller);
  const customer=async email=>{const c=(await call('/api/client/register',{method:'POST',body:{name:'Alex Example',email,password:'Closing-Test-2026!'}})).json();const mail=(await db.query('SELECT body FROM commercial_mail WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1',[email])).rows[0],r=await call('/api/client/verify',{method:'POST',body:{challenge:c.challenge,code:mail.body.match(/code is (\d{6})/)[1]}});assert.equal(r.statusCode,200,r.body);return{cookie:r.headers['set-cookie'].split(';')[0],profile:r.json().profile};};
  const buyer=await customer('closing-buyer@example.invalid'),other=await customer('closing-other@example.invalid');
  const source=async({segment='commercial',invoiceStatus='paid'}={})=>{
    const lead=randomUUID(),quote=randomUUID(),contract=randomUUID(),invoice=randomUUID(),change=randomUUID(),today=serviceDay();
    const snapshot={segment,customer:{name:buyer.profile.name,email:buyer.profile.email,phone:'+12505550100'},details:{first_service_date:addServiceDays(today,-100)},
      quote:{service:'Fictional cleaning',term:segment==='commercial'?'annual':'month_to_month',frequency:'weekly',total_minor:10000},visits:[{property_index:0,address:'100 Fictional Street',amount_minor:10000,discount_minor:3000}]};
    await db.query("INSERT INTO crm_leads(id,owner_id,name,email,service,stage,priority,source) VALUES($1,$2,'Alex Example',$3,$4,'won','normal','Memory fixture')",[lead,seller.user.id,buyer.profile.email,segment]);
    await db.query("INSERT INTO service_quotes(id,lead_id,actor_id,selection,result,status) VALUES($1,$2,$3,'{}','{}','approved')",[quote,lead,seller.user.id]);
    await db.query("INSERT INTO service_contracts(id,quote_id,lead_id,seller_id,customer_email,status,snapshot,snapshot_hash,accepted_by,acceptance) VALUES($1,$2,$3,$4,$5,'accepted',$6,$7,$8,'{\"consent\":true}')",[contract,quote,lead,seller.user.id,buyer.profile.email,JSON.stringify(snapshot),snapshotHash(snapshot),buyer.profile.id]);
    const invoiceSnapshot={customer:snapshot.customer,payment_terms:'Net 15',exclusions:[],lines:[{date:addServiceDays(today,-95),address:'100 Fictional Street',service:'Fictional cleaning',amount_minor:10000,discount_minor:3000}]};
    await db.query('INSERT INTO service_invoices(id,contract_id,number,customer_email,total_minor,discount_minor,period,snapshot,due_date,status,segment) VALUES($1,$2,$3,$4,10000,3000,$5,$6,$7,$8,$9)',[invoice,contract,'FIXTURE-'+invoice,buyer.profile.email,today.slice(0,7),JSON.stringify(invoiceSnapshot),today,invoiceStatus,segment]);
    if(invoiceStatus==='paid')await db.query("INSERT INTO service_invoice_payments(id,invoice_id,provider,status,amount_minor,currency,reference,expires_at) VALUES($1,$2,'demo','paid',10000,'CAD',$3,now())",[randomUUID(),invoice,'closing-source:'+invoice]);
    await db.query("INSERT INTO service_change_requests(id,contract_id,customer_id,kind,reason,status,effective_date,idempotency_key,request_hash) VALUES($1,$2,$3,'terminate','Fixture termination','approved',$4,$5,$6)",[change,contract,buyer.profile.id,addServiceDays(today,-1),randomUUID(),'0'.repeat(64)]);
    await db.query('INSERT INTO service_termination_plans(contract_id,request_id,effective_date,resolution) VALUES($1,$2,$3,$4)',[contract,change,addServiceDays(today,-1),'Isolated test approval']);
    return{lead,contract,invoice,change,snapshot,invoiceSnapshot};
  };
  const draft=async(source,recovery=2000,charge=100)=>{
    const body={change_id:source.change,recovery_minor:recovery,charge_minor:charge,due_date:addServiceDays(serviceDay(),15),reason:'Reviewed adjustment explanation for the customer'},r=await call('/api/commercial/closings',{method:'POST',cookie:admin.cookie,body});assert.equal(r.statusCode,200,r.body);return{id:r.json().id,body};
  };
  const enable=async()=>{
    for(const id of ['cancellation_policy','taxes'])await call('/api/commercial/setup/approvals/'+id,{method:'PUT',cookie:admin.cookie,body:{revision:0,approved:true,note:'Fictional policy for isolated tests only'}});
    const r=await call('/api/commercial/closings/policy',{method:'PUT',cookie:admin.cookie,body:{revision:0,enabled:true,approved:true,recovery_enabled:true,charge_cap_minor:500,taxes:[{id:'sample',label:'Fictional closing tax',basis_points:500,applies_to:'both'}],note:'Fictional test values, never installed in persistent demo'}});assert.equal(r.statusCode,200,r.body);
  };
  const review=(q,{action='approve',revision=1,cookie=admin.cookie}={})=>call('/api/commercial/closings/'+q.id+'/review',{method:'POST',cookie,body:{revision,action,note:'Isolated review decision'}});
  const issue=(q,key=randomUUID(),revision=2)=>call('/api/commercial/closings/'+q.id+'/issue',{method:'POST',cookie:admin.cookie,body:{revision,request_id:key}});
  return{db,app,call,admin,seller,buyer,other,source,draft,enable,review,issue};
}

test('closing calculation uses exact cents, explicit taxes and no default penalties',()=>{
  assert.deepEqual(closingCalculation({recovery_minor:0,charge_minor:0},{taxes:null}),{base_minor:0,tax_minor:0,total_minor:0,taxes:[],taxes_defined:false});
  const result=closingCalculation({recovery_minor:2000,charge_minor:100},{taxes:[{id:'sample',label:'Test',basis_points:500,applies_to:'both'}]});assert.equal(result.tax_minor,105);assert.equal(result.total_minor,2205);
  assert.equal(closingCalculation({recovery_minor:2000,charge_minor:100},{taxes:[{id:'sample',basis_points:500,applies_to:'charge'}]}).tax_minor,5);
});
test('closing drafts remain private and positive invoices require policy/client approvals',async t=>{
  const f=await fixture(t),s=await f.source(),q=await f.draft(s);
  assert.equal((await f.call('/api/commercial/closings')).statusCode,401);assert.equal((await f.review(q,{cookie:f.seller.cookie})).statusCode,403);
  assert.equal((await f.call('/api/client/closings',{cookie:f.buyer.cookie})).json().items.length,0);
  assert.equal((await f.review(q)).statusCode,409);assert.equal((await f.issue(q)).statusCode,409);
  const bad=await f.call('/api/commercial/closings',{method:'POST',cookie:f.admin.cookie,headers:{origin:'https://outside.invalid'},body:q.body});assert.equal(bad.statusCode,403);
  await f.enable();assert.equal((await f.review(q)).statusCode,200);
  await f.db.query('UPDATE crm_leads SET owner_id=$2 WHERE id=$1',[s.lead,f.admin.user.id]);assert.equal((await f.call('/api/commercial/closings',{cookie:f.seller.cookie})).json().items.length,0);
});
test('issued closing is separate, immutable, exactly once, manually payable and creates no commission',async t=>{
  const f=await fixture(t),s=await f.source();await f.enable();const q=await f.draft(s);assert.equal((await f.review(q)).statusCode,200);
  const key=randomUUID(),results=await Promise.all([f.issue(q,key),f.issue(q,key)]);assert.ok(results.every(r=>r.statusCode===200),results.map(r=>r.body).join('\n'));
  const id=results[0].json().invoice_id,i=(await f.db.query('SELECT * FROM service_invoices WHERE id=$1',[id])).rows[0];assert.equal(i.invoice_kind,'closing');assert.equal(Number(i.total_minor),2205);assert.equal(i.snapshot.lines.reduce((n,l)=>n+l.amount_minor,0),2205);
  assert.deepEqual((await f.db.query('SELECT snapshot FROM service_contracts WHERE id=$1',[s.contract])).rows[0].snapshot,s.snapshot);
  assert.deepEqual((await f.db.query('SELECT snapshot FROM service_invoices WHERE id=$1',[s.invoice])).rows[0].snapshot,s.invoiceSnapshot);
  assert.equal((await f.call('/api/client/closings',{cookie:f.other.cookie})).json().items.length,0);
  const own=(await f.call('/api/client/closings',{cookie:f.buyer.cookie})).json().items;assert.equal(own.length,1);assert.equal(own[0].evidence,undefined);
  assert.equal((await f.call('/api/client/invoices/'+id+'/payment',{method:'POST',cookie:f.buyer.cookie,body:{}})).statusCode,200);
  assert.equal((await f.call('/api/commercial/invoices/'+id+'/simulate-payment',{method:'POST',cookie:f.admin.cookie,body:{}})).statusCode,200);
  assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM commercial_sales WHERE service_invoice_id=$1',[id])).rows[0].n,0);
  const receipt=(await f.db.query('SELECT * FROM commercial_mail WHERE dedupe=$1',['invoice:'+id+':paid:customer'])).rows[0];assert.equal(receipt.recipient,f.buyer.profile.email);assert.equal(receipt.attachments[0].record.invoice_kind,'closing');
  assert.equal((await f.review(q,{action:'reopen',revision:3})).statusCode,409);
});
test('zero-charge closing works with pending policy without fake invoice or payment',async t=>{
  const f=await fixture(t),s=await f.source({segment:'home'}),q=await f.draft(s,0,0);
  assert.equal((await f.review(q)).statusCode,200);const r=await f.issue(q);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().status,'no_charge');assert.equal(r.json().invoice_id,null);
  assert.equal((await f.db.query("SELECT count(*)::integer AS n FROM service_invoices WHERE invoice_kind='closing'")).rows[0].n,0);
  assert.equal((await f.call('/api/client/closings',{cookie:f.buyer.cookie})).json().items[0].status,'no_charge');
});
test('stale financial evidence, excess recovery and unsettled service invoices fail closed',async t=>{
  const f=await fixture(t);await f.enable();const s=await f.source(),q=await f.draft(s,3001,0);assert.equal((await f.review(q)).statusCode,409);
  assert.equal((await f.call('/api/commercial/closings/'+q.id,{method:'PUT',cookie:f.admin.cookie,body:{...q.body,recovery_minor:2000,revision:1}})).statusCode,200);
  assert.equal((await f.review(q,{revision:2})).statusCode,200);
  await f.db.query('UPDATE service_invoices SET discount_minor=2999 WHERE id=$1',[s.invoice]);assert.equal((await f.issue(q,randomUUID(),3)).statusCode,409);
  assert.equal((await f.review(q,{action:'reopen',revision:3})).statusCode,200);
  const unpaid=await f.source({invoiceStatus:'issued'}),q2=await f.draft(unpaid);assert.equal((await f.review(q2)).statusCode,409);
});
test('closing invoices are not queued by the recurring collector and UI modules remain local',async t=>{
  const f=await fixture(t),s=await f.source();await f.enable();const q=await f.draft(s);assert.equal((await f.review(q)).statusCode,200);const r=await f.issue(q);assert.equal(r.statusCode,200,r.body);
  const authorization=await f.call('/api/client/contracts/'+s.contract+'/authorize-demo',{method:'POST',cookie:f.buyer.cookie,body:{snapshot_hash:snapshotHash(s.snapshot),signed_name:f.buyer.profile.name,consent:true,demo_acknowledged:true}});assert.equal(authorization.statusCode,200,authorization.body);
  const id=authorization.json().id;await f.call('/api/commercial/recurring/'+id+'/status',{method:'POST',cookie:f.admin.cookie,body:{revision:1,status:'active',reason:'Isolated demo activation'}});
  await f.call('/api/commercial/recurring/settings',{method:'PUT',cookie:f.admin.cookie,body:{enabled:true,retry_limit:3}});await f.db.query('UPDATE service_invoices SET due_date=$2 WHERE id=$1',[r.json().invoice_id,serviceDay()]);
  await prepareRecurring(f.db);assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM recurring_jobs WHERE invoice_id=$1',[r.json().invoice_id])).rows[0].n,0);
  const script=await f.call('/closing-workspace.js');assert.equal(script.statusCode,200);assert.ok(script.body.includes('Cierre económico'));assert.ok(!script.body.includes('api.stripe.com'));
});
