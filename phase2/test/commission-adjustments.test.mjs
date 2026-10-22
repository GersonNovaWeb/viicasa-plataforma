// Prepared for the final verification pass. No live providers or persistent data.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openPhase2Databases} from '../database.mjs';
import {seedPhase2,demoCredentials} from '../bootstrap.mjs';
import {buildPhase2App} from '../app.mjs';
import {secretVault,totp} from '../security.mjs';
import {commissionLock,queueCommissionReviews,commissionBalance} from '../commission-core.mjs';
import {reconcileCommissionReviews} from '../commission-adjustments.mjs';

async function fixture(t){
  const dbs=await openPhase2Databases('',{memory:true});t.after(()=>dbs.close());await seedPhase2(dbs);
  const db=dbs.commercial,app=await buildPhase2App(dbs,secretVault(Buffer.alloc(32,21)),{testing:true});t.after(()=>app.close());
  const call=(url,body,cookie,origin='http://127.0.0.1:3030')=>app.inject({url,method:body?'POST':'GET',headers:{origin,...(cookie?{cookie}:{})},payload:body});
  const login=async credentials=>{const c=(await call('/api/commercial/login',credentials)).json(),r=await call('/api/commercial/verify',{challenge:c.challenge,code:totp(c.secret)});assert.equal(r.statusCode,200,r.body);return{cookie:r.headers['set-cookie'].split(';')[0],user:r.json().user};};
  const admin=await login(demoCredentials.admin),seller=await login(demoCredentials.seller);
  await db.query('UPDATE commission_rules SET approved=true');
  const refund=async record=>{
    const request=randomUUID(),entry=randomUUID();
    await db.query("INSERT INTO financial_requests(id,invoice_id,requester_id,requester_kind,kind,amount_minor,reason,status,approved_minor,evidence,evidence_hash,idempotency_key) VALUES($1,$2,$3,'team','refund',4000,'Fictional refund fixture','completed',4000,'{}',$4,$5)",[request,record.invoice,admin.user.id,'0'.repeat(64),randomUUID()]);
    await db.query("INSERT INTO financial_entries(id,request_id,invoice_id,kind,amount_minor,reference) VALUES($1,$2,$3,'refund',4000,$4)",[entry,request,record.invoice,'commission-refund:'+entry]);
    await db.transaction(async tx=>{await commissionLock(tx);await queueCommissionReviews(tx);});
    const q=(await db.query('SELECT * FROM commission_reviews WHERE refund_entry_id=$1',[entry])).rows[0];return q;
  };
  const sale=async({paid=false,legacy=false}={})=>{
    const lead=randomUUID(),quote=randomUUID(),contract=randomUUID(),invoice=randomUUID(),id=randomUUID(),number='COMMISSION-'+invoice;
    await db.query("INSERT INTO crm_leads(id,owner_id,name,email,service,stage,priority,source) VALUES($1,$2,'Fictional Client','fixture@example.invalid','home','won','normal','Deferred check')",[lead,seller.user.id]);
    await db.query("INSERT INTO service_quotes(id,lead_id,actor_id,selection,result,status) VALUES($1,$2,$3,'{}','{}','approved')",[quote,lead,seller.user.id]);
    await db.query("INSERT INTO service_contracts(id,quote_id,lead_id,seller_id,customer_email,status,snapshot,snapshot_hash) VALUES($1,$2,$3,$4,'fixture@example.invalid','accepted','{}',$5)",[contract,quote,lead,seller.user.id,'0'.repeat(64)]);
    await db.query("INSERT INTO service_invoices(id,contract_id,number,customer_email,total_minor,period,snapshot,due_date,status) VALUES($1,$2,$3,'fixture@example.invalid',10000,'2026-10','{}',now()::date,'paid')",[invoice,contract,number]);
    await db.query("INSERT INTO service_invoice_payments(id,invoice_id,provider,status,amount_minor,currency,reference,expires_at) VALUES($1,$2,'demo','paid',10000,'CAD',$3,now())",[randomUUID(),invoice,'commission-payment:'+invoice]);
    await db.query("INSERT INTO team_audit(id,action,resource) VALUES($1,'invoice.paid',$2)",[randomUUID(),invoice]);
    await db.query("INSERT INTO commercial_sales(id,lead_id,seller_id,reference,amount_minor,currency,status,basis_points,commission_minor,commission_status,service_invoice_id,commission_paid_minor) VALUES($1,$2,$3,$4,10000,'CAD','paid',500,500,$5,$6,$7)",[id,lead,seller.user.id,number,paid?'paid':'pending',legacy?null:invoice,paid?500:null]);
    const record={id,invoice,lead,number},q=await refund(record);return{...record,q};
  };
  const resolve=(q,decision='retain',amount=0,who=admin)=>call('/api/commercial/commission-review/'+q.id+'/resolve',{revision:1,decision,reduction_minor:amount,note:'Authorised demo decision'},who.cookie);
  const recover=(q,amount,key=randomUUID())=>call('/api/commercial/commission-review/'+q.id+'/recovery',{idempotency_key:key,amount_minor:amount,note:'Fictitious recovery only'},admin.cookie);
  return{db,app,call,admin,seller,sale,refund,resolve,recover};
}

