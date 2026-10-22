import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openPhase2Databases} from '../database.mjs';
import {seedPhase2,demoCredentials} from '../bootstrap.mjs';
import {buildPhase2App} from '../app.mjs';
import {secretVault,totp} from '../security.mjs';
import {invoiceFinance} from '../financial-core.mjs';
import {processServiceOperations,serviceToday} from '../service-operations.mjs';

async function fixture(t,options={}){
  const dbs=await openPhase2Databases('',{memory:true});t.after(()=>dbs.close());await seedPhase2(dbs);const db=dbs.commercial;
  const app=await buildPhase2App(dbs,secretVault(Buffer.alloc(32,20)),{testing:true,...options});t.after(()=>app.close());
  const origin='http://127.0.0.1:3030',call=(url,{method='GET',body,cookie,headers={}}={})=>app.inject({url,method,headers:{origin,...(cookie?{cookie}:{}),...headers},payload:body});
  const login=async credentials=>{const c=(await call('/api/commercial/login',{method:'POST',body:credentials})).json();const r=await call('/api/commercial/verify',{method:'POST',body:{challenge:c.challenge,code:totp(c.secret)}});assert.equal(r.statusCode,200,r.body);return{cookie:r.headers['set-cookie'].split(';')[0],user:r.json().user};};
  const admin=await login(demoCredentials.admin),seller=await login(demoCredentials.seller);
  const customer=async email=>{const c=(await call('/api/client/register',{method:'POST',body:{name:'Alex Example',email,password:'Finance-Customer-2026!'}})).json();const m=(await db.query('SELECT body FROM commercial_mail WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1',[email])).rows[0];const r=await call('/api/client/verify',{method:'POST',body:{challenge:c.challenge,code:m.body.match(/code is (\d{6})/)[1]}});assert.equal(r.statusCode,200,r.body);return{cookie:r.headers['set-cookie'].split(';')[0],profile:r.json().profile};};
  const buyer=await customer('finance-buyer@example.invalid'),other=await customer('finance-other@example.invalid');
  const invoice=async()=>{
    const lead=randomUUID(),quote=randomUUID(),contract=randomUUID(),id=randomUUID(),number='FINANCE-'+id.slice(0,8),snapshot={customer:{name:buyer.profile.name,email:buyer.profile.email},payment_terms:'Due on completion',lines:[{date:'2026-01-01',address:'100 Fictional Street',service:'Demo service',amount_minor:10000}],exclusions:[]};
    await db.query("INSERT INTO crm_leads(id,owner_id,name,email,service,stage,priority,source) VALUES($1,$2,'Alex Example',$3,'home','won','normal','Isolated fixture')",[lead,seller.user.id,buyer.profile.email]);
    await db.query("INSERT INTO service_quotes(id,lead_id,actor_id,selection,result,status) VALUES($1,$2,$3,'{}','{}','approved')",[quote,lead,seller.user.id]);
    await db.query("INSERT INTO service_contracts(id,quote_id,lead_id,seller_id,customer_email,status,snapshot,snapshot_hash) VALUES($1,$2,$3,$4,$5,'accepted',$6,$7)",[contract,quote,lead,seller.user.id,buyer.profile.email,JSON.stringify({segment:'home'}),'0'.repeat(64)]);
    await db.query('INSERT INTO service_invoices(id,contract_id,number,customer_email,total_minor,period,snapshot,due_date) VALUES($1,$2,$3,$4,10000,$5,$6,now()::date)',[id,contract,number,buyer.profile.email,'2026-01',JSON.stringify(snapshot)]);return{id,lead,snapshot,number};
  };
  const request=async(i,kind='credit',amount=2000,who=buyer)=>{const body={invoice_id:i.id,kind,amount_minor:amount,reason:'Review this demonstration invoice',idempotency_key:randomUUID()},r=await call('/api/client/financial/requests',{method:'POST',cookie:who.cookie,body});assert.equal(r.statusCode,200,r.body);return{id:r.json().id,body};};
  const review=async(q,action='approve',revision=1,amount)=>{const body={revision,action,resolution:'Reviewed for isolated demonstration',...(amount?{approved_minor:amount}:{})};return call('/api/commercial/financial/requests/'+q.id+'/review',{method:'POST',cookie:admin.cookie,body});};
  const simulate=(q,revision=2,outcome='succeeded',attempt_id=randomUUID())=>call('/api/commercial/financial/requests/'+q.id+'/simulate',{method:'POST',cookie:admin.cookie,body:{revision,outcome,attempt_id}});
  const pay=async i=>{const prepared=await call('/api/client/invoices/'+i.id+'/payment',{method:'POST',cookie:buyer.cookie,body:{}});assert.equal(prepared.statusCode,200,prepared.body);const r=await call('/api/commercial/invoices/'+i.id+'/simulate-payment',{method:'POST',cookie:admin.cookie,body:{}});assert.equal(r.statusCode,200,r.body);};
  return{db,app,call,admin,seller,buyer,other,invoice,request,review,simulate,pay};
}

