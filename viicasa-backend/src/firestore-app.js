import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import multipart from '@fastify/multipart';
import {openFirestore,initializeStore,must,now} from './firestore-store.js';
import {guards,registerAuth} from './firestore-auth.js';
import {registerCatalog,listPage,pageSchema,adminSchema} from './firestore-catalog.js';
import {cartItems,setCart,quote,createBooking,createOrder,safeCheckout,cancelCheckout,expireHolds} from './firestore-commerce.js';
import {startPayment,settlePayment,stripeWebhook,deliverMail} from './firestore-payments.js';
import {paymentGateway,publicPayment} from './payments.js';
import {fail} from './lib.js';
import * as s from './firestore-schemas.js';
import {listRegisteredCustomers} from './customer-registration.js';

export async function buildFirestoreApp(config,options={}){
  const store=options.store||await openFirestore(config);
  try{await initializeStore(store);}catch(error){if(!options.store)await store.close();throw error;}
  const app=Fastify({logger:options.logger??{level:'info',redact:['req.headers.authorization','req.headers.cookie','req.headers["stripe-signature"]']},
    trustProxy:config.trustProxy,bodyLimit:256*1024,ajv:{customOptions:{removeAdditional:false}}});
  app.decorate('store',store);app.decorate('db',store);
  const guard=guards(store),gateway=options.gateway||paymentGateway(config);
  app.addHook('onClose',async()=>{if(!options.store)await store.close();});
  app.addHook('onSend',async(request,reply,payload)=>{if(!request.url.startsWith('/v1/media/'))reply.header('Cache-Control','no-store');return payload;});
  app.setErrorHandler((error,request,reply)=>{
    if(error.validation)return reply.code(400).send({error:'Datos inválidos',details:error.validation.map(e=>({field:e.instancePath||e.params?.missingProperty||'',message:e.message}))});
    if(error.code===6)return reply.code(409).send({error:'Registro ya existente'});
    if(error.code===10)return reply.code(409).send({error:'Operación concurrente; reintenta con la misma clave de idempotencia'});
    const status=error.statusCode||500;
    if(status>=500)request.log.error({err:{name:error.name,code:error.code},requestId:request.id},'API operation failed');
    reply.code(status).send({error:status>=500&&!error.statusCode?'Error interno':error.message,request_id:request.id});
  });
  await app.register(cors,{origin:config.origins,credentials:false,allowedHeaders:['Content-Type','Authorization','Idempotency-Key'],methods:['GET','POST','PUT','PATCH','DELETE','OPTIONS']});
  await app.register(helmet);await app.register(rateLimit,{max:options.testing?100000:120,timeWindow:'1 minute'});await app.register(multipart);
  await app.register(swagger,{openapi:{info:{title:'VIICASA API · Fase 1 · Firestore',version:'0.2.0',description:'Backend Node.js para Hostinger y Firestore. Importes en centavos.'},
    components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer'},guestAuth:{type:'http',scheme:'bearer',description:'Token de /v1/guest-sessions'}}}}});
  if(!config.production)await app.register(swaggerUi,{routePrefix:'/docs'});
  app.get('/health',{schema:{hide:true}},async()=>({status:'ok'}));
  app.get('/ready',{schema:{hide:true}},async()=>{must(await store.get('system','schema'));return{status:'ready',database:'firestore'};});
  app.get('/openapi.json',{preHandler:config.production?guard.admin():undefined,schema:{hide:true}},async()=>app.swagger());
  await registerAuth(app,store,config,guard);await registerCatalog(app,store,config,guard);
  const guestSchema=(tag,extra={})=>({tags:[tag],security:[{guestAuth:[]}],...extra});
  app.get('/v1/cart',{preHandler:guard.guest,schema:guestSchema('Carrito',{querystring:s.object({currency:s.currency},[])})},request=>cartItems(store,request.guest.id,request.query.currency));
  app.put('/v1/cart/items/:id',{preHandler:guard.guest,schema:guestSchema('Carrito',{params:s.idParams,body:s.object({quantity:s.int(1,99)})})},request=>setCart(store,request.guest.id,request.params.id,request.body.quantity));
  app.delete('/v1/cart/items/:id',{preHandler:guard.guest,schema:guestSchema('Carrito',{params:s.idParams})},async(request,reply)=>{await setCart(store,request.guest.id,request.params.id,0);reply.code(204).send();});
  app.post('/v1/bookings/quote',{schema:{tags:['Reservaciones'],body:s.quoteBody}},request=>store.transaction(tx=>quote(tx,request.body)));
  app.post('/v1/bookings',{preHandler:guard.guest,schema:guestSchema('Reservaciones',{body:s.bookingBody,headers:s.keyHeader})},async(request,reply)=>{
    const row=await createBooking(store,config,request.guest.id,request.headers['idempotency-key'],request.body);reply.code(201);return row;
  });
  app.post('/v1/orders',{preHandler:guard.guest,schema:guestSchema('Pedidos',{body:s.orderBody,headers:s.keyHeader})},async(request,reply)=>{
    const row=await createOrder(store,config,request.guest.id,request.headers['idempotency-key'],request.body);reply.code(201);return row;
  });
  async function checkoutDetail(checkoutId,guestId){
    const row=must(await store.get('checkouts',checkoutId),'Operación no encontrada');
    if(guestId&&row.guest_id!==guestId)fail(404,'Operación no encontrada');
    const payment=await store.get('payments',row.id);return{...safeCheckout(row),payment:payment?publicPayment(payment):null};
  }
  app.get('/v1/checkouts/:id',{preHandler:guard.guest,schema:guestSchema('Operaciones',{params:s.idParams})},async request=>{
    // Verify ownership before running any maintenance side effect.
    await checkoutDetail(request.params.id,request.guest.id);await expireHolds(store);return checkoutDetail(request.params.id,request.guest.id);
  });
  app.post('/v1/checkouts/:id/cancel',{preHandler:guard.guest,schema:guestSchema('Operaciones',{params:s.idParams})},request=>cancelCheckout(store,config,request.params.id,request.guest.id));
  app.post('/v1/checkouts/:id/payment',{preHandler:guard.guest,schema:guestSchema('Pagos',{params:s.idParams})},request=>startPayment(store,config,gateway,request.guest.id,request.params.id));
  if(config.paymentProvider==='demo'&&!config.production)app.post('/v1/admin/payments/:id/simulate',{preHandler:guard.admin(['admin']),schema:adminSchema('Pagos demo',{
    params:s.idParams,body:s.object({event_id:s.str(100,8),outcome:s.choice(['paid','failed','expired'])})})},async request=>{
    const p=must(await store.get('payments',request.params.id),'Pago demo no encontrado');if(p.provider!=='demo'||!p.reference)fail(404,'Pago demo no encontrado');
    return settlePayment(store,config,{provider:'demo',id:request.body.event_id,reference:p.reference,outcome:request.body.outcome,amount:p.amount_minor,currency:p.currency});
  });
  if(config.paymentProvider==='stripe')await app.register(async scope=>{
    scope.removeContentTypeParser('application/json');scope.addContentTypeParser('application/json',{parseAs:'buffer'},(_,body,done)=>done(null,body));
    scope.post('/v1/webhooks/stripe',{schema:{tags:['Webhooks'],summary:'Webhook firmado de Stripe'},config:{rateLimit:false}},request=>stripeWebhook(store,config,gateway,request.body,request.headers['stripe-signature']));
  });
  app.get('/v1/admin/customers',{preHandler:guard.admin(['admin','support','viewer']),schema:adminSchema('Clientes registrados',{
    querystring:s.object({limit:s.int(1,100),cursor:{type:'string',pattern:'^[a-f0-9]{64}$'}},[])
  })},request=>listRegisteredCustomers(store,request.query));
  app.get('/v1/admin/checkouts',{preHandler:guard.admin(['admin','support','viewer']),schema:adminSchema('Operaciones',{querystring:s.object({...pageSchema.properties,
    kind:s.choice(['order','booking']),status:s.choice(['pending','confirmed','cancelled','expired','payment_review'])},[])})},async request=>{
    const filters=[];for(const f of ['kind','status'])if(request.query[f])filters.push([f,'==',request.query[f]]);
    const page=await listPage(store,'checkouts',request.query,filters);return{...page,items:page.items.map(safeCheckout)};
  });
  app.get('/v1/admin/checkouts/:id',{preHandler:guard.admin(['admin','support','viewer']),schema:adminSchema('Operaciones',{params:s.idParams})},request=>checkoutDetail(request.params.id));
  app.post('/v1/admin/checkouts/:id/cancel',{preHandler:guard.admin(['admin','support']),schema:adminSchema('Operaciones',{params:s.idParams})},request=>cancelCheckout(store,config,request.params.id,null,request.user.id));
  app.get('/v1/admin/summary',{preHandler:guard.admin(['admin','support','viewer']),schema:adminSchema('Resumen')},async()=>{
    const published=[['published','==',true],['archived','==',false]];
    const totals=await Promise.all([store.count('properties'),store.count('properties',published),store.count('products'),store.count('products',published),store.count('inquiries',[['status','==','new']])]);
    const checkouts=await Promise.all(['order','booking'].flatMap(kind=>['pending','confirmed','cancelled','expired','payment_review'].map(async status=>({kind,status,count:await store.count('checkouts',[['kind','==',kind],['status','==',status]])}))));
    return{properties:{total:totals[0],published:totals[1]},products:{total:totals[2],published:totals[3]},inquiries:{unread:totals[4]},checkouts};
  });
  app.get('/v1/admin/mail-status',{preHandler:guard.admin(['admin']),schema:adminSchema('Operación técnica')},async()=>({mode:config.mailMode,
    sent:await store.count('mail_outbox',[['status','==','sent']]),pending:await store.count('mail_outbox',[['status','in',['pending','processing']]]),failed:await store.count('mail_outbox',[['status','==','failed']])}));
  app.get('/v1/admin/audit',{preHandler:guard.admin(['admin']),schema:adminSchema('Operación técnica',{querystring:pageSchema})},request=>listPage(store,'audit_log',request.query));
  app.decorate('maintenance',async()=>{
    await expireHolds(store);await deliverMail(store,config);
    const expired=await store.list('sessions',{where:[['expires_at','<=',now()]],limit:100});
    await store.transaction(async tx=>{for(const row of expired)tx.remove('sessions',row.id);});
  });
  await app.ready();return app;
}
