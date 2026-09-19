import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {currencyForCountry,clientIp,locationPreference} from '../../viicasa-backend/src/geolocation.js';
import {propertyRate,variantRate} from '../../viicasa-backend/src/pricing.js';
import {selectedProperty,selectedVariant,readPrices,readRates} from '../currency-ui.js';

test('country suggests currency, unknown country safely defaults to USD',()=>{
  assert.equal(currencyForCountry('CA'),'CAD');
  for(const country of ['US','MX',null,undefined,''])assert.equal(currencyForCountry(country),'USD');
  assert.equal(locationPreference({socket:{remoteAddress:'127.0.0.1'},headers:{}}).suggestedCurrency,'USD');
});
test('forwarded IP is trusted only through explicitly configured proxies',()=>{
  const req=(remote,xff)=>({socket:{remoteAddress:remote},headers:{'x-forwarded-for':xff}});
  assert.equal(clientIp(req('::ffff:127.0.0.1','8.8.8.8')),'127.0.0.1');
  assert.equal(clientIp(req('127.0.0.1','1.1.1.1, 8.8.8.8'),['127.0.0.1']),'8.8.8.8');
  assert.equal(clientIp(req('127.0.0.1','1.1.1.1, 10.0.0.1'),['127.0.0.1','10.0.0.1']),'1.1.1.1');
  assert.equal(clientIp(req('::1','2001:db8::1'),['::1']),'2001:db8::1');
  assert.equal(clientIp(req('127.0.0.1','invalid'),['127.0.0.1']),'127.0.0.1');
});
test('no automatic FX or currency relabel; server and UI agree on independent tariffs',()=>{
  const p={currency:'USD',nightly_minor:10001,cleaning_minor:1500,rates:{CAD:{nightly_minor:13731,cleaning_minor:2000}}};
  assert.equal(propertyRate(p,'CAD').nightly_minor,13731);
  assert.equal(selectedProperty(p,'CAD').nightly_minor,13731);
  assert.equal(selectedProperty(p,'MXN').price_available,false);
  assert.throws(()=>propertyRate(p,'MXN'),{statusCode:409});
  const v={currency:'USD',price_minor:1234,prices:{CAD:1750}};
  assert.equal(variantRate(v,'CAD').price_minor,1750);
  assert.equal(selectedVariant(v,'CAD').price_minor,1750);
  assert.equal(selectedVariant(v,'MXN').price_minor,null);
  assert.throws(()=>variantRate(v,'MXN'),{statusCode:409});
  assert.deepEqual(readPrices({price_CAD:'17.50',price_USD:''}),{CAD:1750});
  assert.deepEqual(readRates({rate_CAD:'137.31',clean_CAD:'20'}),{CAD:{nightly_minor:13731,cleaning_minor:2000}});
});

