import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {defaultCleaningSettings,cleaningPrice,cleaningCoverage,createCleaningRequest} from '../viicasa-backend/src/cleaning.js';
import {buildApp} from '../viicasa-backend/src/app.js';
import {configFromEnv} from '../viicasa-backend/src/config.js';
import {hash,token} from '../viicasa-backend/src/lib.js';
import {afterMinutes} from '../viicasa-backend/src/firestore-store.js';
import {cleaningUI} from '../viicasa-frontend-prototype/cleaning-ui.js';
const routine={service:'routine',frequency:'weekly',hours:1,full_clean:false,extras:[]};
const deep={service:'deep',deep_type:'moveout',measure:'sqft',size:700,full_clean:false,extras:[]};
const address={street:'123 Example Street',city:'Kelowna',state:'BC',country:'CA',postal_code:'V1Y 1A1'};
const payload={selection:routine,address,customer:{name:'QA Customer',email:'cleaning@example.invalid',phone:'+12505550123',consent:true},schedule:{days:['mon','fri'],window:'morning'},focus:['bedroom','kitchen'],locale:'en',marketing:false,settings_revision:1,pricing_version:2};
test('routine: hourly rate × duration × unique days, one cycle without automatic doubling',()=>{for(const hours of [1,2,3])for(const frequency of ['weekly','biweekly'])for(let count=1;count<=7;count++){const q=cleaningPrice({...routine,hours,frequency},defaultCleaningSettings(),{days:['mon','tue','wed','thu','fri','sat','sun'].slice(0,count)});assert.equal(q.total_minor,9999*hours*count);assert.equal(q.billing.visits,count);assert.equal(q.billing.scope,'one_cycle');assert.equal(q.billing.total_hours,hours*count);assert.equal(q.pricing_version,2);}});
test('routine rejects absent, empty, repeated and invalid chargeable days',()=>{for(const days of [undefined,[],['mon','mon'],['holiday'],['mon','tue','wed','thu','fri','sat','sun','mon']])assert.throws(()=>cleaningPrice(routine,defaultCleaningSettings(),{days}));});
test('deep: included thresholds, excess square feet and rooms follow the PDF',()=>{const s=defaultCleaningSettings();for(const size of [1,699,700,701,1000])assert.equal(cleaningPrice({...deep,size},s).total_minor,35000+Math.max(0,size-700)*25);for(const size of [1,3,4,8])assert.equal(cleaningPrice({...deep,measure:'rooms',size},s).total_minor,35000+Math.max(0,size-3)*7500);assert.equal(cleaningPrice(deep,s,payload.schedule).total_minor,35000);assert.equal(cleaningPrice(deep,s,payload.schedule).billing.scope,'one_visit');});
test('receipts show cycle breakdown in both languages but keep historic single visits',()=>{
  for(const lang of ['es','en']){
    const ui=cleaningUI({L:(es,en)=>lang==='en'?en:es,esc:String,money:(n,c)=>(n/100).toFixed(2)+' '+c});
    const quote=cleaningPrice({...routine,hours:2},defaultCleaningSettings(),{days:['mon','wed','fri']});
    const html=ui.receipt({...payload,quote});assert.match(html,/99.99 CAD \/ h × 2 h × 3/);assert.match(html,/599.94 CAD/);
    const {billing,pricing_version,...legacy}=quote;const old=ui.receipt({...payload,payment_scope:'one_visit',quote:legacy});assert.doesNotMatch(old,/visits per cycle|visitas por ciclo/);assert.match(old,lang==='en'?/One visit;/:/Una visita;/);
  }
});
test('full clean is a priced move-out extra; in-person estimates add no invented price',()=>{for(const area of [1,499,500,501,900]){const q=cleaningPrice({...deep,full_clean:true,full_clean_sqft:area,extras:['setup','removals']},defaultCleaningSettings());assert.equal(q.total_minor,135000+Math.max(0,area-500)*100);assert.deepEqual(q.estimate_pending,['setup','removals']);}});
test('incompatible choices, missing measures and huge/fractional values are rejected',()=>{for(const selection of [{...routine,hours:0},{...routine,hours:4},{...routine,size:10},{...routine,extras:['setup']},{...deep,size:1.5},{...deep,measure:'rooms',size:101},{...deep,deep_type:'seasonal',full_clean:true},{...deep,full_clean:true},{...deep,full_clean_sqft:500}])assert.throws(()=>cleaningPrice(selection,defaultCleaningSettings()));});
test('coverage defaults to Canada; postal restriction and unconfigured states fail safely',()=>{const s=defaultCleaningSettings();assert.equal(cleaningCoverage(address,s),'inside');assert.equal(cleaningCoverage({...address,country:'US',postal_code:'10001'},s),'outside');assert.throws(()=>cleaningCoverage({...address,postal_code:'bad'},s));assert.equal(cleaningCoverage(address,{...s,coverage_mode:'postal'}),'unconfigured');assert.equal(cleaningCoverage(address,{...s,coverage_mode:'postal',postal_prefixes:['V1Y']}),'inside');assert.equal(cleaningCoverage(address,{...s,coverage_mode:'postal',postal_prefixes:['M5V']}),'outside');});
test('administrator determines currency and tariff; there is no FX conversion',()=>{const s={...defaultCleaningSettings(),currency:'USD',hourly_minor:12000};const q=cleaningPrice(routine,s,payload.schedule);assert.equal(q.total_minor,24000);assert.equal(q.currency,'USD');assert.equal(q.billing.hourly_minor,12000);assert.equal(defaultCleaningSettings().enabled,false);});

