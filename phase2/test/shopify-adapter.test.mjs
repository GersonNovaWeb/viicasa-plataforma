import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {shopifyGateway} from '../shopify-gateway.mjs';
import {moduleFixture} from './module-fixture.mjs';
const env={PHASE2_SHOPIFY_ENABLED:'true',PHASE2_SHOPIFY_STORE:'fixture.myshopify.com',PHASE2_SHOPIFY_ACCESS_TOKEN:'private-fixture',PHASE2_SHOPIFY_WEBHOOK_SECRET:'fictional-secret',PHASE2_SHOPIFY_LOCATION_ID:'gid://shopify/Location/10',PHASE2_SHOPIFY_STOREFRONT_TOKEN:'fixture-public',PHASE2_SHOPIFY_CHECKOUT_APPROVED:'true'};
const product={id:'gid://shopify/Product/1',handle:'fixture',title:'Fictional Shopify product',description:'Fixture only',productType:'Decor',status:'ACTIVE',onlineStoreUrl:'https://fixture.myshopify.com/products/fixture',updatedAt:'2026-10-12T12:00:00Z',images:{nodes:[]},variants:{nodes:[{id:'gid://shopify/ProductVariant/2',sku:'MERCHANT-FIXTURE',title:'Natural',price:'79.99',inventoryPolicy:'DENY',inventoryItem:{tracked:true,inventoryLevel:{updatedAt:'2026-10-12T12:00:00Z',quantities:[{name:'available',quantity:8}]}}}],pageInfo:{hasNextPage:false,endCursor:null}}};
const bag=amount=>({shopMoney:{amount,currencyCode:'CAD'}});
const order={id:'gid://shopify/Order/3',email:'shopify-buyer@example.invalid',test:true,updatedAt:'2026-10-12T12:00:00Z',cancelledAt:null,displayFinancialStatus:'PAID',displayFulfillmentStatus:'UNFULFILLED',taxesIncluded:false,totalPriceSet:bag('84.24'),totalTaxSet:bag('4.01'),totalShippingPriceSet:bag('10.00'),totalDiscountsSet:bag('9.76'),taxLines:[{title:'Fixture tax',priceSet:bag('4.01')}],lineItems:{nodes:[{id:'gid://shopify/LineItem/4',name:'Fixture product',quantity:1,variant:{id:'gid://shopify/ProductVariant/2'},originalUnitPriceSet:bag('79.99')}],pageInfo:{hasNextPage:false}}};
function mockTransport(){const calls=[],state={product:structuredClone(product),order:structuredClone(order)};
  const fetcher=async(url,options)=>{const body=JSON.parse(options.body),query=body.query;calls.push({url,query,variables:body.variables,headers:options.headers});let data;
    if(query.includes('cartCreate'))data={cartCreate:{cart:{id:'gid://shopify/Cart/fixture?key=private',checkoutUrl:'https://fixture.myshopify.com/checkouts/fixture',cost:{totalAmount:{amount:'79.99',currencyCode:'CAD'}}},userErrors:[]}};
    else if(query.includes('products(first:50'))data={shop:{currencyCode:'CAD'},products:{nodes:[{id:product.id}],pageInfo:{hasNextPage:false,endCursor:null}}};
    else if(query.includes('orders(first:50'))data={orders:{nodes:[{id:order.id}],pageInfo:{hasNextPage:false,endCursor:null}}};else if(query.includes('order(id:'))data={order:state.order};else data={shop:{currencyCode:'CAD'},product:state.product};return new Response(JSON.stringify({data}),{status:200});};return{fetcher,calls,state};
}
const headers=(raw,topic='products/update',id=randomUUID())=>({'content-type':'application/json','x-shopify-topic':topic,'x-shopify-webhook-id':id,'x-shopify-shop-domain':env.PHASE2_SHOPIFY_STORE,'x-shopify-hmac-sha256':createHmac('sha256',env.PHASE2_SHOPIFY_WEBHOOK_SECRET).update(raw).digest('base64')});
test('Shopify gateway verifies raw HMAC/shop/topic, pins HTTPS endpoints and normalises exact CAD money including tax-inclusive totals',async()=>{
  const m=mockTransport(),g=shopifyGateway(env,{fetcher:m.fetcher}),raw=Buffer.from('{"id":1}');assert.equal(g.verify(raw,headers(raw)).resource,product.id);assert.throws(()=>g.verify(Buffer.from('{"id":2}'),headers(raw)));assert.throws(()=>g.verify(raw,{...headers(raw),'x-shopify-shop-domain':'foreign.myshopify.com'}));
  const p=await g.product(product.id);assert.equal(p.payload.variants[0].price_minor,7999);assert.equal(p.inventory[0].quantity,8);assert.equal(p.payload.variants[0].sku,'SHOPIFY-2');
  let o=await g.order(order.id);assert.equal(o.payload.total_minor,8424);assert.equal(o.payload.breakdown.discount_minor,976);
  m.state.order.taxesIncluded=true;m.state.order.totalPriceSet=bag('79.23');o=await g.order(order.id);assert.equal(o.payload.breakdown.taxes_included,true);assert.equal(o.payload.total_minor,7923);
  assert.ok(m.calls.every(c=>c.url.startsWith('https://fixture.myshopify.com/admin/api/2026-10/')));assert.throws(()=>shopifyGateway({...env,PHASE2_SHOPIFY_STORE:'fixture.myshopify.com.evil.invalid'}));
});
test('Shopify signed queue, server refetch, inventory and external cart remain separate from local demo checkout',async t=>{
  const m=mockTransport(),gateway=shopifyGateway(env,{fetcher:m.fetcher}),f=await moduleFixture(t,{providerGateways:{shopify:gateway}}),raw=Buffer.from('{"id":1}'),h=headers(raw),inject=()=>f.app.inject({url:'/v1/webhooks/shopify',method:'POST',headers:h,payload:raw});
  assert.equal((await inject()).statusCode,200);assert.equal((await inject()).json().duplicate,true);assert.equal((await f.post('/api/commercial/providers/shopify/process',{},f.seller.cookie)).statusCode,403);
  assert.equal((await f.post('/api/commercial/providers/shopify/process',{})).json().processed,1);const p=(await f.call('/api/shop-channel/catalogue')).json().items.find(p=>p.external_id===product.id);assert.equal(p.provider,'shopify');assert.equal(p.variants[0].stock,8);
  const buyer=await f.customer('shopify-buyer@example.invalid'),v=p.variants[0],body={request_id:randomUUID(),external_checkout_acknowledged:true,lines:[{variant_id:v.id,quantity:1}]};
  assert.equal((await f.post('/api/client/shop-channel/checkouts',{idempotency_key:randomUUID(),consent:true,lines:body.lines},buyer)).statusCode,409);
  const response=await f.post('/api/client/shopify/carts',body,buyer);assert.equal(response.statusCode,200,response.body);assert.equal(response.json().checkout_url,'https://fixture.myshopify.com/checkouts/fixture');assert.equal((await f.post('/api/client/shopify/carts',body,buyer)).statusCode,200);assert.equal(m.calls.filter(c=>c.query.includes('cartCreate')).length,1);
  const stored=(await f.db.query('SELECT * FROM shopify_carts')).rows[0];assert.ok(!stored.sealed_result.includes('checkouts/fixture'));assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM channel_holds')).rows[0].n,0);
  const orderRaw=Buffer.from('{"id":3}');assert.equal((await f.app.inject({url:'/v1/webhooks/shopify',method:'POST',headers:headers(orderRaw,'orders/paid'),payload:orderRaw})).statusCode,200);assert.equal((await f.post('/api/commercial/providers/shopify/process',{})).json().processed,1);
  const own=(await f.call('/api/client/shop-channel/orders',{cookie:buyer})).json().items[0];assert.equal(own.total_minor,8424);assert.equal((await f.call('/api/shop-channel/products/'+p.slug)).json().variants[0].stock,8);
  assert.equal((await f.call('/shopify-workspace.js')).statusCode,200);
  assert.equal((await f.post('/api/commercial/shop-channel/events/demo',{event_id:randomUUID(),kind:'inventory',payload:{external_id:v.external_id,quantity:99,source_revision:99}})).statusCode,409);
  await f.post('/api/commercial/shop-channel/products/'+p.id+'/visibility',{published:false,archived:false});m.state.product.updatedAt='2026-10-13T12:00:00Z';m.state.product.title='Updated remote title';const newer=Buffer.from('{"id":1}');await f.app.inject({url:'/v1/webhooks/shopify',method:'POST',headers:headers(newer),payload:newer});await f.post('/api/commercial/providers/shopify/process',{});assert.equal((await f.call('/api/shop-channel/products/'+p.slug)).statusCode,404);
});
test('Shopify periodic reconciliation is explicitly enabled, window-stable and paginated without repeated orders',async t=>{
  const m=mockTransport(),f=await moduleFixture(t,{providerGateways:{shopify:shopifyGateway({...env,PHASE2_SHOPIFY_SYNC_ENABLED:'true'},{fetcher:m.fetcher})}});
  for(let n=0;n<4;n++)assert.equal((await f.post('/api/commercial/providers/shopify/process',{})).statusCode,200);
  assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM channel_orders')).rows[0].n,1);assert.equal(m.calls.filter(c=>c.query.includes('orders(first:50')).length,1);const pending=(await f.db.query("SELECT count(*)::integer AS n FROM provider_jobs WHERE status='pending'")).rows[0].n;assert.equal(pending,0);
});
test('Shopify reconciliation quarantines conflicting timestamps or unsupported currencies without overwriting a paid order',async t=>{
  const m=mockTransport(),f=await moduleFixture(t,{providerGateways:{shopify:shopifyGateway(env,{fetcher:m.fetcher})}});
  const submit=async()=>{const raw=Buffer.from('{"id":3}');await f.app.inject({url:'/v1/webhooks/shopify',method:'POST',headers:headers(raw,'orders/paid'),payload:raw});return f.post('/api/commercial/providers/shopify/process',{});};
  assert.equal((await submit()).json().processed,1);m.state.order.email='changed@example.invalid';await submit();assert.equal((await f.db.query("SELECT count(*)::integer AS n FROM provider_jobs WHERE status='quarantined'")).rows[0].n,1);assert.equal((await f.db.query('SELECT customer_email FROM channel_orders')).rows[0].customer_email,order.email);
  m.state.order.totalPriceSet.shopMoney.currencyCode='USD';m.state.order.updatedAt='2026-10-13T12:00:00Z';await submit();assert.equal((await f.db.query("SELECT count(*)::integer AS n FROM provider_jobs WHERE status='quarantined'")).rows[0].n,2);
});
