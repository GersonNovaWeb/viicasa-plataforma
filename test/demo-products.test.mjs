import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {demoProducts,installDemoProducts,requireSamplePaymentMode} from '../viicasa-backend/src/demo-products.js';
import {buildFirestoreApp} from '../viicasa-backend/src/firestore-app.js';
import {configFromEnv} from '../viicasa-backend/src/config.js';
import {productBody} from '../viicasa-backend/src/firestore-schemas.js';
import {key,afterMinutes,initializeStore} from '../viicasa-backend/src/firestore-store.js';
import {token,hash} from '../viicasa-backend/src/lib.js';
import {createOrder,setCart} from '../viicasa-backend/src/firestore-commerce.js';
import {startPayment,settlePayment,deliverMail} from '../viicasa-backend/src/firestore-payments.js';

// Isolated transactional adapter: no Firebase, Stripe or SMTP network requests.
function memoryStore(){
  let rows=new Map(),tail=Promise.resolve();const clone=v=>v==null?v:structuredClone(v);
  const ops=map=>({get:async(c,k)=>clone(map.get(c+'/'+k)||null),put:(c,k,v)=>map.set(c+'/'+k,clone({...v,id:k})),create:(c,k,v)=>{assert.ok(!map.has(c+'/'+k));map.set(c+'/'+k,clone({...v,id:k}));},remove:(c,k)=>map.delete(c+'/'+k),list:async(c,o={})=>[...map.entries()].filter(([k,r])=>k.startsWith(c+'/')&&(o.where||[]).every(([f,op,v])=>op==='=='?r[f]===v:op==='in'?v.includes(r[f]):op==='<='?r[f]<=v:true)).map(([,v])=>clone(v)).slice(0,o.limit||100)});
  return {get:(...a)=>ops(rows).get(...a),set:(...a)=>ops(rows).put(...a),list:(...a)=>ops(rows).list(...a),transaction:fn=>{const run=tail.then(async()=>{const next=structuredClone(rows),result=await fn(ops(next));rows=next;return result;});tail=run.catch(()=>{});return run;}};
}
const config={paymentProvider:'stripe',stripeMode:'test',stripeKey:'sk_test_fixture',production:true,holdMinutes:30,siteUrl:'https://viicasa.example.invalid',adminEmail:'team@example.invalid',mailFrom:'accounts@example.invalid'};
const customer={name:'Test Buyer',email:'buyer@example.invalid',phone:'+12505550123',consent:true};
const input={customer,currency:'CAD',delivery:'pickup'};
const gateway={provider:'stripe',create:async p=>({reference:'cs_'+p.id,url:'https://checkout.stripe.com/test'})};
async function setup(){const store=memoryStore();await initializeStore(store);await installDemoProducts(store,'admin');await store.set('guests','buyer',{expires_at:afterMinutes(60)});const variant=(await store.list('variants'))[0];await setCart(store,'buyer',variant.id,2);return{store,variant};}

test('four bilingual products with bundled assets and independent CAD/USD tariffs',async()=>{
  assert.equal(demoProducts().length,4);
  for(const {product,variant}of demoProducts()){
    assert.equal(product.is_demo,true);assert.match(product.name,/Demo/);assert.match(product.description,/\[EN\]/);
    assert.equal(variant.stock,20);assert.equal(variant.currency,'CAD');assert.ok(variant.prices.CAD>0&&variant.prices.USD>0);
    for(const image of product.images)await access(new URL('../viicasa-frontend-prototype'+image,import.meta.url));
  }
});

test('concurrent installs are idempotent and never overwrite existing slug/SKU, settings or unrelated data',async()=>{
  const store=memoryStore(),templates=demoProducts();
  await store.set('unique_keys',key('products-slug',templates[0].product.slug),{owner:'real-product'});
  await store.set('products','real-product',{name:'Real product',published:true});
  await store.set('unique_keys',key('sku',templates[1].variant.sku),{owner:'real-variant'});
  await store.set('shop_settings','CAD',{shipping_minor:4500});await store.set('cs_accounts','keep',{name:'Keep'});
  const results=await Promise.all([installDemoProducts(store,'a'),installDemoProducts(store,'a')]);
  assert.equal(results.reduce((n,r)=>n+r.created.length,0),2);
  assert.equal((await store.list('variants')).length,2);assert.equal((await store.list('stock_movements')).length,2);
  assert.equal((await store.get('products','real-product')).name,'Real product');
  assert.equal((await store.get('shop_settings','CAD')).shipping_minor,4500);assert.equal((await store.get('cs_accounts','keep')).name,'Keep');
});