const base='http://127.0.0.1:3015';
function client(){const jar=new Map();return async(path,method='GET',body,extra={})=>{
  const r=await fetch(base+path,{method,headers:{cookie:[...jar].map(([k,v])=>`${k}=${v}`).join(';'),...(method!=='GET'?{origin:base}:{}),...(body?{'content-type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined});
  for(const c of r.headers.getSetCookie()){const [kv]=c.split(';'),i=kv.indexOf('=');jar.set(kv.slice(0,i),kv.slice(i+1));}
  return {status:r.status,data:r.status===204?null:await r.json()};
};}
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
test('USD/CAD quotes, orders and immutable payment snapshots in local emulator',async t=>{
  const guest=client(),admin=client(),other=client();
  assert.equal(ok(await guest('/api/config')).demo,true,'Writes require the isolated demo');
  ok(await admin('/api/demo-admin','POST'));
  const suffix=randomUUID().slice(0,8),day=n=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
  const customer={name:'QA Currency',email:'currency@example.invalid',phone:'5550000000',consent:true};
  let property,product,variant,originalShipping;
  const pending=[];
  const propertyInput={slug:'qa-currency-'+suffix,name:'QA currency',description:'Test only',location:'Demo',timezone:'America/Mexico_City',capacity:4,bedrooms:2,bathrooms:2,nightly_minor:10001,cleaning_minor:1500,deposit_percent:30,min_nights:2,currency:'USD',rates:{CAD:{nightly_minor:13731,cleaning_minor:2000}},images:[],amenities:[],policies:'Test only',published:true};
  try{
    property=ok(await admin('/api/admin/properties','POST',propertyInput),201);
    const q={property_id:property.id,check_in:day(100),check_out:day(103),guests:2};
    await t.test('quote uses integer cents in requested currency',async()=>{
      const usd=ok(await guest('/api/bookings/quote','POST',{...q,currency:'USD'}));
      const cad=ok(await guest('/api/bookings/quote','POST',{...q,currency:'CAD'}));
      assert.equal(usd.total_minor,31503);assert.equal(cad.total_minor,43193);assert.equal(cad.currency,'CAD');
      assert.equal(cad.deposit_minor,Math.round(cad.total_minor*.3));
      ok(await guest('/api/bookings/quote','POST',{...q,currency:'MXN'}),409);
      ok(await guest('/api/bookings/quote','POST',{...q,currency:'EUR'}),400);
    });
    await t.test('booking locks currency and price; shared availability and idempotency',async()=>{
      const body={...q,currency:'CAD',customer,pay:'deposit'},key=randomUUID();
      const checkout=ok(await guest('/api/bookings','POST',body,{'idempotency-key':key}),201);pending.push(checkout.id);
      assert.equal(checkout.currency,'CAD');assert.equal(checkout.total_minor,43193);
      ok(await guest('/api/bookings','POST',{...body,currency:'USD'},{'idempotency-key':key}),409);
      ok(await other('/api/bookings','POST',{...body,currency:'USD'},{'idempotency-key':randomUUID()}),409);
      ok(await admin('/api/admin/properties/'+property.id,'PUT',{...propertyInput,rates:{CAD:{nightly_minor:20000,cleaning_minor:2000}}}));
      assert.equal(ok(await guest('/api/checkouts/'+checkout.id)).total_minor,43193);
      const payment=ok(await guest('/api/checkouts/'+checkout.id+'/payment','POST'));
      assert.equal(payment.currency,'CAD');assert.equal(payment.amount_minor,Math.round(43193*.3));
      ok(await guest('/api/checkouts/'+checkout.id+'/cancel','POST'));pending.pop();
    });
    product=ok(await admin('/api/admin/products','POST',{slug:'qa-currency-product-'+suffix,name:'QA currency',description:'Test',category:'Test',images:[],published:true}),201);
    variant=ok(await admin('/api/admin/products/'+product.id+'/variants','POST',{sku:'QA-CURRENCY-'+suffix,name:'Test',currency:'USD',price_minor:1234,prices:{CAD:1750},stock:5,active:true}),201);
    await t.test('cart and order price in CAD with common inventory; cancellation restores stock',async()=>{
      ok(await guest('/api/cart/items/'+variant.id,'PUT',{quantity:2}));
      assert.equal(ok(await guest('/api/cart?currency=CAD')).items[0].price_minor,1750);
      const unavailable=ok(await guest('/api/cart?currency=MXN')).items[0];assert.equal(unavailable.price_available,false);assert.equal(unavailable.price_minor,null);
      ok(await guest('/api/orders','POST',{customer,delivery:'pickup',currency:'MXN'},{'idempotency-key':randomUUID()}),409);
      const checkout=ok(await guest('/api/orders','POST',{customer,delivery:'pickup',currency:'CAD'},{'idempotency-key':randomUUID()}),201);pending.push(checkout.id);
      assert.equal(checkout.currency,'CAD');assert.equal(checkout.total_minor,3500);
      assert.equal(ok(await guest('/api/products/'+product.slug)).variants[0].stock,3);
      const payment=ok(await guest('/api/checkouts/'+checkout.id+'/payment','POST'));assert.equal(payment.currency,'CAD');assert.equal(payment.amount_minor,3500);
      ok(await guest('/api/checkouts/'+checkout.id+'/cancel','POST'));pending.pop();
      assert.equal(ok(await guest('/api/products/'+product.slug)).variants[0].stock,5);
    });
    await t.test('CAD shipping settings, variant price editing and shipping totals',async()=>{
      // Additional prices are optional on legacy edits and must not be stripped.
      ok(await admin('/api/admin/variants/'+variant.id,'PUT',{sku:variant.sku,name:'Test updated',currency:'USD',price_minor:1234,active:true}));
      ok(await admin('/api/admin/variants/'+variant.id,'PUT',{sku:variant.sku,name:'Test updated',currency:'USD',price_minor:1234,prices:{CAD:1800},active:true}));
      const row=ok(await guest('/api/shop/settings')).items.find(s=>s.currency==='CAD');
      originalShipping={pickup_enabled:row.pickup_enabled,shipping_enabled:row.shipping_enabled,shipping_minor:row.shipping_minor,pickup_instructions:row.pickup_instructions,terms:row.terms};
      ok(await admin('/api/admin/shop/settings/CAD','PUT',{...originalShipping,shipping_enabled:true,shipping_minor:1299}));
      ok(await guest('/api/cart/items/'+variant.id,'PUT',{quantity:2}));
      const checkout=ok(await guest('/api/orders','POST',{customer,delivery:'shipping',currency:'CAD',shipping_address:{street:'Demo street 1',city:'Demo',state:'ON',postal_code:'A1A1A1',country:'CA'}},{'idempotency-key':randomUUID()}),201);pending.push(checkout.id);
      assert.equal(checkout.total_minor,4899);assert.equal(checkout.currency,'CAD');
      ok(await guest('/api/checkouts/'+checkout.id+'/cancel','POST'));pending.pop();
    });
  }finally{
    if(originalShipping)ok(await admin('/api/admin/shop/settings/CAD','PUT',originalShipping));
    for(const id of pending)await guest('/api/checkouts/'+id+'/cancel','POST');
    if(property)ok(await admin('/api/admin/properties/'+property.id,'DELETE'),204);
    if(product)ok(await admin('/api/admin/products/'+product.id,'DELETE'),204);
    await admin('/api/auth/logout','POST');
  }
});
