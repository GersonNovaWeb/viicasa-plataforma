import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {moduleFixture} from './module-fixture.mjs';
import {commissionBalance} from '../commission-core.mjs';
const resolve=(f,q,amount)=>f.post('/api/commercial/commission-review/'+q.id+'/resolve',{revision:1,decision:amount?'reduce':'retain',reduction_minor:amount,note:'Original isolated decision'});
const correction=(amount,revision=0)=>({request_id:randomUUID(),correction_revision:revision,reduction_minor:amount,note:'Authorised isolated correction',acknowledged:true});
const correct=(f,q,body,cookie=f.admin.cookie)=>f.post('/api/commercial/commission-review/'+q.id+'/correct',body,cookie);
const recover=(f,q,amount,key=randomUUID())=>f.post('/api/commercial/commission-review/'+q.id+'/recovery',{idempotency_key:key,amount_minor:amount,note:'Fictitious recovery'});
const supplement=(f,q,amount,key=randomUUID())=>f.post('/api/commercial/commission-review/'+q.id+'/supplement',{request_id:key,amount_minor:amount,note:'Fictitious supplement',demo_acknowledged:true});
test('unpaid correction is append-only, scoped, bounded and freezes a per-review payout baseline',async t=>{
  const f=await moduleFixture(t),sale=await f.commissionSale();assert.equal((await resolve(f,sale.q,200)).statusCode,200);const original=(await f.db.query('SELECT * FROM commission_reviews WHERE id=$1',[sale.q.id])).rows[0],body=correction(100);
  assert.equal((await correct(f,sale.q,body,f.seller.cookie)).statusCode,403);assert.equal((await correct(f,sale.q,correction(501))).statusCode,409);
  const path='/api/commercial/commission-review/'+sale.q.id+'/correct';assert.equal((await f.call(path,{method:'POST',body,cookie:f.admin.cookie,origin:'https://outside.invalid'})).statusCode,403);
  assert.equal((await correct(f,sale.q,body)).statusCode,200);assert.equal((await correct(f,sale.q,body)).json().duplicate,true);assert.equal((await correct(f,sale.q,correction(0))).statusCode,409);
  assert.deepEqual((await f.db.query('SELECT * FROM commission_reviews WHERE id=$1',[sale.q.id])).rows[0],original);assert.equal((await commissionBalance(f.db,sale.id)).effective_commission_minor,400);
  for(const status of ['approved','paid'])assert.equal((await f.post('/api/commercial/sales/'+sale.id+'/commission',{status})).statusCode,200);
  assert.equal((await correct(f,sale.q,correction(0,1))).statusCode,200);let b=await commissionBalance(f.db,sale.id);assert.equal(b.commission_paid_minor,400);assert.equal(b.supplement_due_minor,100);
  assert.equal((await supplement(f,sale.q,101)).statusCode,409);assert.equal((await supplement(f,sale.q,100)).statusCode,200);b=await commissionBalance(f.db,sale.id);assert.equal(b.supplement_due_minor,0);assert.equal(b.commission_paid_minor,400);
  assert.equal((await correct(f,sale.q,correction(200,2))).statusCode,200);assert.equal((await commissionBalance(f.db,sale.id)).recovery_due_minor,200);
});
test('paid corrections preserve recoveries, restore via separate supplement and are idempotent under concurrency',async t=>{
  const f=await moduleFixture(t),sale=await f.commissionSale({paid:true});await resolve(f,sale.q,200);assert.equal((await recover(f,sale.q,100)).statusCode,200);
  const body=correction(0),results=await Promise.all([correct(f,sale.q,body),correct(f,sale.q,body)]);assert.ok(results.every(r=>r.statusCode===200),results.map(r=>r.body).join('\n'));
  let b=await commissionBalance(f.db,sale.id);assert.equal(b.effective_commission_minor,500);assert.equal(b.recovery_due_minor,0);assert.equal(b.supplement_due_minor,100);assert.equal((await recover(f,sale.q,1)).statusCode,409);
  const key=randomUUID();assert.equal((await supplement(f,sale.q,100,key)).statusCode,200);assert.equal((await supplement(f,sale.q,100,key)).json().duplicate,true);
  assert.equal((await correct(f,sale.q,correction(300,1))).statusCode,200);b=await commissionBalance(f.db,sale.id);assert.equal(b.recovery_due_minor,300);assert.equal(b.commission_paid_minor,500);assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM commission_recoveries WHERE review_id=$1',[sale.q.id])).rows[0].n,1);
  const h=(await f.call('/api/commercial/commission-review/'+sale.q.id+'/corrections',{cookie:f.seller.cookie})).json();assert.equal(h.items.length,2);assert.equal(h.original.reduction_minor,200);assert.equal(h.supplements.length,1);
  await f.db.query("UPDATE commission_corrections SET evidence=evidence||'{\"reduction_minor\":1}'::jsonb WHERE id=$1",[body.request_id]);await assert.rejects(commissionBalance(f.db,sale.id),/investigation/);assert.equal((await correct(f,sale.q,correction(0,2))).statusCode,409);
});
test('pending refunds block corrections; combined reductions cannot exceed the original commission',async t=>{
  const f=await moduleFixture(t),sale=await f.commissionSale();await resolve(f,sale.q,200);const second=await f.refund(sale.invoice);
  assert.equal((await correct(f,sale.q,correction(0))).statusCode,409);assert.equal((await resolve(f,second,300)).statusCode,200);
  assert.equal((await correct(f,sale.q,correction(201))).statusCode,409);assert.equal((await correct(f,sale.q,correction(0))).statusCode,200);assert.equal((await commissionBalance(f.db,sale.id)).effective_commission_minor,200);
  assert.equal((await f.call('/commission-correction-workspace.js')).statusCode,200);
});
