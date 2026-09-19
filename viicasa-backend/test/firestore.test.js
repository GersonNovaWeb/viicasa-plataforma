import {describe,before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Stripe from 'stripe';
import {buildApp} from '../src/app.js';
import {configFromEnv} from '../src/config.js';
import {id} from '../src/lib.js';
import {createUser} from '../src/firestore-auth.js';
import {key,now,initializeStore} from '../src/firestore-store.js';
import {expireHolds,nightsBetween} from '../src/firestore-commerce.js';
import {settlePayment,deliverMail,stripeWebhook} from '../src/firestore-payments.js';
import {paymentGateway} from '../src/payments.js';

describe('Firestore nativo en emulador local',{skip:process.env.RUN_FIRESTORE_TESTS!=='true'},()=>{
  let app,config,admin,temp,guestAddress=1;
  const customer={name:'Cliente de prueba',email:'cliente@example.com',phone:'5512345678',consent:true};
  const day=n=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
  const auth=secret=>({authorization:`Bearer ${secret}`});
  async function req(method,url,payload,secret,extra={}){
    const r=await app.inject({method,url,payload,headers:{...(secret?auth(secret):{}),...extra}});
    return{status:r.statusCode,body:r.body?r.json():null,raw:r};
  }
  function expect(r,status){assert.equal(r.status,status,JSON.stringify(r.body));return r.body;}
  async function guest(){const r=await app.inject({method:'POST',url:'/v1/guest-sessions',remoteAddress:`192.0.2.${guestAddress++}`});assert.equal(r.statusCode,201,r.body);return r.json().token;}
  async function property(extra={}){return expect(await req('POST','/v1/admin/properties',{
    slug:`casa-${id()}`,name:'Casa prueba',description:'Descripción',location:'Valle de Bravo',timezone:'America/Mexico_City',capacity:6,bedrooms:3,bathrooms:2,
    nightly_minor:250000,cleaning_minor:50000,deposit_percent:30,min_nights:2,currency:'MXN',images:[],amenities:['WiFi'],policies:'Política de prueba',published:true,...extra},admin),201);}
  async function product(stock=5,currency='MXN'){
    const p=expect(await req('POST','/v1/admin/products',{slug:`producto-${id()}`,name:'Jarrón',description:'Cerámica',category:'Decoración',images:[],published:true},admin),201);
    const v=expect(await req('POST',`/v1/admin/products/${p.id}/variants`,{sku:`SKU-${id()}`,name:'Natural',price_minor:85000,currency,stock,active:true},admin),201);return{p,v};
  }
  async function order(g,v,quantity=1,k=id()){
    expect(await req('PUT',`/v1/cart/items/${v.id}`,{quantity},g),200);
    return req('POST','/v1/orders',{customer,delivery:'pickup'},g,{'idempotency-key':k});
  }
  async function booking(g,p,extra={},k=id()){return req('POST','/v1/bookings',{property_id:p.id,check_in:day(30),check_out:day(33),guests:2,customer,pay:'full',...extra},g,{'idempotency-key':k});}
  async function pay(g,c){return expect(await req('POST',`/v1/checkouts/${c.id}/payment`,undefined,g),200);}
  async function simulate(p,outcome,event=id()){return req('POST',`/v1/admin/payments/${p.id}/simulate`,{outcome,event_id:event},admin);}
  async function patch(collection,recordId,change){await app.store.transaction(async tx=>{const row=await tx.get(collection,recordId);tx.put(collection,recordId,{...row,...change});});}
  before(async()=>{
    temp=await mkdtemp(join(tmpdir(),'viicasa-firestore-tests-'));
    config={...configFromEnv({DATABASE_DRIVER:'firestore',FIREBASE_MODE:'emulator',FIREBASE_PROJECT_ID:'demo-viicasa',FIRESTORE_EMULATOR_HOST:process.env.TEST_FIRESTORE_HOST||'127.0.0.1:8080'}),mediaDir:temp};
    app=await buildApp(config,{logger:false,testing:true});
    const email=`admin-${id()}@example.com`,password='Una-clave-de-prueba-123';
    await createUser(app.store,{email,password,name:'Admin',role:'admin'});
    admin=expect(await req('POST','/v1/auth/login',{email,password}),200).token;
  });
  after(async()=>{await app?.close();if(temp)await rm(temp,{recursive:true,force:true});});
  test('conexión real al emulador, inicialización repetible y OpenAPI',async()=>{
    await initializeStore(app.store);assert.equal(expect(await req('GET','/ready'),200).database,'firestore');
    const spec=expect(await req('GET','/openapi.json'),200);assert.equal(Object.keys(spec.paths).length,43);
    assert.ok(spec.paths['/v1/admin/customers']?.get);
    assert.ok(spec.paths['/v1/bookings']);
  });
  test('el navegador no puede leer Firestore directamente',async()=>{
    const response=await fetch(`http://${config.firestoreEmulatorHost}/v1/projects/${config.firebaseProjectId}/databases/(default)/documents/properties`);
    assert.equal(response.status,403,await response.text());
  });
  test('permisos administrativos y sesión de visitante separados',async()=>{
    expect(await req('GET','/v1/admin/properties'),401);expect(await req('GET','/v1/admin/properties',undefined,await guest()),401);
    const email=`viewer-${id()}@example.com`,password='Una-clave-de-prueba-123';
    await createUser(app.store,{email,password,name:'Viewer',role:'viewer'});
    const viewer=expect(await req('POST','/v1/auth/login',{email,password}),200).token;
    expect(await req('GET','/v1/admin/properties',undefined,viewer),200);
    expect(await req('POST','/v1/admin/products',{slug:'no',name:'no',description:'no',category:'no',images:[],published:false},viewer),403);
  });
  test('datos inválidos, borradores y archivos no se publican',async()=>{
    const p=await property({published:false});expect(await req('GET',`/v1/properties/${p.slug}`),404);
    const p2=await property();expect(await req('DELETE',`/v1/admin/properties/${p2.id}`,undefined,admin),204);expect(await req('GET',`/v1/properties/${p2.slug}`),404);
    expect(await req('POST','/v1/auth/login',{email:'a@example.com',password:'x',role:'admin'}),400);
  });
  test('unicidad de email, slug y SKU se valida transaccionalmente',async()=>{
    const slug=`unico-${id()}`,body={slug,name:'Otro',description:'Otro',location:'CDMX',timezone:'America/Mexico_City',capacity:2,bedrooms:1,bathrooms:1,nightly_minor:10000,cleaning_minor:0,deposit_percent:100,min_nights:1,currency:'MXN',images:[],amenities:[],policies:'Texto',published:true};
    const results=await Promise.all([req('POST','/v1/admin/properties',body,admin),req('POST','/v1/admin/properties',body,admin)]);
    assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
    const {p,v}=await product();expect(await req('POST',`/v1/admin/products/${p.id}/variants`,{sku:v.sku,name:'Otro',price_minor:1,currency:'MXN',stock:1,active:true},admin),409);
    const email=`unique-${id()}@example.com`,data={email,password:'Una-clave-segura-123',name:'Usuario'};
    await createUser(app.store,data);await assert.rejects(createUser(app.store,data),/Ya existe/);
  });
  test('reserva calcula noches, limpieza, anticipo y saldo',async()=>{
    const p=await property(),g=await guest(),c=expect(await booking(g,p,{pay:'deposit'}),201);
    assert.equal(c.total_minor,800000);assert.equal(c.due_minor,240000);assert.equal(c.balance_minor,560000);
    assert.equal(c.detail.nights,3);
  });
  test('validación de fechas, capacidad y precio no manipulable',async()=>{
    const p=await property(),g=await guest();
    expect(await booking(g,p,{check_in:'2027-02-30',check_out:'2027-03-05'}),400);expect(await booking(g,p,{guests:7}),400);
    expect(await booking(g,p,{check_out:day(31)}),400);expect(await booking(g,p,{total_minor:1}),400);
  });
  test('solicitudes concurrentes de reserva compiten por documentos de noches',async()=>{
    const p=await property(),a=await guest(),b=await guest();
    const results=await Promise.all([booking(a,p),booking(b,p)]);assert.deepEqual(results.map(x=>x.status).sort(),[201,409]);
    expect(await booking(b,p,{check_in:day(33),check_out:day(35)}),201);
  });
  test('idempotencia concurrente devuelve la misma reserva y rechaza cambios',async()=>{
    const p=await property(),g=await guest(),k=id();
    const results=await Promise.all([booking(g,p,{},k),booking(g,p,{},k)]);const a=expect(results[0],201),b=expect(results[1],201);assert.equal(a.id,b.id);
    expect(await booking(g,p,{guests:3},k),409);
  });
  test('bloqueos de calendario y liberación manual',async()=>{
    const p=await property(),g=await guest();
    const block=expect(await req('POST',`/v1/admin/properties/${p.id}/calendar-blocks`,{check_in:day(30),check_out:day(33),reason:'Mantenimiento'},admin),201);
    expect(await booking(g,p),409);expect(await req('DELETE',`/v1/admin/calendar-blocks/${block.id}`,undefined,admin),204);expect(await booking(g,p),201);
  });
  test('carrito agrega, modifica, elimina y mantiene inventario hasta checkout',async()=>{
    const {v}=await product(),g=await guest();
    expect(await req('PUT',`/v1/cart/items/${v.id}`,{quantity:1},g),200);expect(await req('PUT',`/v1/cart/items/${v.id}`,{quantity:3},g),200);
    assert.equal(expect(await req('GET','/v1/cart',undefined,g),200).items[0].quantity,3);assert.equal((await app.store.get('variants',v.id)).stock,5);
    expect(await req('DELETE',`/v1/cart/items/${v.id}`,undefined,g),204);assert.equal(expect(await req('GET','/v1/cart',undefined,g),200).items.length,0);
  });
  test('compra preserva precios y reintento no vuelve a descontar',async()=>{
    const {v}=await product(),g=await guest(),k=id(),c=expect(await order(g,v,2,k),201);
    assert.equal(c.total_minor,170000);assert.equal((await app.store.get('variants',v.id)).stock,3);
    const repeat=expect(await req('POST','/v1/orders',{customer,delivery:'pickup'},g,{'idempotency-key':k}),201);assert.equal(repeat.id,c.id);
    await patch('variants',v.id,{price_minor:1});assert.equal(expect(await req('GET',`/v1/checkouts/${c.id}`,undefined,g),200).detail.items[0].unit_minor,85000);
  });
  test('última existencia no se vende dos veces con solicitudes simultáneas',async()=>{
    const {v}=await product(1),a=await guest(),b=await guest();const results=await Promise.all([order(a,v),order(b,v)]);
    assert.deepEqual(results.map(x=>x.status).sort(),[201,409]);assert.equal((await app.store.get('variants',v.id)).stock,0);
  });
  test('carrito de monedas mezcladas se rechaza sin descontar',async()=>{
    const {v}=await product(),{v:usd}=await product(5,'USD'),g=await guest();
    expect(await req('PUT',`/v1/cart/items/${v.id}`,{quantity:1},g),200);expect(await order(g,usd),400);assert.equal((await app.store.get('variants',v.id)).stock,5);
  });
  test('envío exige dirección y usa tarifa del servidor',async()=>{
    expect(await req('PUT','/v1/admin/shop/settings/MXN',{pickup_enabled:true,shipping_enabled:true,shipping_minor:15000,pickup_instructions:'Oficina',terms:'Términos'},admin),200);
    const {v}=await product(),g=await guest();expect(await req('PUT',`/v1/cart/items/${v.id}`,{quantity:1},g),200);
    expect(await req('POST','/v1/orders',{customer,delivery:'shipping'},g,{'idempotency-key':id()}),400);
    const c=expect(await req('POST','/v1/orders',{customer,delivery:'shipping',shipping_address:{street:'Calle 1',city:'CDMX',state:'CDMX',postal_code:'01000',country:'MX'}},g,{'idempotency-key':id()}),201);
    assert.equal(c.total_minor,100000);
  });
  test('cancelación y vencimiento repetidos restituyen stock una vez',async()=>{
    const {v}=await product(3),g=await guest(),c=expect(await order(g,v,2),201);
    expect(await req('POST',`/v1/checkouts/${c.id}/cancel`,undefined,g),200);expect(await req('POST',`/v1/checkouts/${c.id}/cancel`,undefined,g),200);
    assert.equal((await app.store.get('variants',v.id)).stock,3);
    const c2=expect(await order(g,v,2),201);await patch('checkouts',c2.id,{expires_at:'2000-01-01T00:00:00.000Z'});
    await Promise.all([expireHolds(app.store),expireHolds(app.store)]);assert.equal((await app.store.get('variants',v.id)).stock,3);
  });
  test('acceso ajeno a consulta, pago y cancelación es rechazado',async()=>{
    const p=await property(),a=await guest(),b=await guest(),c=expect(await booking(a,p),201);
    expect(await req('GET',`/v1/checkouts/${c.id}`,undefined,b),404);expect(await req('POST',`/v1/checkouts/${c.id}/payment`,undefined,b),404);expect(await req('POST',`/v1/checkouts/${c.id}/cancel`,undefined,b),404);
  });
  test('confirmación de pago concurrente no duplica estados ni correos',async()=>{
    const {v}=await product(),g=await guest(),c=expect(await order(g,v),201),p=await pay(g,c),event=id();
    assert.equal((await pay(g,c)).id,p.id);
    const results=await Promise.all([simulate(p,'paid',event),simulate(p,'paid',event)]);results.forEach(r=>expect(r,200));assert.equal(results.filter(r=>r.body.duplicate).length,1);
    expect(await simulate(p,'paid'),200);expect(await simulate(p,'failed'),200);
    const detail=expect(await req('GET',`/v1/checkouts/${c.id}`,undefined,g),200);assert.equal(detail.status,'confirmed');assert.equal(detail.payment.status,'paid');
    assert.ok(await app.store.get('mail_outbox',key('mail',`${c.id}:confirmado:customer`)));
    assert.ok(await app.store.get('mail_outbox',key('mail',`${c.id}:confirmado:admin`)));
    expect(await req('POST',`/v1/checkouts/${c.id}/cancel`,undefined,g),409);
  });
  test('reserva con anticipo confirma cada noche y conserva saldo',async()=>{
    const p=await property(),g=await guest(),c=expect(await booking(g,p,{pay:'deposit'}),201),payment=await pay(g,c);expect(await simulate(payment,'paid'),200);
    const detail=expect(await req('GET',`/v1/checkouts/${c.id}`,undefined,g),200);assert.equal(detail.status,'confirmed');assert.equal(detail.balance_minor,560000);
    for(const date of nightsBetween(c.detail.check_in,c.detail.check_out))assert.equal((await app.store.get('occupancy',`${p.id}_${date}`)).status,'confirmed');
    expect(await booking(await guest(),p),409);
  });
  test('pago rechazado puede reintentarse sin una segunda retención',async()=>{
    const {v}=await product(),g=await guest(),c=expect(await order(g,v),201),p=await pay(g,c);
    expect(await simulate(p,'failed'),200);assert.equal((await pay(g,c)).id,p.id);expect(await simulate(p,'paid'),200);assert.equal((await app.store.get('variants',v.id)).stock,4);
  });
  test('pago tardío no sobrescribe las noches reservadas por otra operación',async()=>{
    const p=await property(),g=await guest(),c=expect(await booking(g,p),201),payment=await pay(g,c);
    await patch('checkouts',c.id,{expires_at:'2000-01-01T00:00:00.000Z'});await expireHolds(app.store);
    const replacement=expect(await booking(await guest(),p),201);expect(await simulate(payment,'paid'),200);
    assert.equal((await app.store.get('checkouts',c.id)).status,'payment_review');
    assert.equal((await app.store.get('occupancy',`${p.id}_${c.detail.check_in}`)).checkout_id,replacement.id);
  });
  test('importe falso y simulación por visitante no confirman un pago',async()=>{
    const {v}=await product(),g=await guest(),c=expect(await order(g,v),201),p=await pay(g,c),row=await app.store.get('payments',p.id);
    await assert.rejects(settlePayment(app.store,config,{provider:'demo',id:id(),reference:row.reference,outcome:'paid',amount:1,currency:'MXN'}),/importe/);
    expect(await req('POST',`/v1/admin/payments/${p.id}/simulate`,{event_id:id(),outcome:'paid'},g),401);
    assert.equal((await app.store.get('checkouts',c.id)).status,'pending');
  });
  test('Stripe conserva verificación de firma sobre bytes originales',async()=>{
    const cfg={...config,paymentProvider:'stripe',stripeKey:'sk_test_placeholder',stripeWebhookSecret:'whsec_local_test'},gateway=paymentGateway(cfg);
    const payload=JSON.stringify({id:'evt_test',type:'unhandled.event',data:{object:{}}}),signature=Stripe.webhooks.generateTestHeaderString({payload,secret:cfg.stripeWebhookSecret});
    assert.deepEqual(await stripeWebhook(app.store,cfg,gateway,Buffer.from(payload),signature),{received:true,ignored:true});
    await assert.rejects(stripeWebhook(app.store,cfg,gateway,Buffer.from(payload+' '),signature),/Firma/);
  });
  test('cola de correo reintenta fallas y dos workers no envían la misma tarea',async()=>{
    const cfg={...config,mailMode:'smtp'};
    const failResult=await deliverMail(app.store,cfg,{sendMail:async()=>{throw new Error('Falló SMTP');}});assert.ok(failResult.failed>0);
    const failed=await app.store.list('mail_outbox',{where:[['status','==','pending']],limit:100});
    for(const mail of failed)await patch('mail_outbox',mail.id,{next_attempt:'2000-01-01T00:00:00.000Z'});
    const sent=new Set();const transport={sendMail:async msg=>{assert.ok(!sent.has(msg.messageId));sent.add(msg.messageId);}};
    await Promise.all([deliverMail(app.store,cfg,transport),deliverMail(app.store,cfg,transport)]);assert.ok(sent.size>0);
  });
  test('búsqueda por prefijo y paginación con cursor',async()=>{
    const name=`Prueba${id().replaceAll('-','').slice(0,12)}`;
    await property({name});await property({name});await property({name});
    const first=expect(await req('GET',`/v1/properties?q=${name.toLowerCase()}&limit=2`),200);assert.equal(first.items.length,2);assert.ok(first.next_cursor);
    const second=expect(await req('GET',`/v1/properties?q=${name.toLowerCase()}&limit=2&cursor=${first.next_cursor}`),200);assert.equal(second.items.length,1);
    assert.ok(!first.items.some(x=>x.id===second.items[0].id));expect(await req('GET','/v1/properties?cursor=bad'),400);
  });
  test('HTTP real y datos conservados al reiniciar API',async()=>{
    const p=await property();const second=await buildApp(config,{logger:false});
    try{const base=await second.listen({host:'127.0.0.1',port:0}),r=await fetch(`${base}/v1/properties/${p.slug}`);assert.equal(r.status,200);assert.equal((await r.json()).id,p.id);}finally{await second.close();}
  });
  test('producción no acepta emulador, proyecto demo ni mezcla con variables reales',()=>{
    assert.throws(()=>configFromEnv({NODE_ENV:'production',FIREBASE_MODE:'emulator',PUBLIC_SITE_URL:'https://example.com',ALLOWED_ORIGINS:'https://example.com'}),/Producción/);
    assert.throws(()=>configFromEnv({FIREBASE_MODE:'emulator',FIREBASE_PROJECT_ID:'viicasa'}),/Emulador/);
    assert.throws(()=>configFromEnv({FIREBASE_MODE:'live',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'}),/mezclar/);
  });
});
