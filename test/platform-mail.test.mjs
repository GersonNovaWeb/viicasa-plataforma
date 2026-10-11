import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {platformMailConfig as config,shopSample,bookingSample} from './fixtures/platform-mail.mjs';
import {saveSocialCustomer} from '../viicasa-backend/src/customer-registration.js';
import {renderWelcomeMail,renderPurchaseMail,commerceReceiptSnapshot,purchaseMailData} from '../viicasa-backend/src/platform-mail.js';
import {notice,createOrder,createBooking} from '../viicasa-backend/src/firestore-commerce.js';
import {startPayment,settlePayment,deliverMail} from '../viicasa-backend/src/firestore-payments.js';
import {afterMinutes,key} from '../viicasa-backend/src/firestore-store.js';

function memoryStore(){
  let rows=new Map(),tail=Promise.resolve();const clone=v=>v==null?v:structuredClone(v);
  const ops=map=>({get:async(c,k)=>clone(map.get(c+'/'+k)||null),put:(c,k,v)=>map.set(c+'/'+k,clone({...v,id:k})),create:(c,k,v)=>{assert.ok(!map.has(c+'/'+k));map.set(c+'/'+k,clone({...v,id:k}));},remove:(c,k)=>map.delete(c+'/'+k),list:async(c,o={})=>[...map.entries()].filter(([k,r])=>k.startsWith(c+'/')&&(o.where||[]).every(([f,op,v])=>op==='=='?r[f]===v:op==='in'?v.includes(r[f]):op==='<='?r[f]<=v:true)).map(([,v])=>clone(v)).slice(0,o.limit||100)});
  return {get:(...a)=>ops(rows).get(...a),set:(...a)=>ops(rows).put(...a),list:(...a)=>ops(rows).list(...a),transaction:fn=>{const run=tail.then(async()=>{const next=structuredClone(rows),result=await fn(ops(next));rows=next;return result;});tail=run.catch(()=>{});return run;}};
}
test('welcome once per new verified account, not per provider, repeat login or legacy user',async()=>{
  const store=memoryStore();
  for(const [i,provider]of ['google.com','apple.com','password'].entries()){
    const user={uid:'u'+i,name:'Mary',email:`buyer${i}@example.invalid`,email_verified:true,firebase:{sign_in_provider:provider}};
    await Promise.all([1,2].map(n=>saveSocialCustomer(store,user,'CA',`token-${i}-${n}`,config)));
    await saveSocialCustomer(store,{...user,firebase:{sign_in_provider:'apple.com'}},'US','linked-'+i,config);
  }
  assert.equal((await store.list('mail_outbox')).length,3);
  for(const m of await store.list('mail_outbox')){assert.match(m.subject,/Welcome/);assert.match(m.html,/ViiShop.*ViiConcierge.*ViiLife/s);assert.equal(m.receipt,undefined);assert.notEqual(m.recipient,config.adminEmail);}
  await store.set('platform_accounts',key('google','legacy'),{guest_id:'legacy'});
  await saveSocialCustomer(store,{uid:'legacy',email:'old@example.invalid',email_verified:true},'CA','legacy-token',config);
  await saveSocialCustomer(store,{uid:'unverified',email:'no@example.invalid',email_verified:false},'CA','unverified-token',config);
  assert.equal((await store.list('mail_outbox')).length,3);
});
test('branded HTML escapes fields and welcome links to configured platform, not the coming-soon site',()=>{
  const welcome=renderWelcomeMail({name:'<img src=x>'},config.siteUrl);
  assert.match(welcome.html,/&lt;img src=x&gt;/);assert.ok(welcome.body.includes(config.siteUrl+'/cuenta'));
  const mail=renderPurchaseMail({...shopSample,customer_name:'<script>bad</script>'},'paid',config);
  assert.match(mail.html,/&lt;script&gt;/);assert.ok(!mail.body.includes('guest_id'));assert.match(mail.html,/<html lang="en">/);
});
test('booking deposit correctly separates total, received amount and remaining balance in email/PDF snapshot',()=>{
  const mail=renderPurchaseMail(bookingSample,'paid',config),pdf=commerceReceiptSnapshot(bookingSample,'paid',config);
  assert.equal(pdf.paidMinor,48000);assert.equal(pdf.balanceMinor,112000);assert.equal(pdf.quote.total_minor,160000);
  for(const t of ['1,600.00 CAD','480.00 CAD','1,120.00 CAD','Deposit','3 nights'])assert.ok(mail.body.includes(t),t);
  assert.equal(commerceReceiptSnapshot({...bookingSample,due_minor:160000},'paid',config).balanceMinor,0);
});
test('shop details show quantity, shipping and pickup instructions without promising dispatch',()=>{
  const data=purchaseMailData(shopSample,'paid',config);assert.equal(data.lines.reduce((s,l)=>s+l.amount_minor,0),16500);
  const mail=renderPurchaseMail(shopSample,'paid',config);assert.match(mail.body,/Qty 2/);assert.match(mail.body,/Shipping: 15.00 CAD/);assert.match(mail.body,/does not mean your items have shipped/);
  const pickup=renderPurchaseMail({...shopSample,detail:{...shopSample.detail,delivery:'pickup',pickup_instructions:'Wait for our call'}},'paid',config);
  assert.match(pickup.body,/Wait for our call/);assert.ok(!pickup.body.includes('Delivery address'));
});
test('failed/expired/cancelled orders never get PDF or claim full payment; review warns against paying twice',async()=>{
  for(const c of [shopSample,bookingSample])for(const [status,event]of [['pago rechazado','failed'],['pago vencido','expired'],['cancelada','cancelled']]){
    const store=memoryStore();await store.transaction(tx=>notice(tx,c,status,config));
    for(const m of await store.list('mail_outbox')){assert.equal(m.receipt,undefined);assert.match(m.body,/0.00 CAD/);}
    assert.throws(()=>commerceReceiptSnapshot(c,event,config),/Unpaid/);
  }
  assert.match(renderPurchaseMail(bookingSample,'review',config).body,/Please do not pay again/);
});
test('actual shop/booking checkout settlement queues once; SMTP delivers customer PDF and separate admin mail',async()=>{
  for(const kind of ['order','booking']){
    const store=memoryStore(),guest='owner';await store.set('guests',guest,{expires_at:afterMinutes(60)});
    const customer={name:'Buyer',email:'buyer@example.invalid',phone:'+12505550123',consent:true};let c;
    if(kind==='order'){
      await store.set('products','p',{published:true,archived:false,name:'Linen'});
      await store.set('variants','v',{product_id:'p',sku:'LINEN',name:'Natural',active:true,stock:4,price_minor:7500,currency:'CAD'});
      await store.set('carts',guest,{items:[{variant_id:'v',quantity:2}]});
      await store.set('shop_settings','CAD',{shipping_enabled:true,shipping_minor:1500,terms:'Test'});
      c=await createOrder(store,config,guest,randomUUID(),{customer,delivery:'shipping',shipping_address:shopSample.detail.shipping_address,currency:'CAD'});
    }else{
      await store.set('properties','p',{name:'Test stay',published:true,archived:false,timezone:'America/Vancouver',min_nights:1,capacity:4,nightly_minor:50000,cleaning_minor:10000,deposit_percent:30,currency:'CAD',policies:'Test'});
      const day=n=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
      c=await createBooking(store,config,guest,randomUUID(),{property_id:'p',check_in:day(30),check_out:day(33),guests:2,customer,pay:'deposit',currency:'CAD'});
    }
    assert.equal((await store.list('mail_outbox')).length,0);
    const gateway={provider:'stripe',create:async p=>({reference:'cs_'+p.id,url:'https://checkout.stripe.com/test'})};
    const p=await startPayment(store,config,gateway,guest,c.id);
    const event={provider:'stripe',id:'evt_'+c.id,reference:'cs_'+c.id,outcome:'paid',amount:p.amount_minor,currency:p.currency};
    await settlePayment(store,config,event);await settlePayment(store,config,event);
    assert.equal((await store.get('checkouts',c.id)).status,'confirmed');
    assert.equal((await store.list('mail_outbox')).length,2);
    const sent=[];await deliverMail(store,{...config,mailMode:'smtp'},{sendMail:async m=>sent.push(m)});
    assert.deepEqual(sent.map(m=>m.to).sort(),['buyer@example.invalid','team@example.invalid']);
    assert.equal(sent.find(m=>m.to===config.adminEmail).attachments,undefined);
    const attachment=sent.find(m=>m.to===customer.email).attachments[0];
    assert.match(attachment.filename,kind==='order'?/ViiShop/:/ViiConcierge/);assert.equal(attachment.content.subarray(0,5).toString(),'%PDF-');
    assert.equal((await deliverMail(store,{...config,mailMode:'smtp'},{sendMail:async()=>{throw Error('Unexpected repeat');}})).sent,0);
  }
});
