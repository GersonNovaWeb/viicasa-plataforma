import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Stripe from 'stripe';
import {buildApp} from '../viicasa-backend/src/app.js';
import {configFromEnv} from '../viicasa-backend/src/config.js';
import {defaultCleaningSettings,createCleaningRequest} from '../viicasa-backend/src/cleaning.js';
import {liveViiLifeQuote,maintainViiLifeLive} from '../viicasa-backend/src/viilife-live.js';
import {deliverMail} from '../viicasa-backend/src/firestore-payments.js';
import {paymentGateway} from '../viicasa-backend/src/payments.js';
import {emailLoginForm} from '../viicasa-frontend-prototype/email-auth-ui.js';
import {cleaningUI} from '../viicasa-frontend-prototype/cleaning-ui.js';
import {hash,token} from '../viicasa-backend/src/lib.js';
import {afterMinutes} from '../viicasa-backend/src/firestore-store.js';

const input={selection:{service:'routine',frequency:'weekly',hours:3,full_clean:false,extras:[]},schedule:{days:['mon','tue','wed','thu','fri'],start_date:new Date(Date.now()+86400000).toISOString().slice(0,10),start_hour:8},address:{street:'123 Example Street',city:'Kelowna',state:'BC',country:'CA',postal_code:'V1Y 1A1'},customer:{name:'Local QA',email:'qa@example.invalid',phone:'+12505550123',consent:true},locale:'en',settings_revision:1};
const prices={...defaultCleaningSettings(),revision:1,enabled:true,pricing_confirmed:true};
test('quick live quote is CAD-only and preserves the approved calculation and safety gates',async()=>{
 const store={get:async()=>prices};const q=await liveViiLifeQuote(store,input);assert.equal(q.total_minor,149985);assert.equal(q.currency,'CAD');assert.equal(q.demo,undefined);assert.equal(q.large,true);assert.equal(q.can_pay,true);
 assert.equal((await liveViiLifeQuote(store,{...input,selection:{...input.selection,hours:4},schedule:{...input.schedule,days:['mon']}})).total_minor,39996);
 assert.equal((await liveViiLifeQuote(store,{...input,selection:{...input.selection,frequency:'biweekly'}})).total_minor,149985);
 assert.equal((await liveViiLifeQuote({get:async()=>({...prices,enabled:false})},input)).can_pay,false);
 await assert.rejects(liveViiLifeQuote({get:async()=>({...prices,currency:'USD'})},input),/CAD/);
 await assert.rejects(liveViiLifeQuote(store,{...input,schedule:{...input.schedule,start_hour:18}}),/20:00/);
});
test('email form has login, verified-signup and recovery fields; disabled auth is hidden',()=>{
 const L=(es,en)=>en,html=emailLoginForm(L,true);for(const text of ['type="password"','name="create"','name="consent"','email-reset','autocomplete="current-password"'])assert.ok(html.includes(text));assert.equal(emailLoginForm(L,false),'');assert.ok(!html.includes('Facebook'));
});
test('receipt renders the selected dates and start hour without legacy undefined fields',async()=>{
 const quote=await liveViiLifeQuote({get:async()=>prices},input);
 for(const language of ['en','es']){
  const ui=cleaningUI({L:(es,en)=>language==='en'?en:es,esc:String,money:(n,c)=>(n/100).toFixed(2)+' '+c});
  const html=ui.receipt({...input,quote});assert.ok(html.includes(quote.dates[0]));assert.ok(html.includes('08:00'));assert.ok(html.includes('1499.85 CAD'));assert.ok(!html.includes('undefined'));
 }
});
test('maintenance never contacts unpaid customers or scans abandoned orders',async()=>{
 const store=new Proxy({},{get:()=>()=>assert.fail('No unpaid follow-up work allowed')});
 await maintainViiLifeLive(store,{viilifeMode:'live'});
});

