import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {moduleFixture} from './module-fixture.mjs';
import {emptyChannelPricing,priceChannel,orderBreakdown} from '../channel-pricing.mjs';
import {ingestChannelEvent} from '../shop-channel.mjs';
const policy={revision:0,approved:true,shipping_options:[{id:'standard',label:'Fictional shipping',amount_minor:1000}],discounts:[{code:'EXAMPLE',label:'Fictional discount',basis:'percent',value:1000,min_subtotal_minor:0}],taxes:[{id:'sample',label:'Fictional tax',basis_points:500,shipping_taxable:true}],note:'Isolated test values, not production rules'};
test('channel breakdown reconciles exact cents, rejects inconsistent imports and never supplies default tax rates',()=>{
  const lines=[{quantity:2,unit_minor:10001}],p=priceChannel(lines,policy,{shipping_option:'standard',discount_code:'example'});assert.deepEqual(p.breakdown,{subtotal_minor:20002,discount_minor:2000,shipping_minor:1000,tax_minor:950,total_minor:19952,taxes:[{id:'sample',label:'Fictional tax',amount_minor:950}]});
  assert.equal(priceChannel(lines,emptyChannelPricing()).breakdown.total_minor,20002);assert.throws(()=>priceChannel(lines,policy,{shipping_option:'missing'}));assert.throws(()=>orderBreakdown(lines,{...p.breakdown,tax_minor:949},19952));
  assert.throws(()=>priceChannel(lines,{...policy,discounts:[{...policy.discounts[0],basis:'fixed',value:999999}]},{shipping_option:'',discount_code:'EXAMPLE'}));
});
test('channel pricing is admin-only; quotes do not hold stock and accepted checkouts retain approved breakdowns',async t=>{
  const f=await moduleFixture(t),url='/api/commercial/shop-channel/pricing',put=(body,cookie=f.admin.cookie)=>f.call(url,{method:'PUT',cookie,body});
  assert.equal((await put(policy,f.seller.cookie)).statusCode,403);assert.equal((await put({...policy,taxes:null})).statusCode,409);assert.equal((await put(policy)).statusCode,200);assert.equal((await put(policy)).statusCode,409);
  const publicPolicy=(await f.call('/api/shop-channel/pricing')).json();assert.equal(publicPolicy.discounts,undefined);
  await f.post('/api/commercial/shop-channel/examples',{confirm:true});const v=(await f.call('/api/shop-channel/catalogue')).json().items[0].variants[0],buyer=await f.customer(),other=await f.customer('other-module@example.invalid');
  // Public price review is intentional: guest checkout must not require login.
  const input={lines:[{variant_id:v.id,quantity:2}],shipping_option:'standard',discount_code:'EXAMPLE',pricing_revision:1};assert.equal((await f.post('/api/client/shop-channel/quote',input,null)).statusCode,200);
  const preview=await f.post('/api/client/shop-channel/quote',input,buyer);assert.equal(preview.statusCode,200,preview.body);assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM channel_holds')).rows[0].n,0);
  const body={...input,idempotency_key:randomUUID(),consent:true,expected_total_minor:preview.json().breakdown.total_minor},created=await f.post('/api/client/shop-channel/checkouts',body,buyer);assert.equal(created.statusCode,200,created.body);const id=created.json().id,frozen=(await f.db.query('SELECT snapshot FROM channel_checkouts WHERE id=$1',[id])).rows[0].snapshot;
  assert.equal((await put({...policy,revision:1,shipping_options:[{...policy.shipping_options[0],amount_minor:2000}]})).statusCode,200);
  assert.equal((await f.post('/api/client/shop-channel/checkouts',body,buyer)).json().id,id);assert.equal((await f.post('/api/client/shop-channel/checkouts',{...body,idempotency_key:randomUUID()},buyer)).statusCode,409);
  assert.equal((await f.post('/api/commercial/shop-channel/checkouts/'+id+'/simulate-paid',{})).statusCode,200);
  const order=(await f.call('/api/client/shop-channel/orders',{cookie:buyer})).json().items[0];assert.deepEqual(order.snapshot.breakdown,frozen.breakdown);assert.equal((await f.call('/api/client/shop-channel/orders',{cookie:other})).json().items.length,0);
  const changed={...order.snapshot,source_revision:2,breakdown:{...order.snapshot.breakdown,discount_minor:order.snapshot.breakdown.discount_minor+1,shipping_minor:order.snapshot.breakdown.shipping_minor+1}};
  assert.equal((await ingestChannelEvent(f.db,{event_id:randomUUID(),kind:'order',payload:changed})).reason,'immutable_order_changed');
  assert.equal((await f.call('/channel-cart.js')).statusCode,200);assert.equal((await f.call('/channel-breakdown.js')).statusCode,200);
});
