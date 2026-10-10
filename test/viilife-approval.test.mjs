import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {defaultCleaningSettings,createCleaningRequest} from '../viicasa-backend/src/cleaning.js';
import {liveViiLifeQuote} from '../viicasa-backend/src/viilife-live.js';
import {reviewViiLifeRequest} from '../viicasa-backend/src/viilife-approval.js';
import {startPayment,settlePayment,deliverMail} from '../viicasa-backend/src/firestore-payments.js';
import {expireHolds} from '../viicasa-backend/src/firestore-commerce.js';
import {now,afterMinutes} from '../viicasa-backend/src/firestore-store.js';
import {buildFirestoreApp} from '../viicasa-backend/src/firestore-app.js';
import {configFromEnv} from '../viicasa-backend/src/config.js';
import {hash} from '../viicasa-backend/src/lib.js';

function memoryStore(){
  let data=new Map(),tail=Promise.resolve();
  const clone=v=>v==null?v:structuredClone(v);
  const ops=map=>({get:async(c,k)=>clone(map.get(c+'/'+k)||null),put:(c,k,v)=>map.set(c+'/'+k,clone({...v,id:k})),create:(c,k,v)=>{assert.ok(!map.has(c+'/'+k),'duplicate create');map.set(c+'/'+k,clone({...v,id:k}));},remove:(c,k)=>map.delete(c+'/'+k),list:async(c,o={})=>[...map.entries()].filter(([k,r])=>k.startsWith(c+'/')&&(o.where||[]).every(([f,op,v])=>op==='=='?r[f]===v:op==='in'?v.includes(r[f]):op==='<='?r[f]<=v:true)).map(([,v])=>clone(v)).slice(0,o.limit||100)});
  return {get:(...a)=>ops(data).get(...a),set:(...a)=>ops(data).put(...a),list:(...a)=>ops(data).list(...a),count:async(c,where)=>(await ops(data).list(c,{where})).length,transaction:fn=>{const run=tail.then(async()=>{const next=structuredClone(data),value=await fn(ops(next));data=next;return value;});tail=run.catch(()=>{});return run;}};
}
const config=configFromEnv({DATABASE_DRIVER:'firestore',FIREBASE_MODE:'emulator',FIREBASE_PROJECT_ID:'demo-approval',PAYMENT_PROVIDER:'stripe',STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',VIILIFE_MODE:'live',PUBLIC_SITE_URL:'https://test.example.invalid',ADMIN_EMAIL:'team@example.invalid'});
const input={selection:{service:'routine',frequency:'weekly',hours:4,full_clean:false,extras:[]},schedule:{days:['mon'],start_date:new Date(Date.now()+7*86400000).toISOString().slice(0,10),start_hour:8},address:{street:'123 Example',city:'Kelowna',state:'BC',country:'CA',postal_code:'V1Y 1A1'},customer:{name:'Test Customer',email:'buyer@example.invalid',phone:'+12505550123',consent:true},locale:'en',settings_revision:1,pricing_version:2,focus:[],marketing:false};
async function setup(){const store=memoryStore();await store.set('cleaning_settings','main',{...defaultCleaningSettings(),enabled:true,pricing_confirmed:true,revision:1});await store.set('guests','owner',{firebase_uid:'verified-test-user',email:input.customer.email,expires_at:afterMinutes(60)});return store;}
const create=(store,body=input)=>createCleaningRequest(store,config,'owner',randomUUID(),body,liveViiLifeQuote);
const gateway={provider:'stripe',create:async p=>({reference:'cs_test_'+p.id,url:'https://checkout.stripe.com/test-fixture'})};

test('large request waits without expiring, notifies customer/team once, contact does not unlock payment',async()=>{
  const store=await setup(),idem=randomUUID(),row=await createCleaningRequest(store,config,'owner',idem,input,liveViiLifeQuote);
  const again=await createCleaningRequest(store,config,'owner',idem,input,liveViiLifeQuote);assert.equal(again.checkout.id,row.checkout.id);
  assert.equal(row.checkout.status,'awaiting_approval');assert.equal(row.checkout.expires_at,null);
  await expireHolds(store);assert.equal((await store.get('checkouts',row.checkout.id)).status,'awaiting_approval');
  const mails=await store.list('mail_outbox');assert.equal(mails.length,2);assert.deepEqual(mails.map(m=>m.recipient).sort(),['buyer@example.invalid','team@example.invalid']);
  assert.ok(mails.every(m=>!m.html.includes('Payment receipt')));assert.ok(mails.some(m=>m.body.includes('https://test.example.invalid/admin')));
  await reviewViiLifeRequest(store,config,row.request.id,'admin',{action:'contact',contacted:true,notes:'Called'});
  assert.equal((await store.get('cleaning_requests',row.request.id)).contacted,true);
  await assert.rejects(startPayment(store,config,gateway,'owner',row.checkout.id),e=>e.statusCode===409);
  assert.equal(await store.count('payments'),0);
});

test('approval queues one customer link, Stripe remains owner-only, paid orders cannot be approved/cancelled again',async()=>{
  const store=await setup(),row=await create(store);
  await Promise.all([1,2].map(()=>reviewViiLifeRequest(store,config,row.request.id,'admin',{action:'approve'})));
  const c=await store.get('checkouts',row.checkout.id);assert.equal(c.status,'pending');assert.ok(Date.parse(c.expires_at)>Date.now()+23*3600000);
  const ready=(await store.list('mail_outbox')).filter(m=>m.subject.includes('ready for payment'));assert.equal(ready.length,1);assert.equal(ready[0].recipient,input.customer.email);assert.ok(ready[0].html.includes('https://test.example.invalid/cuenta#viilife-orders'));assert.ok(ready[0].body.includes('Nothing')===false);
  await assert.rejects(startPayment(store,config,gateway,'other',c.id),e=>e.statusCode===404);
  const payment=await startPayment(store,config,gateway,'owner',c.id);
  await assert.rejects(reviewViiLifeRequest(store,config,row.request.id,'admin',{action:'cancel'}),e=>e.statusCode===409);
  const event={provider:'stripe',id:'evt_fixture',reference:'cs_test_'+c.id,outcome:'paid',amount:payment.amount_minor,currency:payment.currency};
  await settlePayment(store,config,event);await settlePayment(store,config,event);
  assert.equal((await store.get('checkouts',c.id)).status,'confirmed');assert.equal(await store.count('mail_outbox'),5);
  for(const action of ['approve','cancel'])await assert.rejects(reviewViiLifeRequest(store,config,row.request.id,'admin',{action}),e=>e.statusCode===409);
  const sent=[];const delivered=await deliverMail(store,{...config,mailMode:'smtp'},{sendMail:async m=>{sent.push(m);return {accepted:[m.to]};}});assert.equal(delivered.sent,5);assert.equal(sent.filter(m=>m.to===input.customer.email).length,3);
});

test('cancellation is idempotent and never enables a payment or sends a ready-to-pay email',async()=>{
  const store=await setup(),row=await create(store);
  for(let i=0;i<2;i++)await reviewViiLifeRequest(store,config,row.request.id,'admin',{action:'cancel'});
  assert.equal((await store.get('checkouts',row.checkout.id)).status,'cancelled');assert.equal(await store.count('mail_outbox'),3);
  await assert.rejects(reviewViiLifeRequest(store,config,row.request.id,'admin',{action:'approve'}),e=>e.statusCode===409);
  await assert.rejects(startPayment(store,config,gateway,'owner',row.checkout.id),e=>e.statusCode===409);
  assert.ok((await store.list('mail_outbox')).every(m=>!m.subject.includes('ready for payment')));
});

test('boundary 3h x 3 days pays directly; either >3 hours or >3 days requires approval',async()=>{
  for(const [hours,days,expected]of [[3,['mon','tue','wed'],'pending'],[4,['mon'],'awaiting_approval'],[1,['mon','tue','wed','thu'],'awaiting_approval']]){
    const store=await setup(),row=await create(store,{...input,selection:{...input.selection,hours},schedule:{...input.schedule,days}});
    assert.equal(row.checkout.status,expected);if(expected==='pending'){assert.equal(await store.count('mail_outbox'),0);assert.ok(await startPayment(store,config,gateway,'owner',row.checkout.id));}
  }
});

test('approval with dates in the past is rejected without changes or email',async()=>{
  const store=await setup(),row=await create(store),c=await store.get('checkouts',row.checkout.id);
  await store.set('checkouts',c.id,{...c,detail:{...c.detail,quote:{...c.detail.quote,dates:['2000-01-01']}}});
  await assert.rejects(reviewViiLifeRequest(store,config,row.request.id,'admin',{action:'approve'}),e=>e.statusCode===409);
  assert.equal((await store.get('checkouts',c.id)).status,'awaiting_approval');assert.equal(await store.count('mail_outbox'),2);
});

test('review HTTP endpoint requires admin, validates actions, and cannot be used by customers',async()=>{
  const store=await setup(),row=await create(store);
  for(const role of ['admin','viewer','support']){await store.set('users',role,{role,active:true,auth_version:1});await store.set('sessions',hash(role.padEnd(43,'x')),{user_id:role,auth_version:1,expires_at:afterMinutes(30)});}
  const app=await buildFirestoreApp(config,{store,logger:false,testing:true,gateway});
  try{const request=(role,body)=>app.inject({method:'POST',url:'/v1/admin/cleaning/requests/'+row.request.id+'/review',headers:role?{authorization:'Bearer '+role.padEnd(43,'x')}:{},payload:body});
    assert.equal((await request(null,{action:'approve'})).statusCode,401);
    for(const role of ['viewer','support'])assert.equal((await request(role,{action:'approve'})).statusCode,403);
    assert.equal((await request('admin',{action:'paid'})).statusCode,400);
    const result=await request('admin',{action:'approve'});assert.equal(result.statusCode,200,result.body);
  }finally{await app.close();}
});