test('cleaning HTTP, Firestore, payment and access controls',{skip:!process.env.TEST_FIRESTORE_HOST},async t=>{
 const config=configFromEnv({DATABASE_DRIVER:'firestore',FIREBASE_MODE:'emulator',FIREBASE_PROJECT_ID:'demo-clean-'+randomUUID().slice(0,8),FIRESTORE_EMULATOR_HOST:process.env.TEST_FIRESTORE_HOST,PAYMENT_PROVIDER:'demo',MAIL_MODE:'outbox',ADMIN_EMAIL:'admin@example.invalid'});
 const app=await buildApp(config,{logger:false,testing:true}),store=app.store;
 const ok=(r,status=200)=>{assert.equal(r.statusCode,status,r.body);return r.statusCode===204?null:r.json();};
 const guest=ok(await app.inject({method:'POST',url:'/v1/guest-sessions'}),201),other=ok(await app.inject({method:'POST',url:'/v1/guest-sessions'}),201);
 const admin=token(),uid=randomUUID();await store.set('users',uid,{name:'QA',email:'admin@example.invalid',role:'admin',active:true,auth_version:1});await store.set('sessions',hash(admin),{user_id:uid,auth_version:1,expires_at:afterMinutes(15)});
 const req=(url,body,secret=guest.token,method=body?'POST':'GET',idem=randomUUID())=>app.inject({url:'/v1'+url,method,remoteAddress:secret===other.token?'127.0.0.2':'127.0.0.1',headers:{authorization:'Bearer '+secret,'idempotency-key':idem},...(body?{payload:body}:{})});
 let checkout,requestId,paidInput,paidIdem;
 try{
 await t.test('only admin can configure prices and country; optimistic revision prevents overwrite',async()=>{
   ok(await req('/admin/cleaning/settings'),401);const c=ok(await req('/admin/cleaning/settings',null,admin));assert.equal(c.country,'CA');
   ok(await req('/admin/cleaning/settings',{...c,enabled:true},admin,'PUT'),400);
   ok(await req('/admin/cleaning/settings',{...c,enabled:true,pricing_confirmed:true},admin,'PUT'));
   ok(await req('/admin/cleaning/settings',{...c,enabled:true,pricing_confirmed:true},admin,'PUT'),409);
 });
 await t.test('quote is server-priced; tampering and incomplete schedules cannot enter checkout',async()=>{
   ok(await req('/cleaning/quote',{selection:routine,address}),400);
   ok(await req('/cleaning/quote',{selection:routine,address,schedule:{days:['mon','mon'],window:'morning'}}),400);
   const q=ok(await req('/cleaning/quote',{selection:routine,address,schedule:payload.schedule}));assert.equal(q.total_minor,19998);assert.equal(q.can_pay,true);
   ok(await req('/cleaning/requests',{...payload,total_minor:1}),400);
   ok(await req('/cleaning/requests',{...payload,schedule:{days:[],window:'morning'}}),400);
   ok(await req('/cleaning/requests',{...payload,focus:['bedroom','bedroom']}),400);
   ok(await req('/cleaning/requests',{...payload,selection:{...routine,extras:['setup']}}),400);
   ok(await req('/cleaning/requests',{...payload,settings_revision:0}),409);
 });
 await t.test('concurrent retry creates a single cleaning checkout and preserves totals and extras',async()=>{
   const input={...payload,selection:{...deep,full_clean:true,full_clean_sqft:501,extras:['setup','decoration']}},idem=randomUUID();
   paidInput=input;paidIdem=idem;
   const [a,b]=await Promise.all([req('/cleaning/requests',input,guest.token,'POST',idem),req('/cleaning/requests',input,guest.token,'POST',idem)]);const x=ok(a,201),y=ok(b,201);checkout=x.checkout;requestId=x.request.id;
   assert.equal(checkout.id,y.checkout.id);assert.equal(checkout.total_minor,135100);assert.equal(checkout.kind,'cleaning');assert.equal(checkout.currency,'CAD');assert.equal(checkout.detail.followup_status,'estimate_pending');assert.equal(await store.count('checkouts'),1);
   ok(await req('/cleaning/requests',{...input,marketing:true},guest.token,'POST',idem),409);
   ok(await req('/checkouts/'+checkout.id,null,other.token),404);
   ok(await req('/admin/cleaning/requests/'+requestId,{followup_status:'contacted',notes:''},admin,'PATCH'),409);
 });
 await t.test('outside-area requests enqueue both notices but never create a payment',async()=>{
   const input={...payload,address:{...address,country:'US',postal_code:'10001'}},idem=randomUUID();const r=ok(await req('/cleaning/requests',input,guest.token,'POST',idem),201);assert.equal(r.checkout,null);assert.equal(r.request.status,'outside_area');await req('/cleaning/requests',input,guest.token,'POST',idem);assert.equal(await store.count('checkouts'),1);assert.equal(await store.count('mail_outbox'),2);const mails=await store.list('mail_outbox');assert.ok(mails.some(m=>m.body.includes('/shop')));
 });
 await t.test('marketing preference is optional, owner scoped and can be withdrawn',async()=>{
   assert.equal(ok(await req('/cleaning/preferences')).marketing,false);ok(await req('/cleaning/preferences',{marketing:true},guest.token,'PUT'));assert.equal(ok(await req('/cleaning/preferences')).marketing,true);assert.equal(ok(await req('/cleaning/preferences',null,other.token)).marketing,false);ok(await req('/cleaning/preferences',{marketing:false},guest.token,'PUT'));assert.equal(ok(await req('/cleaning/preferences')).marketing,false);
 });
 await t.test('payment confirmation is required, duplicate event is safe, receipt and follow-up work',async()=>{
   const p=ok(await req('/checkouts/'+checkout.id+'/payment',{}));assert.equal(p.amount_minor,135100);
   const event={event_id:randomUUID(),outcome:'paid'};ok(await req('/admin/payments/'+p.id+'/simulate',event,admin));ok(await req('/admin/payments/'+p.id+'/simulate',event,admin));
   assert.equal(ok(await req('/checkouts/'+checkout.id)).status,'confirmed');assert.equal(await store.count('mail_outbox'),4);
   ok(await req('/admin/cleaning/requests/'+requestId,{followup_status:'visit_scheduled',notes:'QA appointment'},admin,'PATCH'));
   const rows=ok(await req('/admin/cleaning/requests',null,admin));assert.equal(rows.items.find(r=>r.id===requestId).payment_status,'confirmed');assert.equal(rows.items.find(r=>r.id===requestId).followup_status,'visit_scheduled');assert.equal(rows.items[0].guest_id,undefined);
   const retry=await createCleaningRequest(store,config,guest.id,paidIdem,paidInput);assert.equal(retry.request.notes,undefined);assert.equal(retry.request.guest_id,undefined);assert.equal(retry.checkout.status,'confirmed');
 });
 await t.test('routine cycle checkout, payment and email retain the same server-calculated total',async()=>{
   const input={...payload,selection:{...routine,hours:2,frequency:'biweekly'},schedule:{days:['mon','wed','fri'],window:'morning'}};
   const {pricing_version,...stale}=input;ok(await req('/cleaning/requests',stale,other.token),400);
   ok(await req('/cleaning/requests',{...input,pricing_version:1},other.token),400);
   const q=ok(await req('/cleaning/quote',{selection:input.selection,address,schedule:input.schedule}));assert.equal(q.total_minor,59994);
   const r=ok(await req('/cleaning/requests',input,other.token),201);assert.equal(r.checkout.total_minor,q.total_minor);assert.equal(r.checkout.due_minor,59994);assert.equal(r.checkout.detail.payment_scope,'one_cycle');assert.equal(r.checkout.detail.quote.billing.visits,3);
   const p=ok(await req('/checkouts/'+r.checkout.id+'/payment',{},other.token));assert.equal(p.amount_minor,59994);
   ok(await req('/admin/payments/'+p.id+'/simulate',{event_id:randomUUID(),outcome:'paid'},admin));
   const mails=await store.list('mail_outbox');assert.ok(mails.some(m=>m.body.includes(r.checkout.id)&&m.body.includes('99.99 CAD/h × 2 h × 3 visits')&&m.body.includes('599.94 CAD')));
   const c=ok(await req('/admin/cleaning/settings',null,admin));delete c.id;ok(await req('/admin/cleaning/settings',{...c,currency:'USD',hourly_minor:12000},admin,'PUT'));
   ok(await req('/cleaning/requests',input,other.token),409);
   const fresh=ok(await req('/cleaning/quote',{selection:input.selection,address,schedule:input.schedule}));assert.equal(fresh.currency,'USD');assert.equal(fresh.total_minor,72000);
   const paid=ok(await req('/checkouts/'+r.checkout.id,null,other.token));assert.equal(paid.currency,'CAD');assert.equal(paid.total_minor,59994);
 });
 await t.test('production requires a verified social account and never trusts a typed email for login',async()=>{
   await assert.rejects(createCleaningRequest(store,{...config,production:true},guest.id,randomUUID(),payload),e=>e.statusCode===401);
   const row=await store.get('guests',guest.id);await store.set('guests',guest.id,{...row,firebase_uid:'qa-only',email:'verified@example.invalid'});
   await assert.rejects(createCleaningRequest(store,{...config,production:true},guest.id,randomUUID(),payload),e=>e.statusCode===400);
 });
 }finally{await app.close();}
});