test('supervised adjustments isolate roles, preserve evidence and separate approval from demo execution',async t=>{
  const f=await fixture(t),{db,call,admin,seller,buyer,other}=f;
  await t.test('only invoice owner requests; admin reviews; origin, amounts and replay are checked',async()=>{
    const i=await f.invoice(),q=await f.request(i);
    assert.equal((await call('/api/client/financial/requests',{method:'POST',cookie:other.cookie,body:q.body})).statusCode,404);
    assert.equal((await call('/api/client/financial/requests',{method:'POST',cookie:buyer.cookie,headers:{origin:'https://outside.invalid'},body:q.body})).statusCode,403);
    assert.equal((await call('/api/client/financial/requests',{method:'POST',cookie:buyer.cookie,body:q.body})).json().id,q.id);
    assert.equal((await call('/api/client/financial/requests',{method:'POST',cookie:buyer.cookie,body:{...q.body,amount_minor:2500}})).statusCode,409);
    assert.equal((await call('/api/client/financial/requests',{method:'POST',cookie:buyer.cookie,body:{...q.body,idempotency_key:randomUUID(),amount_minor:10001}})).statusCode,409);
    assert.equal((await call('/api/commercial/financial/requests/'+q.id+'/review',{method:'POST',cookie:seller.cookie,body:{revision:1,action:'approve',resolution:'Forbidden review'}})).statusCode,403);
    assert.equal((await f.review(q,'approve',5)).statusCode,409);
    assert.equal((await f.review(q,'approve',1,1500)).statusCode,200);
    assert.equal((await f.review(q,'approve',1)).statusCode,409);
    const pending=(await call('/api/client/financial',{cookie:buyer.cookie})).json();assert.equal(pending.entries.length,0);assert.equal(pending.items[0].status,'approved');
    assert.equal((await call('/api/client/invoices/'+i.id+'/payment',{method:'POST',cookie:buyer.cookie,body:{}})).statusCode,409);
    const key=randomUUID(),both=await Promise.all([f.simulate(q,2,'succeeded',key),f.simulate(q,2,'succeeded',key)]);assert.ok(both.every(r=>r.statusCode===200),both.map(r=>r.body).join('\n'));
    assert.equal((await f.simulate(q,2,'failed',key)).statusCode,409);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM financial_entries WHERE request_id=$1',[q.id])).rows[0].n,1);
    const invoice=(await db.query('SELECT * FROM service_invoices WHERE id=$1',[i.id])).rows[0];assert.equal(Number(invoice.total_minor),10000);assert.deepEqual(invoice.snapshot,i.snapshot);
    const finances=await invoiceFinance(db,invoice);assert.equal(finances.due_minor,8500);
    const customerInvoice=(await call('/api/client/invoices',{cookie:buyer.cookie})).json().items.find(x=>x.id===i.id);assert.equal(customerInvoice.total_minor,8500);assert.equal(customerInvoice.original_total_minor,10000);
    assert.equal((await call('/api/client/financial',{cookie:other.cookie})).json().items.length,0);
    await db.query('UPDATE crm_leads SET owner_id=$2 WHERE id=$1',[i.lead,admin.user.id]);assert.ok(!(await call('/api/commercial/financial',{cookie:seller.cookie})).json().items.some(x=>x.id===q.id));
    await f.pay(i);const payment=(await db.query("SELECT amount_minor FROM service_invoice_payments WHERE invoice_id=$1 AND status='paid'",[i.id])).rows[0];assert.equal(Number(payment.amount_minor),8500);
    const sale=(await db.query('SELECT amount_minor FROM commercial_sales WHERE reference=$1',[i.number])).rows[0];assert.equal(Number(sale.amount_minor),8500);
    const receipt=(await db.query('SELECT * FROM commercial_mail WHERE dedupe=$1',['invoice:'+i.id+':paid:customer'])).rows[0];assert.equal(receipt.recipient,buyer.profile.email);assert.equal(receipt.attachments[0].record.finance.credits_minor,1500);assert.equal(Number(receipt.attachments[0].record.total_minor),8500);
    assert.equal((await call('/api/client/financial/requests',{method:'POST',cookie:buyer.cookie,body:{invoice_id:i.id,kind:'refund',amount_minor:8501,reason:'Cannot exceed actual payment',idempotency_key:randomUUID()}})).statusCode,409);
  });
  await t.test('an open checkout blocks credit approval; pending requests may be withdrawn or declined',async()=>{
    const i=await f.invoice(),q=await f.request(i);
    assert.equal((await call('/api/client/invoices/'+i.id+'/payment',{method:'POST',cookie:buyer.cookie,body:{}})).statusCode,200);
    assert.equal((await f.review(q)).statusCode,409);
    assert.equal((await call('/api/client/financial/requests/'+q.id+'/withdraw',{method:'POST',cookie:other.cookie,body:{revision:1}})).statusCode,404);
    assert.equal((await call('/api/client/financial/requests/'+q.id+'/withdraw',{method:'POST',cookie:buyer.cookie,body:{revision:1}})).statusCode,200);
    const q2=await f.request(await f.invoice());assert.equal((await f.review(q2,'decline')).statusCode,200);assert.equal((await f.simulate(q2)).statusCode,409);
  });
  await t.test('refunds never exceed actual payment after credits; reservations, failure, cancellation and immutable receipt',async()=>{
    const i=await f.invoice();await f.pay(i);
    const saved=(await db.query('SELECT attachments FROM commercial_mail WHERE dedupe=$1',['invoice:'+i.id+':paid:customer'])).rows[0].attachments;
    const q=await f.request(i,'refund',6000),q2=await f.request(i,'refund',6000);
    assert.equal((await f.review(q)).statusCode,200);assert.equal((await f.review(q2)).statusCode,409);
    const failed=await f.simulate(q,2,'failed');assert.equal(failed.statusCode,200,failed.body);assert.equal((await db.query('SELECT count(*)::integer AS n FROM financial_entries WHERE invoice_id=$1',[i.id])).rows[0].n,0);
    assert.equal((await f.simulate(q,3)).statusCode,200);
    const current=(await call('/api/client/financial',{cookie:buyer.cookie})).json().invoices.find(x=>x.id===i.id);assert.equal(current.finance.refunds_minor,6000);assert.equal(current.finance.net_received_minor,4000);
    const receipt=(await db.query('SELECT attachments FROM commercial_mail WHERE dedupe=$1',['invoice:'+i.id+':paid:customer'])).rows[0].attachments;assert.deepEqual(receipt,saved);
    const confirmation=(await db.query("SELECT * FROM commercial_mail WHERE dedupe LIKE $1",['financial:'+q.id+':completed:%:customer'])).rows[0];assert.equal(confirmation.recipient,buyer.profile.email);assert.ok(confirmation.body.includes('No real money has been returned'));assert.equal(confirmation.attachments[0].record.finance.refunds_minor,6000);
    assert.equal((await f.review(q2,'approve',1,4000)).statusCode,200);assert.equal((await f.review(q2,'cancel',2)).statusCode,200);assert.equal((await f.simulate(q2,3)).statusCode,409);
    const remainder=await f.request(i,'refund',4000);assert.equal((await f.review(remainder)).statusCode,200);assert.equal((await f.simulate(remainder)).statusCode,200);
    assert.equal((await call('/api/client/financial/requests',{method:'POST',cookie:buyer.cookie,body:{...q.body,idempotency_key:randomUUID(),amount_minor:1}})).statusCode,409);
    const raw=(await db.query('SELECT status,total_minor FROM service_invoices WHERE id=$1',[i.id])).rows[0];assert.equal(raw.status,'paid');assert.equal(Number(raw.total_minor),10000);
  });
  await t.test('full credit closes unpaid balance without deleting documents or generating a payment',async()=>{
    const i=await f.invoice(),q=await f.request(i,'credit',10000);assert.equal((await f.review(q)).statusCode,200);assert.equal((await f.simulate(q)).statusCode,200);
    assert.equal((await call('/api/client/invoices/'+i.id+'/payment',{method:'POST',cookie:buyer.cookie,body:{}})).statusCode,409);
    const raw=(await db.query('SELECT * FROM service_invoices WHERE id=$1',[i.id])).rows[0];assert.equal(raw.status,'cancelled');assert.equal(Number(raw.total_minor),10000);assert.deepEqual(raw.snapshot,i.snapshot);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM service_invoice_payments WHERE invoice_id=$1',[i.id])).rows[0].n,0);
    const print=await call('/api/client/invoices/'+i.id+'/print',{cookie:buyer.cookie});assert.equal(print.statusCode,200);assert.ok(print.body.includes('Financial history'));
  });
  await t.test('evidence tampering is rejected; modules served without external refund calls',async()=>{
    const q=await f.request(await f.invoice());await db.query("UPDATE financial_requests SET evidence=evidence||'{\"currency\":\"USD\"}'::jsonb WHERE id=$1",[q.id]);assert.equal((await f.review(q)).statusCode,409);
    const r=await call('/financial-workspace.js');assert.equal(r.statusCode,200);assert.ok(r.body.includes('Ajustes y reembolsos'));assert.ok(!r.body.includes('api.stripe.com'));
  });
  await t.test('approved credits pause payment reminders; completed credits use the exact remaining balance',async()=>{
    const i=await f.invoice(),q=await f.request(i,'credit',2500);await db.query('UPDATE service_invoices SET due_date=$2::date-1 WHERE id=$1',[i.id,serviceToday()]);assert.equal((await f.review(q)).statusCode,200);
    await call('/api/commercial/operations/settings',{method:'PUT',cookie:admin.cookie,body:{visit_reminders:false,invoice_reminders:true}});
    await processServiceOperations(db,{},'http://127.0.0.1:3030');assert.equal((await db.query('SELECT count(*)::integer AS n FROM commercial_mail WHERE dedupe LIKE $1',['invoice-reminder:'+i.id+':%'])).rows[0].n,0);
    assert.equal((await f.simulate(q)).statusCode,200);await processServiceOperations(db,{},'http://127.0.0.1:3030');
    const m=(await db.query('SELECT body FROM commercial_mail WHERE dedupe LIKE $1',['invoice-reminder:'+i.id+':%'])).rows[0];assert.ok(m.body.includes('75.00 CAD'),m.body);
  });
});
test('external provider execution cannot be mistaken for a completed refund',async t=>{
  let calls=0;const f=await fixture(t,{serviceGateway:{provider:'stripe',create:async()=>{calls++;throw Error('Unexpected external payment');}}}),i=await f.invoice(),q=await f.request(i);
  assert.equal((await f.review(q)).statusCode,200);assert.equal((await f.simulate(q)).statusCode,409);assert.equal(calls,0);
  assert.equal((await f.call('/api/commercial/financial',{cookie:f.admin.cookie})).json().external_refund_enabled,false);
});