test('commission review preserves originals, blocks payout during review and enforces role/origin',async t=>{
  const f=await fixture(t),v=await f.sale();
  assert.equal((await f.call('/api/commercial/commission-review')).statusCode,401);
  assert.equal((await f.resolve(v.q,'reduce',100,f.seller)).statusCode,403);
  const body={revision:1,decision:'reduce',reduction_minor:100,note:'Authorised demo decision'};
  assert.equal((await f.call('/api/commercial/commission-review/'+v.q.id+'/resolve',body,f.admin.cookie,'https://outside.invalid')).statusCode,403);
  assert.equal((await f.call('/api/commercial/sales/'+v.id+'/commission',{status:'approved'},f.admin.cookie)).statusCode,409);
  assert.equal((await f.resolve(v.q,'reduce',501)).statusCode,409);
  assert.equal((await f.resolve(v.q,'reduce',100)).statusCode,200);
  assert.equal((await f.resolve(v.q,'reduce',100)).json().duplicate,true);
  assert.equal((await f.resolve(v.q,'retain',0)).statusCode,409);
  let b=await commissionBalance(f.db,v.id);assert.equal(b.commission_minor,500);assert.equal(b.effective_commission_minor,400);assert.equal(b.commission_review_required,false);
  assert.equal((await f.call('/api/commercial/sales/'+v.id+'/commission',{status:'approved'},f.admin.cookie)).statusCode,200);
  assert.equal((await f.call('/api/commercial/sales/'+v.id+'/commission',{status:'paid'},f.admin.cookie)).statusCode,200);
  b=await commissionBalance(f.db,v.id);assert.equal(b.commission_paid_minor,400);assert.equal(b.commission_minor,500);
  await f.db.query('UPDATE crm_leads SET owner_id=$2 WHERE id=$1',[v.lead,f.admin.user.id]);
  assert.ok((await f.call('/api/commercial/commission-review',null,f.seller.cookie)).json().items.some(q=>q.id===v.q.id));
});

test('paid commission reductions keep payout intact and support bounded idempotent demo recovery',async t=>{
  const f=await fixture(t),v=await f.sale({paid:true});
  assert.equal((await f.resolve(v.q,'reduce',200)).json().disposition,'recovery_due');
  let b=await commissionBalance(f.db,v.id);assert.equal(b.commission_paid_minor,500);assert.equal(b.effective_commission_minor,300);assert.equal(b.recovery_due_minor,200);
  const key=randomUUID();assert.equal((await f.recover(v.q,100,key)).statusCode,200);assert.equal((await f.recover(v.q,100,key)).json().duplicate,true);
  assert.equal((await f.recover(v.q,101)).statusCode,409);assert.equal((await f.recover(v.q,99,key)).statusCode,409);
  assert.equal((await f.recover(v.q,100)).statusCode,200);
  b=await commissionBalance(f.db,v.id);assert.equal(b.recovery_due_minor,0);assert.equal(b.commission_status,'paid');assert.equal(b.commission_paid_minor,500);
  const data=(await f.call('/api/commercial/commission-review',null,f.admin.cookie)).json();assert.equal(data.external_transfer_enabled,false);assert.equal(data.recoveries.length,2);
});

