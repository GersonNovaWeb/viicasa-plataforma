import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../viicasa-backend/src/app.js';
import {configFromEnv} from '../viicasa-backend/src/config.js';
import {demoSettings,demoQuote,createDemoRequest,completeDemoRequest,maintainViiLifeDemo,demoRecipient,demoMailReady} from '../viicasa-backend/src/viilife-demo.js';
import {createCleaningRequest} from '../viicasa-backend/src/cleaning.js';
import {startPayment} from '../viicasa-backend/src/firestore-payments.js';
import {hash,token} from '../viicasa-backend/src/lib.js';
import {afterMinutes} from '../viicasa-backend/src/firestore-store.js';
const input={selection:{service:'routine',frequency:'weekly',hours:3,full_clean:false,extras:[]},schedule:{days:['mon','tue','wed','thu','fri'],start_date:new Date(Date.now()+86400000).toISOString().slice(0,10),start_hour:8},address:{street:'123 Demo Street',city:'Kelowna',state:'BC',country:'CA',postal_code:'V1Y 1A1'},customer:{name:'Demo Customer',email:'customer@example.invalid',phone:'+12505550123',consent:true},locale:'en',settings_revision:0};
const baseConfig=configFromEnv({DATABASE_DRIVER:'firestore',FIREBASE_MODE:'emulator',FIREBASE_PROJECT_ID:'demo-viilife-tests-'+randomUUID().slice(0,8),FIRESTORE_EMULATOR_HOST:'127.0.0.1:8088',PAYMENT_PROVIDER:'disabled',MAIL_MODE:'outbox',VIILIFE_MODE:'demo'});

test('demo amount, threshold boundaries and real pricing stay separate',async()=>{
  const settings=await demoSettings({get:async()=>null});
  assert.equal(demoQuote(input,settings).total_minor,149985);
  assert.equal(demoQuote(input,settings).large,true);
  assert.equal(demoQuote({...input,schedule:{...input.schedule,days:['mon','wed','fri']}},settings).large,false);
  assert.equal(demoQuote({...input,selection:{...input.selection,hours:4},schedule:{...input.schedule,days:['mon']}},settings).large,true);
  assert.equal(demoQuote({...input,selection:{...input.selection,frequency:'biweekly'}},settings).total_minor,149985);
  assert.equal(demoQuote(input,{...settings,currency:'USD',hourly_minor:12000}).total_minor,180000);
  for(const start_date of ['2025-01-01','2027-02-30','9999-01-01'])assert.throws(()=>demoQuote({...input,schedule:{...input.schedule,start_date}},settings));
  assert.throws(()=>demoQuote({...input,schedule:{...input.schedule,start_hour:18}},settings));
  assert.throws(()=>demoQuote({...input,selection:{...input.selection,hours:9}},settings));
  assert.equal(demoQuote({...input,address:{...input.address,country:'US',postal_code:'90210'}},settings).can_pay,false);
});

