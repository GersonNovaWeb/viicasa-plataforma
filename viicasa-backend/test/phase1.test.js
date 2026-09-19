import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Stripe from 'stripe';
import {buildApp} from '../src/app.js';
import {configFromEnv} from '../src/config.js';
import {id,passwordHash,hash} from '../src/lib.js';
import {one,migrate} from '../src/db.js';
import {expireHolds} from '../src/commerce.js';
import {settlePayment,paymentGateway,stripeWebhook} from '../src/payments.js';
import {deliverMail} from '../src/notifications.js';

let app,config,admin,encoded,temp,guestAddress=1;
const customer={name:'Cliente de prueba',email:'cliente@example.com',phone:'5512345678',consent:true};
const day=n=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
const auth=token=>({authorization:`Bearer ${token}`});
async function req(method,url,payload,token,extra={}){
  const response=await app.inject({method,url,payload,headers:{...(token?auth(token):{}),...extra}});
  return {status:response.statusCode,body:response.body?response.json():null,raw:response};
}
function expect(result,status){assert.equal(result.status,status,JSON.stringify(result.body));return result.body;}
async function guest(){
  const response=await app.inject({method:'POST',url:'/v1/guest-sessions',remoteAddress:`192.0.2.${guestAddress++}`});
  assert.equal(response.statusCode,201,response.body);return response.json().token;
}
async function property(extra={}){
  return expect(await req('POST','/v1/admin/properties',{slug:`casa-${id()}`,name:'Casa prueba',description:'Descripción',location:'Valle de Bravo',
    timezone:'America/Mexico_City',capacity:6,bedrooms:3,bathrooms:2,nightly_minor:250000,cleaning_minor:50000,deposit_percent:30,
    min_nights:2,currency:'MXN',images:[],amenities:['WiFi'],policies:'Política de prueba',published:true,...extra},admin),201);
}
async function product(stock=5,currency='MXN'){
  const p=expect(await req('POST','/v1/admin/products',{slug:`producto-${id()}`,name:'Jarrón',description:'Cerámica',category:'Decoración',images:[],published:true},admin),201);
  const v=expect(await req('POST',`/v1/admin/products/${p.id}/variants`,{sku:`SKU-${id()}`,name:'Natural',price_minor:85000,currency,stock,active:true},admin),201);
  return {p,v};
}
async function order(token,v,quantity=1,key=id()){
  expect(await req('PUT',`/v1/cart/items/${v.id}`,{quantity},token),200);
  return req('POST','/v1/orders',{customer,delivery:'pickup'},token,{'idempotency-key':key});
}
async function booking(token,p,extra={},key=id()){
  return req('POST','/v1/bookings',{property_id:p.id,check_in:day(30),check_out:day(33),guests:2,customer,pay:'full',...extra},token,{'idempotency-key':key});
}
async function pay(token,c){return expect(await req('POST',`/v1/checkouts/${c.id}/payment`,undefined,token),200);}
async function simulate(payment,outcome,event=id()){return req('POST',`/v1/admin/payments/${payment.id}/simulate`,{outcome,event_id:event},admin);}
before(async()=>{
  temp=await mkdtemp(join(tmpdir(),'viicasa-tests-'));
  config={...configFromEnv({DATABASE_DRIVER:'pglite'}),memory:true,mediaDir:temp};
  if(process.env.TEST_DATABASE_URL)Object.assign(config,{driver:'postgres',databaseUrl:process.env.TEST_DATABASE_URL});
  app=await buildApp(config,{logger:false,testing:true});
  encoded=await passwordHash('Una-clave-de-prueba-123');
  await app.db.query('INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5)',[id(),'admin@example.com','Admin',encoded,'admin']);
  admin=expect(await req('POST','/v1/auth/login',{email:'admin@example.com',password:'Una-clave-de-prueba-123'}),200).token;
});
after(async()=>{await app?.close();if(temp)await rm(temp,{recursive:true,force:true});});

