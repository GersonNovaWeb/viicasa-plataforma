import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import multipart from '@fastify/multipart';
import { openDatabase, migrate, one } from './db.js';
import { guards, registerAuth } from './auth.js';
import { registerCatalog } from './catalog.js';
import { quote, createBooking, createOrder, publicCheckout, cancelCheckout, expireHolds } from './commerce.js';
import { paymentGateway, startPayment, settlePayment, stripeWebhook, publicPayment } from './payments.js';
import { fail } from './lib.js';
import * as s from './schemas.js';

export async function buildApp(config, options={}) {
  if(config.driver==='firestore'){
    const {buildFirestoreApp}=await import('./firestore-app.js');return buildFirestoreApp(config,options);
  }
  const db=options.db || await openDatabase(config);
  await migrate(db);
  const app=Fastify({logger:options.logger ?? {level:'info',redact:['req.headers.authorization','req.headers.cookie','req.headers["stripe-signature"]']},
    trustProxy:config.trustProxy,bodyLimit:256*1024,ajv:{customOptions:{removeAdditional:false}}});
  app.decorate('db',db);
  const guard=guards(db),gateway=options.gateway || paymentGateway(config);
  app.addHook('onClose',async()=>{if(!options.db)await db.close();});
  app.addHook('onSend',async(request,reply,payload)=>{
    if(!request.url.startsWith('/v1/media/'))reply.header('Cache-Control','no-store');
    return payload;
  });
  app.setErrorHandler((error,request,reply)=>{
    if(error.validation)return reply.code(400).send({error:'Datos inválidos',details:error.validation.map(e=>({field:e.instancePath||e.params?.missingProperty||'',message:e.message}))});
    if(error.code==='23505')return reply.code(409).send({error:'Ya existe un registro con ese identificador'});
    if(['23503','23514','22007','22008'].includes(error.code))return reply.code(400).send({error:'Los datos no cumplen las reglas del registro'});
    const status=error.statusCode || 500;
    if(status>=500)request.log.error({err:{name:error.name,code:error.code},requestId:request.id},'API operation failed');
    reply.code(status).send({error:status>=500 && !error.statusCode?'Error interno':error.message,request_id:request.id});
  });
  await app.register(cors,{origin:config.origins,credentials:false,allowedHeaders:['Content-Type','Authorization','Idempotency-Key'],methods:['GET','POST','PUT','PATCH','DELETE','OPTIONS']});
  await app.register(helmet);
  await app.register(rateLimit,{max:options.testing?100000:120,timeWindow:'1 minute'});
  await app.register(multipart);
  await app.register(swagger,{openapi:{info:{title:'VIICASA API · Fase 1',version:'0.1.0',description:'Backend independiente. Importes en centavos. Tokens Bearer distintos para visitantes y administradores.'},
    components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer'},guestAuth:{type:'http',scheme:'bearer',description:'Token obtenido de /v1/guest-sessions'}}}}});
  if(!config.production)await app.register(swaggerUi,{routePrefix:'/docs'});
  app.get('/health',{schema:{hide:true}},async()=>({status:'ok'}));
  app.get('/ready',{schema:{hide:true}},async()=>{await db.query('SELECT 1');return{status:'ready'};});
  app.get('/openapi.json',{preHandler:config.production?guard.admin():undefined,schema:{hide:true}},async()=>app.swagger());
  await registerAuth(app,db,config,guard);
  await registerCatalog(app,db,config,guard);

  const guestSchema=(tag,extra={})=>({tags:[tag],security:[{guestAuth:[]}],...extra});
  const adminSchema=(tag,extra={})=>({tags:[tag],security:[{bearerAuth:[]}],...extra});
  app.get('/v1/cart',{preHandler:guard.guest,schema:guestSchema('Carrito')},async request=>{
    const items=(await db.query(`SELECT v.id AS variant_id,v.sku,v.name,v.price_minor,v.currency,v.stock,v.active,c.quantity,
      p.name AS product_name,p.published,p.archived FROM cart_items c JOIN variants v ON v.id=c.variant_id JOIN products p ON p.id=v.product_id
      WHERE c.guest_id=$1 ORDER BY v.id`,[request.guest.id])).rows;
    return{items};
  });
  app.put('/v1/cart/items/:id',{preHandler:guard.guest,schema:guestSchema('Carrito',{params:s.idParams,body:s.object({quantity:s.int(1,99)})})},async request=>db.transaction(async tx=>{
    await tx.query('SELECT id FROM guests WHERE id=$1 FOR UPDATE',[request.guest.id]);
    const variant=await one(tx,`SELECT v.id FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1 AND v.active=true AND p.published=true AND p.archived=false`,[request.params.id]);
    if(!variant)fail(404,'Producto no disponible');
    const count=await one(tx,'SELECT count(*)::int AS n FROM cart_items WHERE guest_id=$1 AND variant_id<>$2',[request.guest.id,variant.id]);
    if(count.n>=50)fail(400,'Máximo 50 variantes por carrito');
    await tx.query(`INSERT INTO cart_items(guest_id,variant_id,quantity) VALUES($1,$2,$3)
      ON CONFLICT(guest_id,variant_id) DO UPDATE SET quantity=excluded.quantity`,[request.guest.id,variant.id,request.body.quantity]);
    return{variant_id:variant.id,quantity:request.body.quantity};
  }));
  app.delete('/v1/cart/items/:id',{preHandler:guard.guest,schema:guestSchema('Carrito',{params:s.idParams})},async(request,reply)=>{
    await db.transaction(async tx=>{
      await tx.query('SELECT id FROM guests WHERE id=$1 FOR UPDATE',[request.guest.id]);
      await tx.query('DELETE FROM cart_items WHERE guest_id=$1 AND variant_id=$2',[request.guest.id,request.params.id]);
    });reply.code(204).send();
  });
  app.post('/v1/bookings/quote',{schema:{tags:['Reservaciones'],body:s.quoteBody}},async request=>quote(db,request.body));
  app.post('/v1/bookings',{preHandler:guard.guest,schema:guestSchema('Reservaciones',{body:s.bookingBody,headers:s.keyHeader})},async(request,reply)=>{
    const result=await createBooking(db,config,request.guest.id,request.headers['idempotency-key'],request.body);reply.code(201);return result;
  });
  app.post('/v1/orders',{preHandler:guard.guest,schema:guestSchema('Pedidos',{body:s.orderBody,headers:s.keyHeader})},async(request,reply)=>{
    const result=await createOrder(db,config,request.guest.id,request.headers['idempotency-key'],request.body);reply.code(201);return result;
  });
  app.get('/v1/checkouts/:id',{preHandler:guard.guest,schema:guestSchema('Operaciones',{params:s.idParams})},async request=>{
    await expireHolds(db);
    const row=await one(db,'SELECT * FROM checkouts WHERE id=$1 AND guest_id=$2',[request.params.id,request.guest.id]);
    if(!row)fail(404,'Operación no encontrada');
    const payment=await one(db,'SELECT * FROM payments WHERE checkout_id=$1',[row.id]);
    return{...publicCheckout(row),payment:payment?publicPayment(payment):null};
  });
  app.post('/v1/checkouts/:id/cancel',{preHandler:guard.guest,schema:guestSchema('Operaciones',{params:s.idParams})},async request=>cancelCheckout(db,config,request.params.id,request.guest.id));
  app.post('/v1/checkouts/:id/payment',{preHandler:guard.guest,schema:guestSchema('Pagos',{params:s.idParams})},async request=>startPayment(db,config,gateway,request.guest.id,request.params.id));

  if(config.paymentProvider==='demo' && !config.production)app.post('/v1/admin/payments/:id/simulate',{
    preHandler:guard.admin(['admin']),schema:adminSchema('Pagos demo',{params:s.idParams,body:s.object({event_id:s.str(100,8),outcome:s.choice(['paid','failed','expired'])})})},async request=>{
    const payment=await one(db,'SELECT * FROM payments WHERE id=$1 AND provider=$2',[request.params.id,'demo']);
    if(!payment?.reference)fail(404,'Pago demo no encontrado');
    return settlePayment(db,config,{provider:'demo',id:request.body.event_id,reference:payment.reference,outcome:request.body.outcome,amount:payment.amount_minor,currency:payment.currency});
  });
  if(config.paymentProvider==='stripe')await app.register(async scope=>{
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json',{parseAs:'buffer'},(_,body,done)=>done(null,body));
    scope.post('/v1/webhooks/stripe',{schema:{tags:['Webhooks'],summary:'Webhook Stripe con firma; no acepta confirmaciones del navegador'},config:{rateLimit:false}},
      async request=>stripeWebhook(db,config,gateway,request.body,request.headers['stripe-signature']));
  });
  app.get('/v1/admin/checkouts',{preHandler:guard.admin(['admin','support','viewer']),schema:adminSchema('Operaciones',{querystring:s.object({...s.pagination.properties,kind:s.choice(['order','booking']),status:s.choice(['pending','confirmed','cancelled','expired','payment_review'])},[])})},async request=>{
    const {limit=20,offset=0,kind=null,status=null}=request.query;
    const rows=(await db.query(`SELECT * FROM checkouts WHERE($3::text IS NULL OR kind=$3) AND($4::text IS NULL OR status=$4)
      ORDER BY created_at DESC,id LIMIT $1 OFFSET $2`,[limit,offset,kind,status])).rows;
    return{items:rows.map(publicCheckout),limit,offset};
  });
  app.get('/v1/admin/checkouts/:id',{preHandler:guard.admin(['admin','support','viewer']),schema:adminSchema('Operaciones',{params:s.idParams})},async request=>{
    const row=await one(db,'SELECT * FROM checkouts WHERE id=$1',[request.params.id]);if(!row)fail(404,'Operación no encontrada');
    const payment=await one(db,'SELECT * FROM payments WHERE checkout_id=$1',[row.id]);return{...publicCheckout(row),payment:payment?publicPayment(payment):null};
  });
  app.post('/v1/admin/checkouts/:id/cancel',{preHandler:guard.admin(['admin','support']),schema:adminSchema('Operaciones',{params:s.idParams})},async request=>cancelCheckout(db,config,request.params.id,null,request.user.id));
  app.get('/v1/admin/summary',{preHandler:guard.admin(['admin','support','viewer']),schema:adminSchema('Resumen')},async()=>({
    properties:await one(db,'SELECT count(*)::int AS total,count(*) FILTER(WHERE published AND NOT archived)::int AS published FROM properties'),
    products:await one(db,'SELECT count(*)::int AS total,count(*) FILTER(WHERE published AND NOT archived)::int AS published FROM products'),
    checkouts:(await db.query('SELECT kind,status,count(*)::int AS count FROM checkouts GROUP BY kind,status')).rows,
    inquiries:await one(db,"SELECT count(*)::int AS unread FROM inquiries WHERE status='new'")
  }));
  app.get('/v1/admin/mail-status',{preHandler:guard.admin(['admin']),schema:adminSchema('Operación técnica')},async()=>({mode:config.mailMode,...await one(db,`SELECT count(*) FILTER(WHERE sent_at IS NOT NULL)::int AS sent,
    count(*) FILTER(WHERE sent_at IS NULL AND attempts<10)::int AS pending,count(*) FILTER(WHERE sent_at IS NULL AND attempts>=10)::int AS failed FROM mail_outbox`)}));
  app.get('/v1/admin/audit',{preHandler:guard.admin(['admin']),schema:adminSchema('Operación técnica',{querystring:s.pagination})},async request=>({items:(await db.query('SELECT * FROM audit_log ORDER BY created_at DESC,id LIMIT $1 OFFSET $2',[request.query.limit??20,request.query.offset??0])).rows}));
  await app.ready();
  return app;
}
