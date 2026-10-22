import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import {readFile} from 'node:fs/promises';
import {resolve,sep,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {registerCommercial,cookieValue} from './api.mjs';
import {sessionUser} from './security.mjs';
import {buildFirestoreApp} from '../viicasa-backend/src/firestore-app.js';
import {configFromEnv} from '../viicasa-backend/src/config.js';
import {token,hash,fail} from '../viicasa-backend/src/lib.js';
import {afterMinutes,key} from '../viicasa-backend/src/firestore-store.js';
import {safeCheckout} from '../viicasa-backend/src/firestore-commerce.js';
import {registerCustomers,authenticatedCustomer,customerProfile} from './customer-auth.mjs';
import {registerAgreements} from './agreements.mjs';
import {invoiceGateway} from './invoice-gateway.mjs';
import {deliverCommercialMail} from './mail.mjs';
import {registerServiceOperations,processServiceOperations} from './service-operations.mjs';
import {renderedAttachments} from './service-pdf.mjs';
import {registerReadiness} from './readiness.mjs';
import {registerStays,processStayJobs} from './stays.mjs';
import {registerShopChannel,expireChannelCheckouts} from './shop-channel.mjs';
import {registerCustomerSocial} from './customer-social.mjs';
import {registerCommercialReports} from './commercial-reports.mjs';
import {registerTeamFollowup,processTeamFollowup} from './team-followup.mjs';
import {registerMeasurement,cleanupMeasurement,recordPlatformPaidMeasurement} from './measurement.mjs';
import {registerRecurring,prepareRecurring} from './recurring.mjs';
import {registerPricing} from './pricing.mjs';
import {registerFinancialAdjustments} from './financial-adjustments.mjs';
import {registerCommissionAdjustments} from './commission-adjustments.mjs';
import {registerLaunchReadiness,safeLaunchRuntime} from './launch-readiness.mjs';
import {runtimeSourceRevision} from './source-revision.mjs';
import {registerServiceClosing} from './service-closing.mjs';
import {registerStripeAdvanced} from './stripe-advanced.mjs';
import {shopifyGateway} from './shopify-gateway.mjs';
import {registerShopifyOperations} from './shopify-operations.mjs';
import {analyticsGateway,registerExternalAnalytics} from './analytics-provider.mjs';
import {backgroundProcessor} from './worker-runtime.mjs';
import {runtimeProfile} from './runtime-profile.mjs';
import {registerReleaseInspection} from './release-inspection.mjs';
import {registerStayProviderOperations} from './stay-provider-operations.mjs';
import {registerServiceCatalogue} from './service-catalogue.mjs';
import {guestCheckout} from './guest-checkout.mjs';
import {registerViiExperience} from './ux-experience.mjs';
import {paymentGateway} from '../viicasa-backend/src/payments.js';
import {storefrontLimits} from './traffic-limits.mjs';

const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
export async function buildPhase2App(databases,vault,{origin='http://127.0.0.1:3030',testing=false,stripeKey,stripeWebhookSecret,mailMode='outbox',smtp={},mailFrom='VII Demo <accounts@example.invalid>',adminEmail='team@example.invalid',serviceGateway,connectionEnvironment={},identityGateway,providerGateways={},mode='demo'}={}){
  const profile=runtimeProfile({...connectionEnvironment,PHASE2_MODE:mode,PHASE2_SITE_URL:origin});
  if(stripeKey&&!stripeKey.startsWith('sk_test_'))throw Error('Phase 2 demo requires an sk_test Stripe key.');
  if(mailMode!=='outbox'&&mailMode!=='smtp')throw Error('Invalid demo mail mode');
  const secure=origin.startsWith('https:'),store=databases.store;
  const config=configFromEnv({DATABASE_DRIVER:'firestore',FIREBASE_MODE:'emulator',FIREBASE_PROJECT_ID:'demo-viicasa-phase2',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',PUBLIC_SITE_URL:origin,ALLOWED_ORIGINS:origin,PAYMENT_PROVIDER:stripeKey?'stripe':'demo',STRIPE_MODE:'test',STRIPE_SECRET_KEY:stripeKey,STRIPE_WEBHOOK_SECRET:stripeWebhookSecret,MAIL_MODE:mailMode,MAIL_FROM:mailFrom,SMTP_HOST:smtp.host,SMTP_PORT:String(smtp.port||587),SMTP_USER:smtp.user,SMTP_PASSWORD:smtp.password,SMTP_SECURE:String(smtp.secure||false),ADMIN_EMAIL:adminEmail,VIILIFE_MODE:'live',MEDIA_DIR:resolve(root,'data/phase2-media')});
  if(!profile.simulations&&!stripeKey)config.paymentProvider='disabled';
  if(profile.mode==='staging')config.mediaDir=resolve(root,'data/phase2-staging-media');
  const platformPayments=providerGateways.platformPayments||paymentGateway(config);
  const base=await buildFirestoreApp(config,{store,logger:false,testing,gateway:platformPayments,rateLimit:storefrontLimits({testing,internal:true})});
  const app=Fastify({logger:false,bodyLimit:9*1024*1024,ajv:{customOptions:{removeAdditional:false}}});
  app.addContentTypeParser('multipart/form-data',{parseAs:'buffer'},(_,body,done)=>done(null,body));
  app.setErrorHandler((error,req,reply)=>{const status=error.validation?400:error.statusCode||(['23505','23503','22P02'].includes(error.code)?409:500);reply.code(status).send({error:status<500?error.validation?'Invalid form values.':error.message:'Unable to complete this operation.'});});
  const browserAnalytics=connectionEnvironment.PHASE2_GTM_ENABLED==='true';
  await app.register(helmet,{contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'",...(browserAnalytics?['https://www.googletagmanager.com','https://connect.facebook.net']:[])],styleSrc:["'self'","'unsafe-inline'",'https://fonts.googleapis.com'],fontSrc:["'self'",'https://fonts.gstatic.com','data:'],imgSrc:["'self'",'https:','data:'],connectSrc:["'self'",...(browserAnalytics?['https://www.googletagmanager.com','https://*.google-analytics.com','https://www.facebook.com']:[])],formAction:["'self'"],upgradeInsecureRequests:null}}});
  await app.register(rateLimit,storefrontLimits({testing}));
  app.addHook('onSend',async(r,reply,payload)=>{reply.header('X-Robots-Tag','noindex, nofollow');return payload;});
  app.addHook('onRequest',async r=>{if(profile.simulations||['GET','HEAD','OPTIONS'].includes(r.method))return;const path=r.url.split('?')[0];if(/\/(simulate(?:-[a-z-]+)?|examples|demo|demo-products|demo-properties)(\/|$)/.test(path)||path.startsWith('/api/viilife-demo')||path==='/api/commercial/sales'||path==='/api/client/shop-channel/checkouts'||path.startsWith('/api/commercial/commission-')&&/\/(recovery|supplement)$/.test(path))fail(409,'Simulation tools are unavailable in staging. Use the separate demo profile.');if(!stripeKey&&(/\/(payment|checkouts?)$/.test(path)))fail(409,'Stripe test checkout is disabled until sandbox credentials are configured.');});
  const guards=await registerCommercial(app,{db:databases.commercial,vault,origin,secure});
  config.channelMailEnabled=connectionEnvironment.PHASE2_SHOPIFY_MAIL_APPROVED==='true';
  registerPricing(app,{db:databases.commercial,userGuard:guards.userGuard,adminGuard:guards.adminGuard});
  registerCommercialReports(app,{db:databases.commercial,userGuard:guards.userGuard});
  registerTeamFollowup(app,{db:databases.commercial,userGuard:guards.userGuard,adminGuard:guards.adminGuard});
  registerMeasurement(app,{db:databases.commercial,store,origin,adminGuard:guards.adminGuard});
  const analytics=providerGateways.analytics||analyticsGateway(connectionEnvironment,{origin}),analyticsOperations=registerExternalAnalytics(app,{db:databases.commercial,adminGuard:guards.adminGuard,gateway:analytics});
  const {customerGuard}=await registerCustomers(app,{db:databases.commercial,origin});
  const guestAccess=guestCheckout({app,db:databases.commercial,store,vault,origin,config,customerGuard,gateway:platformPayments});
  await registerViiExperience(app,{db:databases.commercial,store,customerGuard});
  await registerServiceCatalogue(app,{db:databases.commercial,store,adminGuard:guards.adminGuard,customerGuard,config,origin,guestAccess});
  const shopify=providerGateways.shopify||shopifyGateway(connectionEnvironment),shopifyOperations=registerShopifyOperations(app,{db:databases.commercial,gateway:shopify,config,origin,vault,adminGuard:guards.adminGuard,customerGuard,guestAccess});
  config.stayMailEnabled=connectionEnvironment.PHASE2_STAY_MAIL_APPROVED==='true';
  config.runtimeMode=profile.mode;
  const stayOperations=registerStayProviderOperations(app,{db:databases.commercial,adminGuard:guards.adminGuard,gateways:providerGateways.stays||{},approved:connectionEnvironment.PHASE2_STAY_CONNECTOR_APPROVED==='true',mailApproved:config.stayMailEnabled});
  const customerIdentity=await registerCustomerSocial(app,{db:databases.commercial,vault,origin,environment:connectionEnvironment,customerGuard,gateway:identityGateway,testing});
  const servicePayments=serviceGateway||invoiceGateway(config,{advanced:connectionEnvironment.PHASE2_STRIPE_ADVANCED==='true'});
  const stripeAdvanced=registerStripeAdvanced(app,{db:databases.commercial,gateway:servicePayments,origin,config,customerGuard,adminGuard:guards.adminGuard,autoCollect:connectionEnvironment.PHASE2_STRIPE_AUTO_COLLECT==='true'});
  const serviceOperations=await registerAgreements(app,{db:databases.commercial,origin,teamGuard:guards.userGuard,adminGuard:guards.adminGuard,customerGuard,config,gateway:servicePayments,guestAccess});
  registerFinancialAdjustments(app,{db:databases.commercial,origin,teamGuard:guards.userGuard,adminGuard:guards.adminGuard,customerGuard,config,gateway:servicePayments});
  await registerCommissionAdjustments(app,{db:databases.commercial,userGuard:guards.userGuard,adminGuard:guards.adminGuard});
  await registerServiceOperations(app,{db:databases.commercial,origin,teamGuard:guards.userGuard,adminGuard:guards.adminGuard,customerGuard,config});
  registerServiceClosing(app,{db:databases.commercial,origin,teamGuard:guards.userGuard,adminGuard:guards.adminGuard,customerGuard,config});
  await registerRecurring(app,{db:databases.commercial,origin,teamGuard:guards.userGuard,adminGuard:guards.adminGuard,customerGuard,config,gateway:servicePayments});
  const providerStatus={shopify:{enabled:shopify.enabled},ga4:{enabled:analytics.providers.includes('ga4')},meta:{enabled:analytics.providers.includes('meta')},gtm:{enabled:Boolean(analytics.gtm)}};
  await registerReadiness(app,{db:databases.commercial,adminGuard:guards.adminGuard,config,connectionEnvironment,databaseDriver:databases.driver,identityStatus:customerIdentity.availability(),providerStatus});
  const launchRuntime=safeLaunchRuntime({origin,config,
    connectionEnvironment,databaseDriver:databases.driver,identityStatus:customerIdentity.availability(),paymentProvider:servicePayments.provider,
    sourceRevision:await runtimeSourceRevision(root),adapterStatus:{stripe_recurring:stripeAdvanced.enabled,stripe_refund:stripeAdvanced.enabled,shopify:shopify.enabled,stay:stayOperations.enabled,analytics:analytics.providers.length>0||Boolean(analytics.gtm)}});
  registerLaunchReadiness(app,{db:databases.commercial,adminGuard:guards.adminGuard,runtime:launchRuntime});registerReleaseInspection(app,{databases,adminGuard:guards.adminGuard,runtime:launchRuntime});
  await registerStays(app,{db:databases.commercial,adminGuard:guards.adminGuard,customerGuard,seedExamples:profile.seedExamples,mailApproved:config.stayMailEnabled,adminEmail:config.adminEmail});
  await registerShopChannel(app,{db:databases.commercial,adminGuard:guards.adminGuard,customerGuard,config,origin,guestAccess});
  const guest=async(req,reply)=>{
    const clientSecret=cookieValue(req,'vc2_client'),customer=await authenticatedCustomer(databases.commercial,clientSecret);
    if(customer){
      const expires_at=afterMinutes(8*60),row={id:customer.id,created_at:customer.created_at,expires_at,customer_account:true};
      await store.transaction(async tx=>{const old=await tx.get('guests',customer.id);tx.put('guests',customer.id,{...old,...row});tx.put('guest_tokens',hash(clientSecret),{guest_id:customer.id,expires_at});});
      return{secret:clientSecret,row,customer};
    }
    let secret=cookieValue(req,'vc2_guest'),index=secret&&await store.get('guest_tokens',hash(secret)),g=index&&await store.get('guests',index.guest_id);
    if(g?.customer_account)g=null;
    if(!g||g.expires_at<=new Date().toISOString()){
      secret=token();const id=randomUUID(),expires_at=afterMinutes(30*24*60);g={id,created_at:new Date().toISOString(),expires_at};
      await store.transaction(async tx=>{tx.create('guests',id,g);tx.create('guest_tokens',hash(secret),{guest_id:id,expires_at});});
      reply.header('Set-Cookie',`vc2_guest=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure?'; Secure':''}`);
    }return{secret,row:g};
  };
  app.get('/api/config',async()=>({demo:profile.mode==='demo',phase:2,runtimeMode:profile.mode,guestCheckoutEnabled:true,paymentMode:'test',productionEnabled:false,simulationsEnabled:profile.simulations,customerLoginUrl:'/cliente',viilifeMode:'live',country:'CA',suggestedCurrency:'CAD',geoAvailable:false,commerceEnabled:true,payment:config.paymentProvider,googleEnabled:customerIdentity.availability().google.enabled,authProviders:{google:customerIdentity.availability().google.enabled,apple:customerIdentity.availability().apple.enabled,email:true,facebook:false},firebase:null}));
  const proxy=async(req,reply)=>{
    if(!['GET','HEAD'].includes(req.method)&&req.url!=='/v1/webhooks/stripe'&&req.headers.origin!==origin)fail(403,'Request origin is not allowed.');
    if(req.url==='/api/auth/logout'&&req.method==='POST'){
      await databases.commercial.query('DELETE FROM customer_sessions WHERE token_hash=$1',[hash(cookieValue(req,'vc2_client'))]);reply.header('Set-Cookie',`vc2_client=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure?'; Secure':''}`);return{ok:true};
    }
    if(req.url.startsWith('/api/auth/')||req.url.startsWith('/api/demo-admin'))fail(401,'Sign in to the Phase 2 team portal at /equipo with two-step verification.');
    const g=await guest(req,reply);
    if(req.url==='/api/account')return{profile:g.customer?customerProfile(g.customer):null,items:(await store.list('checkouts',{where:[['guest_id','==',g.row.id]],limit:100})).sort((a,b)=>b.created_at.localeCompare(a.created_at)).map(safeCheckout),demo:true};
    let secret=g.secret;
    if(req.url.startsWith('/api/admin/')){
      const u=await sessionUser(databases.commercial,cookieValue(req,'vc2_team'));if(!u||u.role!=='admin')fail(403,'Sign in as administrator at /equipo.');
      if(new URL(req.url,origin).pathname==='/api/admin/customers'){
        const query=new URL(req.url,origin).searchParams,limit=Number(query.get('limit')||25),cursor=query.get('cursor');
        if(!Number.isInteger(limit)||limit<1||limit>100||cursor&&!/^[a-f0-9-]{36}$/.test(cursor))fail(400,'Invalid customer page.');
        const rows=(await databases.commercial.query('SELECT id,name,email,email_verified,created_at FROM customer_accounts WHERE ($1::uuid IS NULL OR id<$1::uuid) ORDER BY id DESC LIMIT $2',[cursor,limit+1])).rows;
        return{items:rows.slice(0,limit).map(u=>({...customerProfile(u),created_at:u.created_at})),next_cursor:rows.length>limit?rows[limit-1].id:null};
      }
      const record=await store.get('unique_keys',key('email',u.email));let uid=record?.owner;
      if(!uid){uid=randomUUID();await store.transaction(async tx=>{tx.create('users',uid,{email:u.email,name:u.name,role:'admin',active:true,auth_version:1});tx.create('unique_keys',key('email',u.email),{owner:uid});});}
      secret=token();await store.set('sessions',hash(secret),{user_id:uid,auth_version:1,expires_at:afterMinutes(1)});
    }
    const target=req.url.replace(/^\/api/,'/v1');
    if(!/^\/v1\/(products|properties|shop\/settings|cart|bookings|orders|checkouts|admin|cleaning|viilife|viilife-demo|inquiries|media|webhooks\/stripe)([/?]|$)/.test(target))fail(404,'Route not found.');
    if(g.customer&&['/api/orders','/api/bookings','/api/viilife/requests','/api/cleaning/requests'].includes(req.url)&&req.body?.customer)req.body.customer.email=g.customer.email;
    const paying=/^\/api\/checkouts\/([a-f0-9-]{36})\/payment$/.exec(req.url);
    if(paying&&req.method==='POST'&&!g.customer){const c=await store.get('checkouts',paying[1]);if(c?.guest_id===g.row.id)await guestAccess.sessionForCheckout(reply,c.id,3600);}
    const response=await base.inject({method:req.method,url:target,remoteAddress:req.ip,headers:{authorization:'Bearer '+secret,...(req.headers['idempotency-key']?{'idempotency-key':req.headers['idempotency-key']}:{}),...(Buffer.isBuffer(req.body)?{'content-type':req.headers['content-type']}:{})},payload:req.body});
    if(!g.customer&&response.statusCode<300&&req.method==='POST'&&['/api/orders','/api/bookings','/api/viilife/requests','/api/cleaning/requests'].includes(req.url)){
      const data=response.json(),id=data.checkout?.id||(data.kind?data.id:null);
      if(id)await store.transaction(async tx=>{const c=await tx.get('checkouts',id);if(!c||c.guest_id!==g.row.id)return;const actionUrl=await guestAccess.platformLink(tx,c);const {enqueue}=await import('../viicasa-backend/src/firestore-commerce.js');const {brandedMail}=await import('../viicasa-backend/src/platform-mail.js');const mail=brandedMail({testNote:config.paymentProvider==='demo'?'Phase 2 demonstration. No real payment or delivery.':'Stripe sandbox review. This is not a payment receipt. No real money is charged.',subject:'VII · Your private order link',title:'Your order, without an account',paragraphs:[`Hello ${c.customer_name},`,'Use this private link to review this order and complete payment when available. Creating an account is optional. Do not forward this link.'],actionUrl,actionLabel:'View my order'});await enqueue(tx,'guest-access:'+id,c.customer_email,mail.subject,mail.body,mail.html);});
    }
    reply.code(response.statusCode).type(response.headers['content-type']||'application/json');return response.rawPayload;
  };
  for(const method of ['GET','POST','PUT','PATCH','DELETE'])app.route({method,url:'/api/*',handler:proxy});
  app.get('/v1/media/:id',proxy);
  if(stripeKey){app.register(async scope=>{scope.removeContentTypeParser('application/json');scope.addContentTypeParser('application/json',{parseAs:'buffer'},(_,body,done)=>done(null,body));scope.post('/v1/webhooks/stripe',async(req,reply)=>{
    const event=servicePayments.verify(req.body,req.headers['stripe-signature']),session=event.data?.object;
    if(await stripeAdvanced.webhook(event))return{received:true};
    if(session?.metadata?.phase2_invoice_id){
      const outcome={'checkout.session.completed':'paid','checkout.session.async_payment_succeeded':'paid','checkout.session.async_payment_failed':'failed','checkout.session.expired':'expired'}[event.type];
      if(!outcome||outcome==='paid'&&session.payment_status!=='paid')return{received:true};
      return serviceOperations.settleInvoice({id:'stripe:'+event.id,reference:session.id,outcome,amount:session.amount_total,currency:session.currency,intent_reference:typeof session.payment_intent==='string'?session.payment_intent:null});
    }
    const response=await base.inject({method:'POST',url:'/v1/webhooks/stripe',headers:{'content-type':'application/json','stripe-signature':req.headers['stripe-signature']},payload:req.body});
    if(response.statusCode>=200&&response.statusCode<300&&session?.metadata?.checkout_id)try{await recordPlatformPaidMeasurement(databases.commercial,store,session.metadata.checkout_id);}catch{/* A validated webhook must not fail for optional analytics. */}
    reply.code(response.statusCode).type('application/json');return response.rawPayload;
  });});}
  // Outbox is private and inspectable; SMTP is opt-in for this independent demo.
  app.get('/api/commercial/outbox',{preHandler:guards.adminGuard},async()=>({mode:mailMode,items:[...(await store.list('mail_outbox',{limit:100})).map(({id,recipient,subject,status,created_at})=>({id,recipient,subject,status,created_at,source:'platform',attachments:[]})),...(await databases.commercial.query('SELECT id,recipient,subject,status,created_at,attachments,last_error,delivery_scope FROM commercial_mail ORDER BY created_at DESC LIMIT 100')).rows.map(m=>({...m,attachments:m.attachments.map(a=>({filename:a.filename})),source:'commercial'}))].sort((a,b)=>new Date(b.created_at)-new Date(a.created_at))}));
  app.get('/api/commercial/outbox/:id/preview',{preHandler:guards.adminGuard},async(r,reply)=>{
    const row=(await databases.commercial.query('SELECT html FROM commercial_mail WHERE id=$1',[r.params.id])).rows[0]||await store.get('mail_outbox',r.params.id);if(!row?.html)fail(404,'Message not found.');return reply.type('text/html').send(row.html);
  });
  app.get('/api/commercial/outbox/:id/attachment/:index',{preHandler:guards.adminGuard},async(r,reply)=>{
    const index=Number(r.params.index);if(!Number.isInteger(index)||index<0||index>1)fail(404,'Attachment not found.');
    const row=(await databases.commercial.query('SELECT attachments FROM commercial_mail WHERE id=$1',[r.params.id])).rows[0],descriptor=row?.attachments[index];if(!descriptor)fail(404,'Attachment not found.');const [attachment]=await renderedAttachments([descriptor]);return reply.type('application/pdf').header('Cache-Control','private, no-store').header('Content-Disposition',`attachment; filename="${attachment.filename}"`).send(attachment.content);
  });
  const processor=backgroundProcessor(databases.commercial,[['platform',()=>base.maintenance()],['shopify',()=>shopifyOperations.process()],['analytics',()=>analyticsOperations.process()],['service-operations',()=>processServiceOperations(databases.commercial,config,origin)],['recurring-preparation',()=>prepareRecurring(databases.commercial,{provider:servicePayments.provider})],['stripe-reconciliation',()=>stripeAdvanced.process()],['stay-providers',()=>stayOperations.process()],['stays',()=>processStayJobs(databases.commercial,{mailApproved:config.stayMailEnabled,adminEmail:config.adminEmail})],['cart-expiry',()=>expireChannelCheckouts(databases.commercial)],['team-alerts',()=>processTeamFollowup(databases.commercial)],['privacy-retention',()=>cleanupMeasurement(databases.commercial)],['commercial-mail',()=>deliverCommercialMail(databases.commercial,config)]],{automaticStripeCharging:stripeAdvanced.enabled&&connectionEnvironment.PHASE2_STRIPE_AUTO_COLLECT==='true'});
  app.decorate('processMail',processor.run);app.decorate('drainWorker',processor.drain);
  app.get('/api/commercial/operations/worker',{preHandler:guards.adminGuard},async(r,reply)=>{reply.header('Cache-Control','private, no-store');return processor.status();});
  app.get('/health/live',async()=>({ok:true}));
  app.get('/health/ready',async(r,reply)=>{try{await Promise.all([databases.commercial.query('SELECT 1'),databases.platform.query('SELECT 1')]);return{ok:true};}catch{return reply.code(503).send({ok:false});}});
  app.post('/api/commercial/outbox/process',{preHandler:guards.adminGuard,schema:{body:{type:'object',additionalProperties:false,properties:{}}}},async()=>{await app.processMail();return{ok:true};});
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.mp4':'video/mp4'};
  app.get('/*',async(req,reply)=>{
    const pathname=new URL(req.url,origin).pathname;
    let relative,portalRole;
    if(['/admin/','/vendedor/','/equipo/'].includes(pathname))return reply.header('Cache-Control','private, no-store').redirect(pathname.slice(0,-1),303);
    if(['/admin','/vendedor','/equipo','/admin/plataforma'].includes(pathname)){
      reply.header('Cache-Control','private, no-store');
      const current=await sessionUser(databases.commercial,cookieValue(req,'vc2_team'));
      const assigned=current?.role==='admin'?'/admin':'/vendedor';
      if(pathname==='/admin/plataforma'){
        if(!current)return reply.redirect('/admin',303);
        if(current.role!=='admin')return reply.redirect(assigned,303);
        relative='viicasa-frontend-prototype/index.html';
      }else{
        portalRole=pathname==='/admin'?'admin':pathname==='/vendedor'?'seller':'team';
        if(current&&(portalRole==='team'||current.role!==portalRole))return reply.redirect(assigned,303);
        relative='phase2/public/portal.html';
      }
    }
    if(relative){/* The explicit team routes above take precedence over the public site. */}
    else if(pathname==='/')relative='viicasa-frontend-prototype/index.html';
    else if(pathname==='/assets/logo-email.png')relative='viicasa-backend/assets/logo-email.png';
    else if(pathname==='/fase2')relative='phase2/public/index.html';
    else if(pathname==='/cliente')relative='phase2/public/customer.html';
    else if(pathname==='/pedido')relative='phase2/public/guest-order.html';
    else if(pathname==='/solicitar')relative='phase2/public/guest-request.html';
    else if(['/guest-order.js','/guest-buyer.js','/guest-request.js','/guest-checkout.css'].includes(pathname))relative='phase2/public'+pathname;
    else if(/^\/servicios(?:\/[a-z0-9-]+)?$/.test(pathname))relative='phase2/public/service-catalogue.html';
    else if(['/service-catalogue.js','/service-catalogue.css','/service-experience.js','/service-experience.css','/catalogue-workspace.js'].includes(pathname))relative='phase2/public'+pathname;
    else if(/^\/shop-channel\/[a-z0-9-]+$/.test(pathname))relative='phase2/public/shop-channel.html';
    else if(['/shopify-workspace.js','/analytics-external.js','/analytics-workspace.js','/release-workspace.js','/stay-provider-workspace.js','/runtime-presentation.js'].includes(pathname))relative='phase2/public'+pathname;
    else if(['/phase2.js','/phase2.css','/portal.js','/customer.js','/document.js','/service-workspace.js','/operations-workspace.js','/stays-workspace.js','/shop-channel.js','/shop-workspace.js','/reports-workspace.js','/followup-workspace.js','/consent.js','/consent.css','/measurement-workspace.js','/recurring-workspace.js','/recurring-customer.js','/pricing-workspace.js','/quote-editor.js','/financial-workspace.js','/commission-workspace.js','/launch-workspace.js','/closing-workspace.js','/channel-breakdown.js','/channel-cart.js','/stay-review-workspace.js','/commission-correction-workspace.js','/stripe-customer.js','/stripe-workspace.js'].includes(pathname))relative='phase2/public'+pathname;
    else if(/^\/(shop|viilife|viiconcierge|propiedades|coleccion|cuenta|checkout|privacidad|pago\/resultado|pago\/cancelado)(\/[^.]+)?$/.test(pathname))relative='viicasa-frontend-prototype/index.html';
    else if(/^\/(assets\/[^.][a-zA-Z0-9._/-]+|[a-z-]+\.(js|css))$/.test(pathname))relative='viicasa-frontend-prototype'+pathname;
    else fail(404,'Not found.');
    const file=resolve(root,relative);
    if(!file.startsWith(root+sep))fail(404,'Not found.');
    try{let body=await readFile(file);if(portalRole)body=Buffer.from(body.toString().replace('<body>',`<body data-team-portal="${portalRole}">`).replace('Team workspace',portalRole==='admin'?'Administration':portalRole==='seller'?'Sales workspace':'Team workspace'));
      if(relative.endsWith('.html')&&!portalRole)body=Buffer.from(body.toString().replace('</head>','<link rel="stylesheet" href="/guest-checkout.css"></head>'));
      // Public Phase 2 storefront only. Never retheme the team portal or private order.
      if((relative==='viicasa-frontend-prototype/index.html'&&pathname!=='/admin/plataforma')||relative==='phase2/public/service-catalogue.html'){
        body=Buffer.from(body.toString().replace('<html ','<html data-vii-glass ').replace('</head>','<link rel="stylesheet" href="/liquid-glass.css"></head>'));
      }
      if(relative.endsWith('.html')&&pathname!=='/pedido')body=Buffer.from(body.toString().replace('</head>','<script type="module" src="/runtime-presentation.js"></script></head>'));
      if(relative==='viicasa-frontend-prototype/index.html')body=Buffer.from(body.toString().replace('<body class="platform">','<body class="platform"><a class="phase2-link" href="/equipo" style="position:fixed;bottom:8px;right:16px;z-index:40;background:#243d34;color:#fff;padding:8px 16px;border-radius:20px;font:12px Arial">Phase 2 · Team portal</a>'));
      if(relative.endsWith('.html')&&!portalRole&&!['/admin/plataforma','/pedido'].includes(pathname))body=Buffer.from(body.toString().replace('</head>','<link rel="stylesheet" href="/consent.css"><script type="module" src="/consent.js"></script></head>'));
      if(!portalRole&&pathname!=='/admin/plataforma'&&['viicasa-frontend-prototype/index.html','phase2/public/service-catalogue.html','phase2/public/customer.html'].includes(relative))body=Buffer.from(body.toString().replace('<html ','<html data-vii-ux-final ').replace('</head>','<link rel="stylesheet" href="/vii-final.css"></head>'));
      reply.type(types[extname(file)]||'application/octet-stream').header('Cache-Control','no-store');return body;
    }catch{fail(404,'Not found.');}
  });
  app.addHook('onClose',async()=>base.close());await app.ready();return app;
}