test('multiple refunds cannot reduce the same original commission beyond its remaining balance',async t=>{
  const f=await fixture(t),v=await f.sale(),q2=await f.refund(v);
  const results=await Promise.all([f.resolve(v.q,'reduce',300),f.resolve(q2,'reduce',300)]);
  assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);
  const pending=(await f.db.query("SELECT * FROM commission_reviews WHERE sale_id=$1 AND status='pending'",[v.id])).rows[0];
  assert.equal((await f.resolve(pending,'reduce',200)).statusCode,200);
  const b=await commissionBalance(f.db,v.id);assert.equal(b.effective_commission_minor,0);
  assert.equal((await f.call('/api/commercial/sales/'+v.id+'/commission',{status:'approved'},f.admin.cookie)).statusCode,200);
  assert.equal((await f.call('/api/commercial/sales/'+v.id+'/commission',{status:'paid'},f.admin.cookie)).statusCode,409);
  assert.equal((await f.call('/api/commercial/sales/'+v.id+'/commission',{status:'cancelled'},f.admin.cookie)).statusCode,200);
});

test('legacy invoice linking is explicit, audited and does not infer a new commission',async t=>{
  const f=await fixture(t),v=await f.sale({legacy:true});assert.equal(v.q,undefined);
  await reconcileCommissionReviews(f.db);assert.equal((await commissionBalance(f.db,v.id)).service_invoice_id,null);
  assert.equal((await f.call('/api/commercial/sales/'+v.id+'/commission',{status:'approved'},f.admin.cookie)).statusCode,409);
  const data=(await f.call('/api/commercial/commission-review',null,f.admin.cookie)).json();assert.ok(data.unmatched.some(x=>x.invoice_id===v.invoice&&x.candidate_sale_id===v.id));
  const body={invoice_id:v.invoice,sale_id:v.id,note:'Verified legacy invoice/payment reference'};
  assert.equal((await f.call('/api/commercial/commission-review/link',body,f.seller.cookie)).statusCode,403);
  assert.equal((await f.call('/api/commercial/commission-review/link',body,f.admin.cookie)).statusCode,200);
  assert.equal((await f.call('/api/commercial/commission-review/link',body,f.admin.cookie)).json().duplicate,true);
  assert.equal((await commissionBalance(f.db,v.id)).service_invoice_id,v.invoice);
  const q=(await f.db.query('SELECT * FROM commission_reviews WHERE sale_id=$1',[v.id])).rows[0];assert.ok(q);
  assert.equal((await f.resolve(q)).statusCode,200);assert.equal((await f.db.query("SELECT count(*)::integer AS n FROM team_audit WHERE action='commission.invoice_link' AND resource=$1",[v.id])).rows[0].n,1);
});

test('tampered review evidence is rejected and reconciliation does not duplicate reviews or notifications',async t=>{
  const f=await fixture(t),v=await f.sale();
  await reconcileCommissionReviews(f.db);await reconcileCommissionReviews(f.db);
  assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM commission_reviews WHERE sale_id=$1',[v.id])).rows[0].n,1);
  await f.db.query("UPDATE commission_reviews SET evidence=evidence||'{\"refund_minor\":1}'::jsonb WHERE id=$1",[v.q.id]);
  assert.equal((await f.resolve(v.q)).statusCode,409);
  const script=await f.call('/commission-workspace.js');assert.equal(script.statusCode,200);assert.ok(script.body.includes('Revisión de comisiones'));assert.ok(!script.body.includes('api.stripe.com'));
});