test('ViiLife live flow: persistence, ownership, signed webhook, receipt and large-order follow-up',{skip:!process.env.TEST_FIRESTORE_HOST},async t=>{
 const config=configFromEnv({DATABASE_DRIVER:'firestore',FIREBASE_MODE:'emulator',FIREBASE_PROJECT_ID:'demo-live-flow-'+randomUUID().slice(0,8),FIRESTORE_EMULATOR_HOST:process.env.TEST_FIRESTORE_HOST,PAYMENT_PROVIDER:'stripe',STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',MAIL_MODE:'outbox',VIILIFE_MODE:'live',ADMIN_EMAIL:'team@example.invalid'});
 const realVerifier=paymentGateway(config);let gatewayCalls=0;
 const gateway={provider:'stripe',create:async p=>{gatewayCalls++;return {reference:'cs_test_'+p.id,url:'https://checkout.stripe.com/test-fixture'};},verify:realVerifier.verify};
 let app=await buildApp(config,{logger:false,testing:true,gateway}),store=app.store;
 const req=(path,body,secret,method=body===undefined?'GET':'POST',idem=randomUUID())=>app.inject({method,url:'/v1'+path,headers:{...(secret?{authorization:'Bearer '+secret}:{}),'idempotency-key':idem},...(body===undefined?{}:{payload:body})});
 const ok=(r,code=200)=>{assert.equal(r.statusCode,code,r.body);return r.json();};
 let first,guest,other,payment;
 const admin=token(),adminId=randomUUID();
 try{
  await store.set('cleaning_settings','main',prices);
  await store.set('users',adminId,{name:'QA Admin',email:'team@example.invalid',role:'admin',active:true,auth_version:1});
  await store.set('sessions',hash(admin),{user_id:adminId,auth_version:1,expires_at:afterMinutes(15)});
  guest=ok(await req('/guest-sessions',{}),201);other=ok(await req('/guest-sessions',{}),201);
  await store.set('cleaning_preferences',guest.id,{marketing:true});
  await t.test('large requests save before payment and do not need admin approval',async()=>{
   const idem=randomUUID();first=ok(await req('/viilife/requests',input,guest.token,'POST',idem),201);
   assert.equal(ok(await req('/viilife/requests',input,guest.token,'POST',idem),201).checkout.id,first.checkout.id);
   assert.equal(first.checkout.total_minor,149985);assert.equal(first.request.flow,'quick');assert.equal(first.request.guest_id,undefined);
   assert.equal((await store.get('cleaning_preferences',guest.id)).marketing,true);
   assert.equal(await store.count('mail_outbox'),0);assert.equal(await store.count('viilife_demo_requests'),0);assert.equal(await store.count('properties'),0);
   ok(await req('/admin/cleaning/requests/'+first.request.id,{followup_status:'contacted',notes:''},admin,'PATCH'),409);
   ok(await req('/viilife/requests',{...input,total_minor:1},guest.token),400);
   ok(await req('/viilife/requests',{...input,customer:{...input.customer,consent:false}},guest.token),400);
   ok(await req('/viilife/requests',input),401);
  });
  await t.test('other customers cannot read, pay or cancel the checkout',async()=>{
   for(const [suffix,body]of [['',undefined],['/payment',{}],['/cancel',{}]])ok(await req('/checkouts/'+first.checkout.id+suffix,body,other.token),404);
   payment=ok(await req('/checkouts/'+first.checkout.id+'/payment',{},guest.token));assert.equal(payment.amount_minor,149985);
   ok(await req('/checkouts/'+first.checkout.id+'/payment',{},guest.token));assert.equal(gatewayCalls,1);
  });
  await t.test('signed Stripe event confirms the order once and queues both HTML receipts',async()=>{
   const p=await store.get('payments',first.checkout.id);
   const event={id:'evt_'+randomUUID(),type:'checkout.session.completed',data:{object:{id:p.reference,payment_status:'paid',amount_total:149985,currency:'cad'}}};
   const send=async(e,signature)=>{const payload=JSON.stringify(e);return app.inject({method:'POST',url:'/v1/webhooks/stripe',headers:{'content-type':'application/json','stripe-signature':signature||Stripe.webhooks.generateTestHeaderString({payload,secret:config.stripeWebhookSecret})},payload});};
   ok(await send(event,'invalid'),400);assert.equal((await store.get('checkouts',first.checkout.id)).status,'pending');
   ok(await send({...event,id:'evt_wrong',data:{object:{...event.data.object,amount_total:1}}}),409);
   ok(await send({...event,id:'evt_wrong_currency',data:{object:{...event.data.object,currency:'usd'}}}),409);
   ok(await send({...event,id:'evt_not_paid',data:{object:{...event.data.object,payment_status:'unpaid'}}}));assert.equal((await store.get('checkouts',first.checkout.id)).status,'pending');
   ok(await send(event));ok(await send(event));assert.equal((await store.get('checkouts',first.checkout.id)).status,'confirmed');assert.equal(await store.count('mail_outbox'),2);
   const sent=[];const result=await deliverMail(store,{...config,mailMode:'smtp'},{sendMail:async m=>sent.push(m)});assert.equal(result.sent,2);assert.ok(sent.every(m=>m.html.includes('https://viicasa.com/images/logo-email.png')));assert.ok(sent.some(m=>m.text.includes('1499.85 CAD')&&m.html.includes('Demonstration receipt')));
   await deliverMail(store,{...config,mailMode:'smtp'},{sendMail:async()=>assert.fail('Duplicate email')});
   ok(await req('/admin/cleaning/requests/'+first.request.id,{followup_status:'contacted',notes:'Payment verified'},admin,'PATCH'));
  });
  await t.test('restart retains the same checkout and ownership',async()=>{
   await app.close();app=await buildApp(config,{logger:false,testing:true,gateway});store=app.store;
   assert.equal(ok(await req('/checkouts/'+first.checkout.id,undefined,guest.token)).status,'confirmed');ok(await req('/checkouts/'+first.checkout.id,undefined,other.token),404);
  });
  await t.test('large abandoned request creates no team follow-up',async()=>{
   const large=ok(await req('/viilife/requests',input,guest.token),201),row=await store.get('cleaning_requests',large.request.id);
   await store.set('cleaning_requests',row.id,{...row,created_at:new Date(Date.now()-3700000).toISOString()});
   await maintainViiLifeLive(store,config);await maintainViiLifeLive(store,config);
   const followups=(await store.list('mail_outbox')).filter(m=>m.subject.includes('Follow-up needed'));assert.equal(followups.length,0);assert.equal((await store.list('mail_outbox')).filter(m=>m.body.includes(large.checkout.id)).length,0);
  });
  await t.test('production requires authenticated identity and configured final prices',async()=>{
   await assert.rejects(createCleaningRequest(store,{...config,production:true},guest.id,randomUUID(),{...input,pricing_version:2},liveViiLifeQuote),e=>e.statusCode===401);
   await store.set('cleaning_settings','main',{...prices,enabled:false});ok(await req('/viilife/requests',input,guest.token),503);
  });
 }finally{await app.close();}
});
