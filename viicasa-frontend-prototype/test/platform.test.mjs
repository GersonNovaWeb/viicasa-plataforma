import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const base='http://127.0.0.1:3015';
function client(){const jar=new Map();return async(path,method='GET',body,extra={})=>{
  const headers={cookie:[...jar].map(([k,v])=>`${k}=${v}`).join(';'),...(method!=='GET'?{origin:base}:{}),...(body&&!(body instanceof FormData)?{'content-type':'application/json'}:{}),...extra};
  const r=await fetch(base+path,{method,headers,body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
  for(const c of r.headers.getSetCookie()){const [kv]=c.split(';'),i=kv.indexOf('=');jar.set(kv.slice(0,i),kv.slice(i+1));}
  const data=r.status===204?null:r.headers.get('content-type')?.includes('json')?await r.json():await r.text();return{status:r.status,data,headers:r.headers};
};}
const ok=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.data));return r.data;};
test('platform journeys and permission boundaries in isolated local demo',async t=>{
  const guest=client(),other=client(),admin=client();
  assert.equal(ok(await guest('/api/config')).demo,true,'Never run writes against a live environment');
  await t.test('public routes and local assets',async()=>{
    for(const p of ['/','/propiedades','/viiconcierge/casa-brisa','/coleccion','/shop/jarron-terra','/checkout','/cuenta','/admin','/privacidad','/platform.js','/platform.css'])ok(await guest(p));
    ok(await guest('/platform-server.mjs'),404);ok(await guest('/.env'),404);
  });
  await t.test('unauthenticated admin and cross-origin writes are rejected',async()=>{
    ok(await guest('/api/admin/properties'),401);
    ok(await guest('/api/admin/customers'),401);
    ok(await guest('/api/customers'),404);
    ok(await guest('/api/demo-admin','POST',null,{origin:'https://evil.example'}),403);
    ok(await guest('/api/auth/google','POST',{idToken:'fake'}),503);
    ok(await admin('/api/demo-admin','POST'));
    ok(await admin('/api/admin/summary'));
    assert.ok(Array.isArray(ok(await admin('/api/admin/customers')).items));
  });
  let property,product,variant,checkout;
  const suffix=randomUUID().slice(0,8),day=n=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
  const customer={name:'Prueba local',email:'test@example.invalid',phone:'5550000000',consent:true};
  const input={slug:'qa-residence-'+suffix,name:'QA residence '+suffix,description:'Datos ficticios\n[EN]\nFictional data',location:'Pruebas / Tests',timezone:'America/Mexico_City',capacity:4,bedrooms:2,bathrooms:2,nightly_minor:100000,cleaning_minor:20000,deposit_percent:30,min_nights:2,currency:'MXN',images:[],amenities:['Wi-Fi'],policies:'Pruebas\n[EN]\nTests',published:false};
  try{
    await t.test('admin uploads real image bytes and manages cover/gallery/publication',async()=>{
      const form=new FormData();form.append('file',new Blob([await readFile(new URL('../assets/life.png',import.meta.url))],{type:'image/png'}),'test.png');
      const image=ok(await admin('/api/admin/media','POST',form),201);assert.match(image.url,/^\/v1\/media\//);
      property=ok(await admin('/api/admin/properties','POST',{...input,images:[image.url]}),201);
      ok(await guest('/api/properties/'+property.slug),404);
      property=ok(await admin('/api/admin/properties/'+property.id,'PUT',{...input,images:[image.url],published:true}));
      assert.equal(ok(await guest('/api/properties/'+property.slug)).images[0],image.url);
      ok(await guest(image.url));
    });
    await t.test('quotes calculate price and reject minimum nights/capacity',async()=>{
      const q={property_id:property.id,check_in:day(30),check_out:day(33),guests:2};
      const price=ok(await guest('/api/bookings/quote','POST',q));assert.equal(price.total_minor,320000);assert.equal(price.deposit_minor,96000);
      ok(await guest('/api/bookings/quote','POST',{...q,guests:9}),400);
      ok(await guest('/api/bookings/quote','POST',{...q,check_out:day(31)}),400);
    });
    await t.test('booking idempotency, overlap prevention, ownership and cancellation',async()=>{
      const body={property_id:property.id,check_in:day(30),check_out:day(33),guests:2,customer,pay:'deposit'},key=randomUUID();
      checkout=ok(await guest('/api/bookings','POST',body,{'idempotency-key':key}),201);
      assert.equal(checkout.id,ok(await guest('/api/bookings','POST',body,{'idempotency-key':key}),201).id);
      ok(await other('/api/bookings','POST',body,{'idempotency-key':randomUUID()}),409);
      ok(await other('/api/checkouts/'+checkout.id),404);
      ok(await guest('/api/checkouts/'+checkout.id+'/cancel','POST'));
      assert.equal(ok(await guest('/api/checkouts/'+checkout.id)).status,'cancelled');
      ok(await guest('/api/bookings/quote','POST',{property_id:property.id,check_in:day(30),check_out:day(33),guests:2}));
    });
    await t.test('admin calendar blocks and release affect public quoting',async()=>{
      const block=ok(await admin('/api/admin/properties/'+property.id+'/calendar-blocks','POST',{check_in:day(40),check_out:day(43),reason:'QA maintenance'}),201);
      ok(await guest('/api/bookings/quote','POST',{property_id:property.id,check_in:day(40),check_out:day(43),guests:2}),409);
      const cal=ok(await admin('/api/admin/properties/'+property.id+'/calendar?from='+day(39)+'&to='+day(44)));assert.equal(cal.blocks.length,1);
      ok(await admin('/api/admin/calendar-blocks/'+block.id,'DELETE'),204);
    });
    await t.test('products, basket and orders use server inventory and price',async()=>{
      product=ok(await admin('/api/admin/products','POST',{slug:'qa-product-'+suffix,name:'QA product',description:'Test',category:'Test',images:[],published:true}),201);
      variant=ok(await admin('/api/admin/products/'+product.id+'/variants','POST',{sku:'QA-'+suffix,name:'Natural',price_minor:50000,currency:'MXN',stock:4,active:true}),201);
      ok(await guest('/api/cart/items/'+variant.id,'PUT',{quantity:2}));assert.equal(ok(await guest('/api/cart')).items[0].quantity,2);
      checkout=ok(await guest('/api/orders','POST',{customer,delivery:'pickup'},{'idempotency-key':randomUUID()}),201);assert.equal(checkout.total_minor,100000);
      assert.equal(ok(await guest('/api/products/'+product.slug)).variants[0].stock,2);
      ok(await guest('/api/checkouts/'+checkout.id+'/cancel','POST'));
      assert.equal(ok(await guest('/api/products/'+product.slug)).variants[0].stock,4);
    });
    await t.test('demo payment requires admin; verified settlement confirms booking',async()=>{
      checkout=ok(await guest('/api/bookings','POST',{property_id:property.id,check_in:day(60),check_out:day(63),guests:2,customer,pay:'full'},{'idempotency-key':randomUUID()}),201);
      const payment=ok(await guest('/api/checkouts/'+checkout.id+'/payment','POST'));assert.equal(payment.provider,'demo');assert.equal(payment.checkout_url,null);
      ok(await guest('/api/admin/payments/'+payment.id+'/simulate','POST',{event_id:randomUUID(),outcome:'paid'}),401);
      ok(await admin('/api/admin/payments/'+payment.id+'/simulate','POST',{event_id:randomUUID(),outcome:'paid'}));
      assert.equal(ok(await guest('/api/checkouts/'+checkout.id)).status,'confirmed');
      assert.ok(ok(await guest('/api/account')).items.some(x=>x.id===checkout.id));
      assert.ok(!ok(await other('/api/account')).items.some(x=>x.id===checkout.id));
    });
    await t.test('service enquiry persists and is available only to admin',async()=>{
      const r=ok(await guest('/api/inquiries','POST',{...customer,message:'QA local service request',property_id:property.id}),201);
      const rows=ok(await admin('/api/admin/inquiries?limit=100'));assert.ok(rows.items.some(x=>x.id===r.id));
      ok(await admin('/api/inquiries'),404);
      ok(await admin('/api/admin/inquiries/'+r.id,'PATCH',{status:'attended'}));
    });
  }finally{
    if(property)ok(await admin('/api/admin/properties/'+property.id,'DELETE'),204);
    if(product)ok(await admin('/api/admin/products/'+product.id,'DELETE'),204);
    ok(await admin('/api/auth/logout','POST'));ok(await admin('/api/admin/summary'),401);
  }
});
