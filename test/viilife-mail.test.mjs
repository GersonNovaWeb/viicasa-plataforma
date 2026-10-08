import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderViiLifeMail} from '../viicasa-backend/src/viilife-mail.js';
import {notice} from '../viicasa-backend/src/firestore-commerce.js';
import {deliverMail} from '../viicasa-backend/src/firestore-payments.js';
const sample={reference:'VIILIFE-TEST-001',issuedAt:'2026-10-07T12:00:00Z',customer:{name:'Mary Smith',email:'mary@example.invalid',phone:'+1 250 555 0123'},selection:{service:'routine',extras:[]},quote:{currency:'CAD',total_minor:59994,lines:[{code:'routine',amount_minor:59994}],billing:{scope:'one_cycle',hourly_minor:9999,hours_per_visit:2,visits:3,cycle:'biweekly'},dates:['2026-10-12','2026-10-14','2026-10-16'],estimate_pending:[]},schedule:{days:['mon','wed','fri'],start_hour:8},address:{street:'123 Example Street',city:'Kelowna',state:'BC',country:'CA',postal_code:'V1Y 1A1'},event:'paid'};
test('English business receipt preserves brand, totals, contact and preferred schedule',()=>{
 const m=renderViiLifeMail(sample);
 for(const text of ['VIILIFE-TEST-001','Mary Smith','99.99 CAD/h × 2 h × 3 visits','599.94 CAD','Payment received','two-week','08:00','October 12, 2026','The ViiLife team will be in touch soon','not a confirmed appointment','No subscription or automatic renewal'])assert.ok(m.body.includes(text),text);
 assert.ok(m.html.includes('<html lang="en">'));assert.ok(m.html.includes('https://viicasa.com/images/logo-email.png'));
 for(const text of ['background-color:#111111','Kelowna, British Columbia, Canada','contact@viicasa.com','Instagram','Facebook','LinkedIn','This email may contain confidential','© 2026 VIICASA. All rights reserved.'])assert.ok(m.html.includes(text),text);
 assert.ok(!m.html.includes('postimg'));assert.ok(!m.body.includes('guest_id'));assert.ok(!m.html.includes('DEMONSTRATION ONLY'));
});
test('demo receipt never presents the simulated amount as a real charge',()=>{
 const m=renderViiLifeMail({...sample,demo:true});assert.ok(m.subject.startsWith('[DEMO VIILIFE]'));assert.ok(m.html.includes('Demonstration receipt'));assert.ok(m.body.includes('No money was charged'));assert.ok(m.body.includes('Simulated payment: 599.94 CAD'));assert.ok(m.body.includes('not a tax receipt'));assert.ok(!m.body.includes('Payment received:'));
});
test('non-paid events are summaries, not payment receipts; review warns against paying again',()=>{
 for(const event of ['requested','unpaid','failed','expired','cancelled']){const m=renderViiLifeMail({...sample,event});assert.ok(m.body.includes('Amount paid: 0.00 CAD'));assert.ok(!m.html.includes('Payment receipt'));assert.ok(!m.body.includes('Payment received:'));}
 const review=renderViiLifeMail({...sample,event:'review'});assert.ok(review.body.includes('under review'));assert.ok(review.body.includes('Please do not pay again'));
});
test('deep cleaning has separate line items and unpriced extras without invented taxes',()=>{
 const m=renderViiLifeMail({...sample,selection:{service:'deep'},quote:{currency:'USD',total_minor:135100,lines:[{code:'deep',amount_minor:35000},{code:'full_clean',amount_minor:100100}],billing:{scope:'one_visit',visits:1},estimate_pending:['setup','removals']}});
 for(const text of ['Deep cleaning: 350.00 USD','Full-property cleaning: 1001.00 USD','Total: 1351.00 USD','One visit','separate estimate required: Home setup, Removals','does not provide a tax breakdown'])assert.ok(m.body.includes(text),text);
 assert.ok(!m.body.includes('undefined'));assert.ok(!m.body.includes('NaN'));assert.ok(!m.body.includes('0.00 tax'));
});
test('untrusted customer/address/line values are escaped in HTML',()=>{
 const attack='<img src=x onerror="alert(1)">';const m=renderViiLifeMail({...sample,reference:attack,customer:{...sample.customer,name:attack},address:{...sample.address,street:attack},quote:{...sample.quote,lines:[{code:attack,amount_minor:59994}]}});
 assert.equal((m.html.match(/<img /g)||[]).length,1);assert.ok(m.html.includes('&lt;img'));assert.ok(!m.html.includes('<img src=x'));assert.ok(!m.subject.includes(attack));
});
test('live Firestore notice queues English HTML for both audiences and deduplicates',async()=>{
 const rows=new Map(),tx={get:async(c,id)=>rows.get(c+id),create:(c,id,row)=>rows.set(c+id,{id,...row})};
 const c={id:sample.reference,kind:'cleaning',customer_name:sample.customer.name,customer_email:sample.customer.email,customer_phone:sample.customer.phone,total_minor:59994,due_minor:59994,currency:'CAD',detail:{...sample,locale:'es'}};
 const config={paymentProvider:'stripe',stripeKey:'sk_live_fixture',adminEmail:'team@example.invalid'};
 await notice(tx,c,'confirmado',config);await notice(tx,c,'confirmado',config);assert.equal(rows.size,2);
 for(const row of rows.values()){assert.ok(row.html.includes('Payment receipt'));assert.ok(row.body.includes('Payment received: 599.94 CAD'));assert.ok(!row.body.includes('confirmado'));}
 const demoRows=[];await notice({get:async()=>null,create:(c,id,row)=>demoRows.push(row)},c,'confirmado',{...config,stripeKey:'sk_test_fixture'});assert.ok(demoRows.every(r=>r.html.includes('DEMONSTRATION ONLY')));
});
test('SMTP receives both HTML and text while old text-only messages remain valid',async()=>{
 const m=renderViiLifeMail(sample),rows=new Map([['new',{id:'new',recipient:'test@example.invalid',...m,status:'pending',attempts:0,next_attempt:'2000-01-01'}],['old',{id:'old',recipient:'test@example.invalid',subject:'Legacy',body:'Legacy text',status:'pending',attempts:0,next_attempt:'2000-01-01'}]]);
 const tx={get:async(c,id)=>rows.get(id),put:(c,id,row)=>rows.set(id,row)},store={list:async()=>[...rows.values()],transaction:fn=>fn(tx)};
 const sent=[];assert.equal((await deliverMail(store,{mailMode:'smtp',mailFrom:'test@example.invalid'},{sendMail:async mail=>sent.push(mail)})).sent,2);
 assert.equal(sent[0].html,m.html);assert.equal(sent[0].text,m.body);assert.equal(sent[1].html,undefined);assert.equal(rows.get('new').status,'sent');
});

export {sample};