test('isolated ViiLife demo end-to-end, ownership, SMTP and payment safety',async t=>{
  const app=await buildApp(baseConfig,{logger:false,testing:true}),store=app.store;
  const req=(path,body,auth,method=body===undefined?'GET':'POST',idem=randomUUID())=>app.inject({method,url:'/v1'+path,headers:{...(auth?{authorization:'Bearer '+auth}:{}),'idempotency-key':idem},...(body===undefined?{}:{payload:body})});
  const ok=(r,code=200)=>{assert.equal(r.statusCode,code,r.body);return r.json();};
  try{
    const guest=ok(await req('/guest-sessions',{}),201),other=ok(await req('/guest-sessions',{}),201);
    const userId=randomUUID(),admin=token();await store.set('users',userId,{role:'admin',active:true,auth_version:1});await store.set('sessions',hash(admin),{user_id:userId,auth_version:1,expires_at:afterMinutes(10)});
    let row;
    await t.test('anonymous admin access denied and payload spoofing rejected',async()=>{
      ok(await req('/admin/viilife-demo'),401);
      ok(await req('/viilife-demo/requests',input),401);
      ok(await req('/viilife-demo/requests',{...input,total_minor:1},guest.token),400);
      ok(await req('/viilife-demo/requests',{...input,recipient:'attacker@example.com'},guest.token),400);
    });
    await t.test('creating a large request never invokes Stripe or needs admin approval',async()=>{
      const idem=randomUUID(),responses=await Promise.all([req('/viilife-demo/requests',input,guest.token,'POST',idem),req('/viilife-demo/requests',input,guest.token,'POST',idem)]);
      row=ok(responses[0],201);assert.equal(ok(responses[1],201).id,row.id);assert.equal(row.quote.total_minor,149985);assert.equal(row.status,'awaiting_payment');assert.equal(row.guest_id,undefined);
      assert.equal(await store.count('checkouts'),0);assert.equal(await store.count('payments'),0);assert.equal(await store.count('mail_outbox'),0);assert.equal(await store.count('viilife_demo_mail'),2);
      ok(await req('/viilife-demo/requests/'+row.id,undefined,other.token),404);
      ok(await req('/viilife-demo/requests/'+row.id+'/pay',{confirm:true},other.token),404);
      ok(await req('/checkouts/'+row.id+'/payment',{},guest.token),503);
      assert.equal(ok(await req('/viilife-demo/requests',undefined,guest.token)).items[0].id,row.id);
    });
    await t.test('follow-up and immutable quote survive admin settings changes',async()=>{
      ok(await req('/admin/viilife-demo/requests/'+row.id,{followup_status:'contacted',notes:'Private demo note'},admin,'PATCH'));
      assert.equal(ok(await req('/viilife-demo/requests/'+row.id,undefined,guest.token)).notes,undefined);
      assert.equal(ok(await req('/admin/viilife-demo',undefined,admin)).items[0].notes,'Private demo note');
      ok(await req('/admin/viilife-demo/settings',{revision:0,currency:'USD',hourly_minor:12000,large_hours:4,large_days:4},admin,'PUT'));
      await assert.rejects(createDemoRequest(store,guest.id,randomUUID(),input),e=>e.statusCode===409);
      assert.equal(ok(await req('/viilife-demo/requests/'+row.id,undefined,guest.token)).quote.total_minor,149985);
      assert.equal(await store.get('cleaning_settings','main'),null);
    });
    await t.test('customer completes payment simulation twice with no duplicated email',async()=>{
      const results=await Promise.all([completeDemoRequest(store,guest.id,row.id),completeDemoRequest(store,guest.id,row.id)]);
      results.forEach(r=>assert.equal(r.status,'demo_paid'));assert.equal(await store.count('viilife_demo_mail'),4);assert.equal(await store.count('payments'),0);
    });
    await t.test('mail transport is isolated and all messages are forced to approved mailbox',async()=>{
      const sent=[];await maintainViiLifeDemo(store,baseConfig,async mail=>sent.push(mail));assert.equal(sent.length,4);assert.ok(sent.every(mail=>mail.recipient===demoRecipient&&mail.subject.startsWith('[DEMO VIILIFE]')));
      await maintainViiLifeDemo(store,baseConfig,async()=>assert.fail('Duplicate send'));
      assert.equal(demoMailReady(baseConfig),false);
      assert.equal(await store.count('cs_contacts'),0);
    });
    await t.test('large incomplete checkout produces one follow-up; paid orders do not',async()=>{
      const unpaid=await createDemoRequest(store,guest.id,randomUUID(),{...input,settings_revision:1});
      const saved=await store.get('viilife_demo_requests',unpaid.id);await store.set('viilife_demo_requests',unpaid.id,{...saved,created_at:new Date(Date.now()-3700000).toISOString()});
      await maintainViiLifeDemo(store,baseConfig);
      let mail=(await store.list('viilife_demo_mail')).filter(m=>m.subject.includes('Follow-up needed'));assert.equal(mail.length,1);
      await maintainViiLifeDemo(store,baseConfig);mail=(await store.list('viilife_demo_mail')).filter(m=>m.subject.includes('Follow-up needed'));assert.equal(mail.length,1);
      await completeDemoRequest(store,guest.id,unpaid.id);const sent=[];await maintainViiLifeDemo(store,baseConfig,async m=>sent.push(m));assert.ok(!sent.some(m=>m.subject.includes('Follow-up needed')));
    });
    await t.test('SMTP uncertainty is not retried and quota leaves emails pending',async()=>{
      await createDemoRequest(store,other.id,randomUUID(),{...input,settings_revision:1});let calls=0;
      await maintainViiLifeDemo(store,baseConfig,async()=>{calls++;throw Error('Ambiguous delivery');});assert.equal(calls,2);
      await maintainViiLifeDemo(store,baseConfig,async()=>{calls++;});assert.equal(calls,2);
      await store.set('viilife_demo_limits','mail',{sends:Array(90).fill(Date.now())});
      await createDemoRequest(store,other.id,randomUUID(),{...input,settings_revision:1});await maintainViiLifeDemo(store,baseConfig,async()=>assert.fail('Quota exceeded'));
      assert.equal((await store.list('viilife_demo_mail',{where:[['state','==','pending']]})).length,2);
    });
    await t.test('live cleaning creation and historical real checkout payments are blocked in demo mode',async()=>{
      await assert.rejects(createCleaningRequest(store,baseConfig,guest.id,randomUUID(),{}),e=>e.statusCode===409);
      const realId=randomUUID();await store.set('checkouts',realId,{id:realId,guest_id:guest.id,kind:'cleaning',status:'pending',expires_at:afterMinutes(30)});
      await assert.rejects(startPayment(store,{...baseConfig,paymentProvider:'stripe'},{create:()=>assert.fail('Stripe invoked')},guest.id,realId),e=>e.statusCode===409);
    });
  }finally{await app.close();}
});