test('arranque, migraciones repetibles y contrato OpenAPI',async()=>{
  await migrate(app.db);expect(await req('GET','/ready'),200);
  const spec=expect(await req('GET','/openapi.json'),200);
  assert.ok(spec.paths['/v1/bookings']);assert.ok(spec.paths['/v1/orders']);
  assert.ok(Object.keys(spec.paths).length>30);
});
test('administración exige sesión y respeta roles',async()=>{
  expect(await req('GET','/v1/admin/properties'),401);
  const userId=id(),secret='x'.repeat(43);
  await app.db.query('INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5)',[userId,`${id()}@example.com`,'Viewer',encoded,'viewer']);
  await app.db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hash(secret),userId]);
  expect(await req('GET','/v1/admin/properties',undefined,secret),200);
  expect(await req('POST','/v1/admin/products',{slug:'no',name:'no',description:'no',category:'no',images:[],published:false},secret),403);
  const g=await guest();expect(await req('GET','/v1/admin/properties',undefined,g),401);
});
test('datos no admitidos y publicaciones privadas no se exponen',async()=>{
  const p=await property({published:false});
  expect(await req('GET',`/v1/properties/${p.slug}`),404);
  expect(await req('POST','/v1/bookings/quote',{property_id:p.id,check_in:day(30),check_out:day(33),guests:1}),404);
  expect(await req('POST','/v1/auth/login',{email:'x@example.com',password:'x',role:'admin'}),400);
  const p2=await property();expect(await req('DELETE',`/v1/admin/properties/${p2.id}`,undefined,admin),204);
  expect(await req('GET',`/v1/properties/${p2.slug}`),404);
});
test('cotización de noches, limpieza y anticipo calculada en servidor',async()=>{
  const p=await property();const g=await guest();
  const c=expect(await booking(g,p,{pay:'deposit'}),201);
  assert.equal(c.total_minor,800000);assert.equal(c.due_minor,240000);assert.equal(c.balance_minor,560000);
  assert.equal(c.detail.nights,3);assert.equal(c.status,'pending');
});
test('rechaza fechas, capacidad y estancia mínima inválidas',async()=>{
  const p=await property(),g=await guest();
  expect(await booking(g,p,{check_in:'2027-02-30',check_out:'2027-03-05'}),400);
  expect(await booking(g,p,{guests:7}),400);
  expect(await booking(g,p,{check_out:day(31)}),400);
  expect(await booking(g,p,{check_out:day(29)}),400);
  expect(await booking(g,p,{total_minor:1}),400);
});
test('dos solicitudes concurrentes no reservan fechas solapadas; salida permite siguiente entrada',async()=>{
  const p=await property(),a=await guest(),b=await guest();
  const results=await Promise.all([booking(a,p),booking(b,p)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  expect(await booking(b,p,{check_in:day(33),check_out:day(35)}),201);
});
test('idempotencia de reserva devuelve misma operación y rechaza cambios',async()=>{
  const p=await property(),g=await guest(),key=id();
  const first=expect(await booking(g,p,{},key),201);
  assert.equal(expect(await booking(g,p,{},key),201).id,first.id);
  expect(await booking(g,p,{guests:3},key),409);
});
test('bloqueo de calendario evita reservas',async()=>{
  const p=await property(),g=await guest();
  const block=expect(await req('POST',`/v1/admin/properties/${p.id}/calendar-blocks`,{check_in:day(30),check_out:day(33),reason:'Mantenimiento'},admin),201);
  expect(await booking(g,p),409);
  expect(await req('DELETE',`/v1/admin/calendar-blocks/${block.id}`,undefined,admin),204);
  expect(await booking(g,p),201);
  expect(await req('POST',`/v1/admin/properties/${p.id}/calendar-blocks`,{check_in:day(30),check_out:day(33),reason:'Mantenimiento'},admin),409);
});
test('carrito agrega, modifica y elimina productos',async()=>{
  const {v}=await product(),g=await guest();
  expect(await req('PUT',`/v1/cart/items/${v.id}`,{quantity:1},g),200);
  expect(await req('PUT',`/v1/cart/items/${v.id}`,{quantity:3},g),200);
  assert.equal(expect(await req('GET','/v1/cart',undefined,g),200).items[0].quantity,3);
  expect(await req('DELETE',`/v1/cart/items/${v.id}`,undefined,g),204);
  assert.equal(expect(await req('GET','/v1/cart',undefined,g),200).items.length,0);
});
test('compra preserva precio, descuenta stock y mantiene idempotencia',async()=>{
  const {v}=await product(),g=await guest(),key=id();
  const c=expect(await order(g,v,2,key),201);assert.equal(c.total_minor,170000);
  assert.equal((await one(app.db,'SELECT stock FROM variants WHERE id=$1',[v.id])).stock,3);
  const again=expect(await req('POST','/v1/orders',{customer,delivery:'pickup'},g,{'idempotency-key':key}),201);
  assert.equal(again.id,c.id);
  await app.db.query('UPDATE variants SET price_minor=1 WHERE id=$1',[v.id]);
  const detail=expect(await req('GET',`/v1/checkouts/${c.id}`,undefined,g),200);
  assert.equal(detail.detail.items[0].unit_minor,85000);
});
test('compra concurrente de última existencia solo permite un pedido',async()=>{
  const {v}=await product(1),a=await guest(),b=await guest();
  const results=await Promise.all([order(a,v),order(b,v)]);
  assert.deepEqual(results.map(x=>x.status).sort(),[201,409]);
  assert.equal((await one(app.db,'SELECT stock FROM variants WHERE id=$1',[v.id])).stock,0);
});
test('carrito con monedas mezcladas no descuenta existencias',async()=>{
  const {v}=await product(),{v:usd}=await product(5,'USD'),g=await guest();
  expect(await req('PUT',`/v1/cart/items/${v.id}`,{quantity:1},g),200);
  expect(await order(g,usd),400);
  assert.equal((await one(app.db,'SELECT stock FROM variants WHERE id=$1',[v.id])).stock,5);
});
test('envío cobra tarifa configurada y exige dirección',async()=>{
  expect(await req('PUT','/v1/admin/shop/settings/MXN',{pickup_enabled:true,shipping_enabled:true,shipping_minor:15000,pickup_instructions:'Oficina',terms:'Términos'},admin),200);
  const {v}=await product(),g=await guest();
  expect(await req('PUT',`/v1/cart/items/${v.id}`,{quantity:1},g),200);
  expect(await req('POST','/v1/orders',{customer,delivery:'shipping'},g,{'idempotency-key':id()}),400);
  const result=expect(await req('POST','/v1/orders',{customer,delivery:'shipping',shipping_address:{street:'Calle 1',city:'CDMX',state:'CDMX',postal_code:'01000',country:'MX'}},g,{'idempotency-key':id()}),201);
  assert.equal(result.total_minor,100000);assert.equal(result.detail.shipping_minor,15000);
});
test('cancelación y vencimiento liberan inventario exactamente una vez',async()=>{
  const {v}=await product(3),g=await guest();
  const c=expect(await order(g,v,2),201);
  expect(await req('POST',`/v1/checkouts/${c.id}/cancel`,undefined,g),200);
  expect(await req('POST',`/v1/checkouts/${c.id}/cancel`,undefined,g),200);
  assert.equal((await one(app.db,'SELECT stock FROM variants WHERE id=$1',[v.id])).stock,3);
  const c2=expect(await order(g,v,2),201);
  await app.db.query("UPDATE checkouts SET expires_at=now()-interval '1 minute' WHERE id=$1",[c2.id]);
  await expireHolds(app.db);await expireHolds(app.db);
  assert.equal((await one(app.db,'SELECT stock FROM variants WHERE id=$1',[v.id])).stock,3);
});
test('otro visitante no ve, paga ni cancela una operación ajena',async()=>{
  const p=await property(),a=await guest(),b=await guest(),c=expect(await booking(a,p),201);
  expect(await req('GET',`/v1/checkouts/${c.id}`,undefined,b),404);
  expect(await req('POST',`/v1/checkouts/${c.id}/payment`,undefined,b),404);
  expect(await req('POST',`/v1/checkouts/${c.id}/cancel`,undefined,b),404);
});
test('pago aprobado confirma pedido, notifica y tolera eventos duplicados',async()=>{
  const {v}=await product(),g=await guest(),c=expect(await order(g,v),201),p=await pay(g,c),event=id();
  assert.equal((await pay(g,c)).id,p.id);
  expect(await simulate(p,'paid',event),200);assert.equal(expect(await simulate(p,'paid',event),200).duplicate,true);
  expect(await simulate(p,'paid'),200);expect(await simulate(p,'failed'),200);
  const result=expect(await req('GET',`/v1/checkouts/${c.id}`,undefined,g),200);
  assert.equal(result.status,'confirmed');assert.equal(result.payment.status,'paid');
  const count=await one(app.db,'SELECT count(*)::int AS n FROM mail_outbox WHERE dedupe_key LIKE $1',[`${c.id}:confirmado:%`]);assert.equal(count.n,2);
  expect(await req('POST',`/v1/checkouts/${c.id}/cancel`,undefined,g),409);
});
test('reserva pagada con anticipo confirma fechas y conserva saldo pendiente',async()=>{
  const propertyRow=await property(),g=await guest(),c=expect(await booking(g,propertyRow,{pay:'deposit'}),201),p=await pay(g,c);
  expect(await simulate(p,'paid'),200);
  const result=expect(await req('GET',`/v1/checkouts/${c.id}`,undefined,g),200);
  assert.equal(result.status,'confirmed');assert.equal(result.balance_minor,560000);
  expect(await booking(await guest(),propertyRow),409);
});
test('pago rechazado permite reintentar sin crear pedido ni retención adicional',async()=>{
  const {v}=await product(),g=await guest(),c=expect(await order(g,v),201),p=await pay(g,c);
  expect(await simulate(p,'failed'),200);assert.equal((await pay(g,c)).id,p.id);
  expect(await simulate(p,'paid'),200);
  assert.equal((await one(app.db,'SELECT stock FROM variants WHERE id=$1',[v.id])).stock,4);
});
test('pago tardío queda en revisión y no duplica reservas ni vuelve a descontar stock',async()=>{
  const p=await property(),g=await guest(),c=expect(await booking(g,p),201),payment=await pay(g,c);
  await app.db.query("UPDATE checkouts SET expires_at=now()-interval '1 minute' WHERE id=$1",[c.id]);
  await expireHolds(app.db);expect(await booking(await guest(),p),201);
  expect(await simulate(payment,'paid'),200);
  assert.equal((await one(app.db,'SELECT status FROM checkouts WHERE id=$1',[c.id])).status,'payment_review');
});
test('evento con importe incorrecto se rechaza y no se registra',async()=>{
  const {v}=await product(),g=await guest(),c=expect(await order(g,v),201),p=await pay(g,c);
  const row=await one(app.db,'SELECT * FROM payments WHERE id=$1',[p.id]);
  await assert.rejects(settlePayment(app.db,config,{provider:'demo',id:id(),reference:row.reference,outcome:'paid',amount:1,currency:'MXN'}),/importe/);
  assert.equal((await one(app.db,'SELECT status FROM checkouts WHERE id=$1',[c.id])).status,'pending');
});
test('el visitante no tiene permiso de simular pagos',async()=>{
  const {v}=await product(),g=await guest(),c=expect(await order(g,v),201),p=await pay(g,c);
  expect(await req('POST',`/v1/admin/payments/${p.id}/simulate`,{event_id:id(),outcome:'paid'},g),401);
});
test('webhook Stripe verifica firma sin conectar cuentas externas',async()=>{
  const cfg={...config,paymentProvider:'stripe',stripeKey:'sk_test_placeholder',stripeWebhookSecret:'whsec_local_test'};
  const gateway=paymentGateway(cfg),payload=JSON.stringify({id:'evt_test',type:'unhandled.event',data:{object:{}}});
  const signature=Stripe.webhooks.generateTestHeaderString({payload,secret:cfg.stripeWebhookSecret});
  assert.deepEqual(await stripeWebhook(app.db,cfg,gateway,Buffer.from(payload),signature),{received:true,ignored:true});
  await assert.rejects(stripeWebhook(app.db,cfg,gateway,Buffer.from(payload+' '),signature),/Firma/);
});
test('correo en cola se entrega, y falla SMTP conserva mensaje para reintento',async()=>{
  const before=await one(app.db,'SELECT count(*)::int AS n FROM mail_outbox WHERE sent_at IS NULL');assert.ok(before.n>0);
  const failed=await deliverMail(app.db,{...config,mailMode:'smtp'},{sendMail:async()=>{throw new Error('SMTP no disponible');}});
  assert.ok(failed.failed>0);
  await app.db.query("UPDATE mail_outbox SET next_attempt=now()-interval '1 minute' WHERE sent_at IS NULL");
  const sent=await deliverMail(app.db,{...config,mailMode:'smtp'},{sendMail:async msg=>{assert.ok(msg.text);assert.ok(msg.to);}});
  assert.ok(sent.sent>0);
});
test('multimedia rechaza HTML y permite imagen comprobando formato',async()=>{
  const multipart=(bytes,filename)=>Buffer.concat([Buffer.from(`--BOUNDARY\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),bytes,Buffer.from('\r\n--BOUNDARY--\r\n')]);
  const headers={...auth(admin),'content-type':'multipart/form-data; boundary=BOUNDARY'};
  let response=await app.inject({method:'POST',url:'/v1/admin/media',headers,payload:multipart(Buffer.from('<html>bad</html>'),'x.png')});
  assert.equal(response.statusCode,415,response.body);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
  response=await app.inject({method:'POST',url:'/v1/admin/media',headers,payload:multipart(png,'x.png')});
  assert.equal(response.statusCode,201,response.body);
  const media=await app.inject(response.json().url);assert.equal(media.statusCode,200);assert.equal(media.headers['content-type'],'image/png');
});
test('producción prohíbe pagos demo y base local',()=>{
  assert.throws(()=>configFromEnv({NODE_ENV:'production',DATABASE_DRIVER:'pglite',PAYMENT_PROVIDER:'demo',PUBLIC_SITE_URL:'https://example.com',ALLOWED_ORIGINS:'https://example.com'}),/Producción/);
});
test('HTTP real y persistencia de catálogo después de reiniciar',async()=>{
  const cfg={...config,driver:'pglite',memory:false,dataDir:join(temp,'persistence'),mediaDir:join(temp,'images')};
  let instance=await buildApp(cfg,{logger:false});
  try{
    await instance.db.query(`INSERT INTO products(id,slug,name,description,category,published)
      VALUES($1,'persistencia-http','Persistencia','Prueba local','Test',true)`,[id()]);
  }finally{await instance.close();}
  instance=await buildApp(cfg,{logger:false});
  try{
    const base=await instance.listen({host:'127.0.0.1',port:0});
    const ready=await fetch(`${base}/ready`);assert.equal(ready.status,200);
    const productResponse=await fetch(`${base}/v1/products/persistencia-http`);
    assert.equal(productResponse.status,200);assert.equal((await productResponse.json()).name,'Persistencia');
    const docs=await fetch(`${base}/docs/`);assert.equal(docs.status,200);
  }finally{await instance.close();}
});