test('API requires admin confirmation; edits, asset images, stock and archive survive reinstallation',async t=>{
  const store=memoryStore(),app=await buildFirestoreApp(configFromEnv({DATABASE_DRIVER:'firestore',FIREBASE_MODE:'emulator',FIREBASE_PROJECT_ID:'demo-unit',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',PAYMENT_PROVIDER:'demo'}),{store,logger:false,testing:true,gateway:{}});
  t.after(()=>app.close());const secrets={};
  for(const role of ['admin','catalog','viewer']){secrets[role]=token();await store.set('users',role,{role,active:true,auth_version:1});await store.set('sessions',hash(secrets[role]),{user_id:role,auth_version:1,expires_at:afterMinutes(5)});}
  const call=(method,url,payload,role='admin')=>app.inject({method,url,payload,headers:role?{authorization:'Bearer '+secrets[role]}:{}});
  assert.equal((await call('POST','/v1/admin/demo-products',{confirm:true},null)).statusCode,401);
  for(const role of ['catalog','viewer'])assert.equal((await call('POST','/v1/admin/demo-products',{confirm:true},role)).statusCode,403);
  assert.equal((await call('POST','/v1/admin/demo-products',{confirm:false})).statusCode,400);
  assert.equal((await store.list('products')).length,0);
  assert.equal((await call('POST','/v1/admin/demo-products',{confirm:true})).json().created.length,4);
  const p=(await store.list('products'))[0],v=(await store.list('variants'))[0];
  const body=Object.fromEntries(Object.keys(productBody.properties).map(k=>[k,p[k]]));body.name='Edited';body.slug='edited-sample';
  const edited=await call('PUT','/v1/admin/products/'+p.id,body);assert.equal(edited.statusCode,200,edited.body);assert.equal(edited.json().is_demo,true);
  assert.equal((await call('PUT','/v1/admin/products/'+p.id,{...body,is_demo:false})).statusCode,400);
  assert.equal((await call('POST','/v1/admin/variants/'+v.id+'/stock',{delta:-5,reason:'Test'})).statusCode,200);
  assert.equal((await call('DELETE','/v1/admin/products/'+p.id)).statusCode,204);
  assert.equal((await call('POST','/v1/admin/demo-products',{confirm:true})).json().created.length,0);
  assert.equal((await store.get('products',p.id)).name,'Edited');assert.equal((await store.get('products',p.id)).archived,true);
  assert.equal((await store.get('variants',v.id)).stock,15);
  assert.equal((await call('GET','/v1/products/edited-sample')).statusCode,404);
  assert.equal((await call('GET','/v1/products')).json().items.length,3);
});

test('sandbox purchase calculates CAD, reduces stock and sends customer PDF plus separate admin notification once',async()=>{
  const {store,variant}=await setup();
  const c=await createOrder(store,config,'buyer',randomUUID(),input);
  assert.equal(c.currency,'CAD');assert.equal(c.total_minor,variant.prices.CAD*2);assert.equal(c.detail.is_demo,true);
  assert.equal((await store.get('variants',variant.id)).stock,18);
  const payment=await startPayment(store,config,gateway,'buyer',c.id);
  const event={provider:'stripe',id:'evt_sample',reference:'cs_'+c.id,outcome:'paid',amount:payment.amount_minor,currency:'CAD'};
  await settlePayment(store,config,event);await settlePayment(store,config,event);
  assert.equal((await store.get('checkouts',c.id)).status,'confirmed');
  const sent=[];await deliverMail(store,{...config,mailMode:'smtp'},{sendMail:async m=>sent.push(m)});
  assert.deepEqual(sent.map(m=>m.to).sort(),['buyer@example.invalid','team@example.invalid']);
  assert.equal(sent.find(m=>m.to===customer.email).attachments[0].content.subarray(0,5).toString(),'%PDF-');
  assert.equal(sent.find(m=>m.to===config.adminEmail).attachments,undefined);
});

test('real or mislabelled keys blocked before stock reservation and before reusing existing payment',async()=>{
  const {store,variant}=await setup(),live={...config,stripeMode:'live',stripeKey:'sk_live_fixture'};
  await assert.rejects(createOrder(store,live,'buyer',randomUUID(),input),e=>e.statusCode===409);
  assert.equal((await store.get('variants',variant.id)).stock,20);assert.equal((await store.list('checkouts')).length,0);
  assert.throws(()=>requireSamplePaymentMode({...live,stripeMode:'test'}),e=>e.statusCode===409);
  assert.throws(()=>requireSamplePaymentMode({...config,paymentProvider:'demo'}),e=>e.statusCode===409);
  const c=await createOrder(store,config,'buyer',randomUUID(),input);
  await assert.rejects(startPayment(store,live,gateway,'buyer',c.id),e=>e.statusCode===409);
  await startPayment(store,config,gateway,'buyer',c.id);
  await assert.rejects(startPayment(store,live,gateway,'buyer',c.id),e=>e.statusCode===409);
});
