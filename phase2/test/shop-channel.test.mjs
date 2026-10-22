import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openPhase2Databases} from '../database.mjs';
import {seedPhase2,demoCredentials} from '../bootstrap.mjs';
import {buildPhase2App} from '../app.mjs';
import {secretVault,totp} from '../security.mjs';
import {ingestChannelEvent,expireChannelCheckouts} from '../shop-channel.mjs';
import {deliverCommercialMail} from '../mail.mjs';
const origin='http://127.0.0.1:3030';
async function fixture(t){
  const dbs=await openPhase2Databases('',{memory:true});t.after(()=>dbs.close());await seedPhase2(dbs);const app=await buildPhase2App(dbs,secretVault(Buffer.alloc(32,3)),{testing:true});t.after(()=>app.close());
  const call=(path,{method='GET',cookie,body}={})=>app.inject({url:path,method,headers:{origin,...(cookie?{cookie}:{})},payload:body});
  const login=async account=>{const challenge=(await call('/api/commercial/login',{method:'POST',body:account})).json();const r=await call('/api/commercial/verify',{method:'POST',body:{challenge:challenge.challenge,code:totp(challenge.secret)}});assert.equal(r.statusCode,200,r.body);return r.headers['set-cookie'].split(';')[0];};
  const admin=await login(demoCredentials.admin),seller=await login(demoCredentials.seller);
  const customer=async email=>{const a=await call('/api/client/register',{method:'POST',body:{email,name:'Demo Buyer',password:'Customer-Demo-2026!'}});const mail=(await dbs.commercial.query("SELECT body FROM commercial_mail WHERE recipient=$1 AND subject LIKE '%Verify your email%' ORDER BY created_at DESC LIMIT 1",[email])).rows[0],r=await call('/api/client/verify',{method:'POST',body:{challenge:a.json().challenge,code:mail.body.match(/code is (\d{6})/)[1]}});assert.equal(r.statusCode,200,r.body);return r.headers['set-cookie'].split(';')[0];};
  return{...dbs,app,call,admin,seller,customer};
}
test('channel catalogue snapshots preserve stock; events are idempotent, stale or conflicting and never alter original products',async t=>{
  const f=await fixture(t),{call,admin,commercial:db,store}=f,original=await store.list('products',{limit:100});
  assert.equal((await call('/api/commercial/shop-channel/examples',{method:'POST',cookie:admin,body:{confirm:true}})).json().created,2);
  const catalogue=(await call('/api/shop-channel/catalogue')).json().items,p=catalogue[0],v=p.variants[0];assert.equal(v.stock,8);
  const event={event_id:randomUUID(),kind:'product',payload:{external_id:p.external_id,slug:p.slug,name:p.name+' edited',description:p.description,category:p.category,images:p.images,published:true,source_revision:2,variants:p.variants.map(v=>({external_id:v.external_id,sku:v.sku,name:v.name,price_minor:v.price_minor,currency:'CAD',active:true}))}};
  const first=await ingestChannelEvent(db,event);assert.ok(first.applied);assert.equal((await ingestChannelEvent(db,event)).duplicate,true);
  await assert.rejects(ingestChannelEvent(db,{...event,payload:{...event.payload,name:'Another name'}}),/reused/);
  assert.equal((await ingestChannelEvent(db,{...event,event_id:randomUUID(),payload:{...event.payload,source_revision:1}})).reason,'stale_product');
  assert.equal((await call('/api/shop-channel/products/'+p.slug)).json().variants[0].stock,8);
  await call('/api/commercial/shop-channel/products/'+p.id+'/visibility',{method:'POST',cookie:admin,body:{published:false,archived:true}});
  assert.equal((await call('/api/shop-channel/products/'+p.slug)).statusCode,404);
  assert.equal((await call('/api/commercial/shop-channel/examples',{method:'POST',cookie:admin,body:{confirm:true}})).json().created,0);
  assert.deepEqual(await store.list('products',{limit:100}),original);
});
test('channel stock holds use server prices, enforce identity, release on cancel/expiry and settle once without real delivery',async t=>{
  const f=await fixture(t),{call,admin,commercial:db}=f;await call('/api/commercial/shop-channel/examples',{method:'POST',cookie:admin,body:{confirm:true}});
  const p=(await call('/api/shop-channel/catalogue')).json().items[0],v=p.variants[0],buyer=await f.customer('buyer@example.invalid'),other=await f.customer('other@example.invalid');
  const body={idempotency_key:randomUUID(),consent:true,lines:[{variant_id:v.id,quantity:6}]},path='/api/client/shop-channel/checkouts';
  assert.equal((await call(path,{method:'POST',body})).statusCode,401);assert.equal((await call('/api/commercial/shop-channel/catalogue',{cookie:f.seller})).statusCode,403);
  const created=await call(path,{method:'POST',cookie:buyer,body});assert.equal(created.statusCode,200,created.body);const id=created.json().id;assert.equal(created.json().total_minor,v.price_minor*6);
  assert.equal((await call(path,{method:'POST',cookie:buyer,body})).json().id,id);
  assert.equal((await call(path,{method:'POST',cookie:other,body:{...body,idempotency_key:randomUUID(),lines:[{variant_id:v.id,quantity:3}]}})).statusCode,409);
  assert.equal((await call(path+'/'+id+'/cancel',{method:'POST',cookie:other,body:{}})).statusCode,404);
  for(let i=0;i<2;i++){const r=await call('/api/commercial/shop-channel/checkouts/'+id+'/simulate-paid',{method:'POST',cookie:admin,body:{}});assert.equal(r.statusCode,200,r.body);}
  assert.equal((await call('/api/shop-channel/products/'+p.slug)).json().variants[0].available,2);
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM channel_orders')).rows[0].n,1);
  const order=(await call('/api/client/shop-channel/orders',{cookie:buyer})).json().items[0];assert.equal(order.customer_email,'buyer@example.invalid');assert.equal((await call('/api/client/shop-channel/orders',{cookie:other})).json().items.length,0);
  const pending=await call(path,{method:'POST',cookie:buyer,body:{...body,idempotency_key:randomUUID(),lines:[{variant_id:v.id,quantity:2}]}});assert.equal(pending.statusCode,200,pending.body);
  await call(path+'/'+pending.json().id+'/cancel',{method:'POST',cookie:buyer,body:{}});assert.equal((await call('/api/shop-channel/products/'+p.slug)).json().variants[0].available,2);
  const expiring=await call(path,{method:'POST',cookie:buyer,body:{...body,idempotency_key:randomUUID(),lines:[{variant_id:v.id,quantity:2}]}});await db.query("UPDATE channel_checkouts SET expires_at=now()-interval '1 minute' WHERE id=$1",[expiring.json().id]);await expireChannelCheckouts(db);assert.equal((await call('/api/shop-channel/products/'+p.slug)).json().variants[0].available,2);
  // All other transactional messages belong to unrelated customer verification;
  // isolate channel messages before proving the transport exclusion.
  await db.query("UPDATE commercial_mail SET status='sent' WHERE delivery_scope='standard'");
  assert.equal((await deliverCommercialMail(db,{mailMode:'smtp'},{sendMail:()=>assert.fail('Channel demo must not send mail')})).sent,0);
});
test('imported paid orders do not deduct Shopify inventory twice; fulfillment and immutable totals are checked',async t=>{
  const f=await fixture(t),{call,admin,commercial:db}=f;await call('/api/commercial/shop-channel/examples',{method:'POST',cookie:admin,body:{confirm:true}});
  const p=(await call('/api/shop-channel/catalogue')).json().items[0],v=p.variants[0];const event={event_id:randomUUID(),kind:'order',payload:{external_id:'sample-external-order',source_revision:1,customer_email:'external@example.invalid',currency:'CAD',total_minor:v.price_minor,status:'paid',fulfillment:'unfulfilled',lines:[{external_variant_id:v.external_id,name:'Sample item',quantity:1,unit_minor:v.price_minor}]}};
  assert.ok((await ingestChannelEvent(db,event)).applied);assert.equal((await call('/api/shop-channel/products/'+p.slug)).json().variants[0].stock,8);
  assert.ok((await ingestChannelEvent(db,{...event,event_id:randomUUID(),payload:{...event.payload,source_revision:2,fulfillment:'fulfilled'}})).applied);
  const regression=await ingestChannelEvent(db,{...event,event_id:randomUUID(),payload:{...event.payload,source_revision:3}});assert.equal(regression.reason,'order_state_regression');
  const changed=await ingestChannelEvent(db,{...event,event_id:randomUUID(),payload:{...event.payload,source_revision:3,total_minor:v.price_minor+1,lines:[{...event.payload.lines[0],unit_minor:v.price_minor+1}]}});assert.equal(changed.reason,'immutable_order_changed');
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM commercial_mail WHERE dedupe LIKE 'channel-order:%' AND delivery_scope='preview'")).rows[0].n,1);
});
