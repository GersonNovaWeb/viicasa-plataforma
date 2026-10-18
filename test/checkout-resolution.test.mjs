import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {initializeStore,afterMinutes} from '../viicasa-backend/src/firestore-store.js';
import {defaultCleaningSettings,createCleaningRequest} from '../viicasa-backend/src/cleaning.js';
import {liveViiLifeQuote} from '../viicasa-backend/src/viilife-live.js';
import {createBooking} from '../viicasa-backend/src/firestore-commerce.js';
import {installDemoProperties} from '../viicasa-backend/src/demo-properties.js';
import {startPayment,reconcilePayment} from '../viicasa-backend/src/firestore-payments.js';
function memoryStore(){
 let rows=new Map();const clone=v=>v==null?v:structuredClone(v);
 const ops=map=>({get:async(c,k)=>clone(map.get(c+'/'+k)||null),put:(c,k,v)=>map.set(c+'/'+k,clone({...v,id:k})),create:(c,k,v)=>{assert.ok(!map.has(c+'/'+k));map.set(c+'/'+k,clone({...v,id:k}));},remove:(c,k)=>map.delete(c+'/'+k),list:async(c)=>[...map.entries()].filter(([k])=>k.startsWith(c+'/')).map(([,v])=>clone(v))});
 return{get:(...a)=>ops(rows).get(...a),set:(...a)=>ops(rows).put(...a),list:(...a)=>ops(rows).list(...a),transaction:async fn=>{const next=structuredClone(rows),result=await fn(ops(next));rows=next;return result;}};
}
const config={production:true,allowGuestCheckout:true,paymentProvider:'stripe',stripeMode:'test',stripeKey:'sk_test_fixture',viilifeMode:'live',holdMinutes:30,siteUrl:'https://example.invalid',adminEmail:'team@example.invalid'};
const customer={name:'Guest QA',email:'guest@example.invalid',phone:'+12505550123',consent:true};
const input=()=>({selection:{service:'routine',frequency:'weekly',hours:2,full_clean:false,extras:[]},schedule:{days:['mon'],start_date:new Date(Date.now()+7*86400000).toISOString().slice(0,10),start_hour:8},address:{street:'123 Fictional Street',city:'Kelowna',state:'BC',country:'CA',postal_code:'V1Y 1A1'},customer,locale:'en',settings_revision:1,pricing_version:2,focus:[],marketing:false});
async function fixture(){const store=memoryStore();await initializeStore(store);await store.set('guests','buyer',{expires_at:afterMinutes(60)});await store.set('cleaning_settings','main',{...defaultCleaningSettings(),revision:1,enabled:true,pricing_confirmed:true,currency:'CAD',country:'CA'});return store;}
test('production website can explicitly allow a guest without creating a verified identity',async()=>{
 const store=await fixture();
 await assert.rejects(createCleaningRequest(store,{...config,allowGuestCheckout:false},'buyer',randomUUID(),input(),liveViiLifeQuote),e=>e.statusCode===401);
 const r=await createCleaningRequest(store,config,'buyer',randomUUID(),input(),liveViiLifeQuote);
 assert.equal(r.checkout.customer_email,customer.email);assert.equal(r.checkout.currency,'CAD');assert.equal(r.checkout.total_minor,19998);assert.equal((await store.list('users')).length,0);
});
test('sample property allows sandbox deposit but never a live charge, including provider changes',async()=>{
 const store=await fixture();await installDemoProperties(store,'qa');const p=(await store.list('properties'))[0];
 const request={property_id:p.id,currency:'CAD',check_in:new Date(Date.now()+14*86400000).toISOString().slice(0,10),check_out:new Date(Date.now()+18*86400000).toISOString().slice(0,10),guests:2,pay:'deposit',customer};
 const live={...config,stripeMode:'live',stripeKey:'sk_live_fixture'};
 await assert.rejects(createBooking(store,live,'buyer',randomUUID(),request),e=>e.statusCode===409);
 const c=await createBooking(store,config,'buyer',randomUUID(),request);assert.equal(c.detail.is_demo,true);assert.equal(c.currency,'CAD');assert.ok(c.due_minor<c.total_minor);
 await assert.rejects(startPayment(store,live,{provider:'stripe'},'buyer',c.id),e=>e.statusCode===409);
});
test('verified Stripe return settles once, mismatches stay unpaid and completed sessions cannot loop to Stripe',async()=>{
 const store=await fixture(),r=await createCleaningRequest(store,config,'buyer',randomUUID(),input(),liveViiLifeQuote),c=r.checkout;
 let session;
 const gateway={provider:'stripe',create:async(p,c)=>{session={id:'cs_test_'+p.id,client_reference_id:c.id,metadata:{checkout_id:c.id,payment_id:p.id},amount_total:p.amount_minor,currency:'cad',payment_status:'unpaid'};return{reference:session.id,url:'https://checkout.stripe.com/c/test'};},retrieve:async()=>session};
 await startPayment(store,config,gateway,'buyer',c.id);
 await assert.rejects(reconcilePayment(store,config,gateway,'other',c.id),e=>e.statusCode===404);
 await reconcilePayment(store,config,gateway,'buyer',c.id);assert.equal((await store.get('checkouts',c.id)).status,'pending');
 session={...session,payment_status:'paid',amount_total:1};await assert.rejects(reconcilePayment(store,config,gateway,'buyer',c.id),e=>e.statusCode===409);
 session={...session,amount_total:19998};const result=await startPayment(store,config,gateway,'buyer',c.id);
 assert.equal(result.status,'paid');assert.equal(result.checkout_url,null);assert.equal((await store.get('checkouts',c.id)).status,'confirmed');
 const mails=(await store.list('mail_outbox')).length;await reconcilePayment(store,config,gateway,'buyer',c.id);assert.equal((await store.list('mail_outbox')).length,mails);
});
