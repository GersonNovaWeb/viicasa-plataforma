import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openPhase2Databases} from '../database.mjs';
import {seedPhase2,demoCredentials} from '../bootstrap.mjs';
import {buildPhase2App} from '../app.mjs';
import {secretVault,totp} from '../security.mjs';
import {settlePayment,deliverMail} from '../../viicasa-backend/src/firestore-payments.js';
import {deliverCommercialMail} from '../mail.mjs';
import {paymentGateway} from '../../viicasa-backend/src/payments.js';
const origin='http://127.0.0.1:3030',buyer={name:'Guest Buyer',email:'guest-buyer@example.invalid'};
const cookieOf=response=>[].concat(response.headers['set-cookie']||[]).map(c=>c.split(';')[0]).join('; ');
const linkOf=mail=>new URL(mail.body.match(/http:\/\/127\.0\.0\.1:3030\/pedido#access=[ps]_[A-Za-z0-9_-]{43}/)[0]).hash.slice(8);
async function fixture(t,options={}){
  const databases=await openPhase2Databases('',{memory:true});t.after(()=>databases.close());await seedPhase2(databases);
  const vault=secretVault(Buffer.alloc(32,93)),app=await buildPhase2App(databases,vault,{testing:true,adminEmail:'guest-team@example.invalid',...options});t.after(()=>app.close());
  const call=(url,{method='GET',body,cookie,headers={}}={})=>app.inject({url,method,payload:body,headers:{origin,...(cookie?{cookie}:{}),...headers}});
  const login=async()=>{const a=(await call('/api/commercial/login',{method:'POST',body:demoCredentials.admin})).json(),r=await call('/api/commercial/verify',{method:'POST',body:{challenge:a.challenge,code:totp(a.secret)}});assert.equal(r.statusCode,200,r.body);return cookieOf(r);};
  const customer=async email=>{const a=await call('/api/client/register',{method:'POST',body:{email,name:'Verified Buyer',password:'Guest-Checkout-Tests-2026!'}}),m=(await databases.commercial.query("SELECT body FROM commercial_mail WHERE recipient=$1 AND subject LIKE '%Verify your email%' ORDER BY created_at DESC LIMIT 1",[email])).rows[0];const r=await call('/api/client/verify',{method:'POST',body:{challenge:a.json().challenge,code:m.body.match(/code is (\d{6})/)[1]}});assert.equal(r.statusCode,200,r.body);return cookieOf(r);};
  const access=async secret=>{const r=await call('/api/guest/access',{method:'POST',body:{access:secret}});assert.equal(r.statusCode,200,r.body);return cookieOf(r);};
  const admin=await login();return{...databases,app,vault,call,customer,access,admin};
}
const input=(hours=2)=>({selection:{service:'routine',frequency:'weekly',hours,full_clean:false,extras:[]},schedule:{days:['mon'],start_date:new Date(Date.now()+7*86400000).toISOString().slice(0,10),start_hour:8},address:{street:'123 Fictional Street',city:'Kelowna',state:'BC',country:'CA',postal_code:'V1Y 1A1'},customer:{...buyer,phone:'+12505550123',consent:true},locale:'en',settings_revision:1});
const create=async(f,hours=2)=>{const r=await f.call('/api/viilife/requests',{method:'POST',body:input(hours),headers:{'Idempotency-Key':randomUUID()}});assert.equal(r.statusCode,201,r.body);return r.json();};

test('guest ViiLife purchase has no account, exact CAD amount, scoped email access and buyer/team receipts',async t=>{
  let calls=0;const gateway={provider:'stripe',create:async(p,c)=>{calls++;assert.equal(c.customer_email,buyer.email);return{reference:'cs_test_'+p.id,url:'https://checkout.stripe.com/c/test-fixture'};}};
  const f=await fixture(t,{stripeKey:'sk_test_fictional_guest',stripeWebhookSecret:'whsec_fictional_guest',providerGateways:{platformPayments:gateway}}),row=await create(f),id=row.checkout.id;
  assert.equal(row.checkout.total_minor,19998);assert.equal(row.checkout.currency,'CAD');
  assert.equal((await f.commercial.query('SELECT count(*)::int AS n FROM customer_accounts')).rows[0].n,0);
  const mail=(await f.store.list('mail_outbox')).find(m=>m.subject.includes('private order link'));assert.equal(mail.recipient,buyer.email);const secret=linkOf(mail),cookie=await f.access(secret);
  assert.equal((await f.call('/api/checkouts/'+id)).statusCode,404,'New anonymous browser cannot fetch by checkout ID');
  assert.equal((await f.call('/api/guest/order')).statusCode,401);
  const view=await f.call('/api/guest/order',{cookie});assert.equal(view.statusCode,200,view.body);assert.equal(view.json().order.id,id);assert.equal(view.json().order.guest_id,undefined);assert.equal(view.headers['cache-control'],'private, no-store');
  assert.equal((await f.call('/api/guest/order?reference='+randomUUID(),{cookie})).statusCode,409);
  assert.equal((await f.call('/api/guest/order/payment',{method:'POST',cookie,body:{reference:randomUUID()}})).statusCode,409,'Switching order cookies in another tab cannot charge a different displayed order');assert.equal(calls,0);
  assert.equal((await f.call('/api/guest/order/payment',{method:'POST',cookie,body:{checkout_id:randomUUID()}})).statusCode,400);
  assert.equal((await f.call('/api/guest/order/payment',{method:'POST',cookie,body:{reference:id},headers:{origin:'https://outside.invalid'}})).statusCode,403);
  const p=await f.call('/api/guest/order/payment',{method:'POST',cookie,body:{reference:id}});assert.equal(p.statusCode,200,p.body);assert.equal(p.json().amount_minor,19998);assert.match(p.json().checkout_url,/checkout.stripe.com/);
  await f.call('/api/guest/order/payment',{method:'POST',cookie:cookieOf(p),body:{reference:id}});assert.equal(calls,1,'Retry uses persisted Stripe session');
  const config={paymentProvider:'stripe',stripeKey:'sk_test_fictional',viilifeMode:'live',siteUrl:origin,adminEmail:'guest-team@example.invalid',guestOrderLink:async(tx,c)=>new URL('/pedido#access='+f.vault.open((await tx.get('guest_order_links',c.id)).secret_cipher),origin).href};
  const event={provider:'stripe',id:'evt_guest_fixture',reference:'cs_test_'+id,outcome:'paid',amount:19998,currency:'CAD'};await settlePayment(f.store,config,event);await settlePayment(f.store,config,event);
  assert.equal((await f.call('/api/guest/order',{cookie})).json().order.status,'confirmed');
  const sent=[];await deliverMail(f.store,{...config,mailMode:'smtp',mailFrom:'accounts@example.invalid'},{sendMail:async m=>{sent.push(m);return{accepted:[m.to]};}});
  const receipt=sent.find(m=>m.to===buyer.email&&m.subject.includes('receipt'));assert.ok(receipt);assert.equal(receipt.attachments[0].content.subarray(0,5).toString(),'%PDF-');assert.match(receipt.html,/pedido#access=/);assert.ok(sent.some(m=>m.to==='guest-team@example.invalid'));assert.ok(sent.every(m=>[buyer.email,'guest-team@example.invalid'].includes(m.to)));
  const page=await f.call('/pedido');assert.equal(page.statusCode,200);assert.doesNotMatch(page.body,/consent.js|runtime-presentation.js/);assert.equal(page.headers['referrer-policy'],'no-referrer');
});

test('large guest orders cannot pay until admin approval; approval emails link to the same private order',async t=>{
  const f=await fixture(t),row=await create(f,4),id=row.checkout.id,mail=(await f.store.list('mail_outbox')).find(m=>m.subject.includes('private order link')),secret=linkOf(mail),cookie=await f.access(secret);
  assert.equal(row.checkout.status,'awaiting_approval');assert.equal((await f.call('/api/guest/order/payment',{method:'POST',cookie,body:{reference:id}})).statusCode,409);
  assert.equal((await f.call('/api/admin/cleaning/requests/'+row.request.id+'/review',{method:'POST',cookie,body:{action:'approve'}})).statusCode,403);
  const approved=await f.call('/api/admin/cleaning/requests/'+row.request.id+'/review',{method:'POST',cookie:f.admin,body:{action:'approve'}});assert.equal(approved.statusCode,200,approved.body);
  const ready=(await f.store.list('mail_outbox')).find(m=>m.subject.includes('ready for payment'));assert.equal(ready.recipient,buyer.email);assert.equal(linkOf(ready),secret);assert.doesNotMatch(ready.body,/Sign in using/);
  assert.equal((await f.call('/api/guest/order/payment',{method:'POST',cookie,body:{reference:id}})).statusCode,200);
  const invalid='p_'+'x'.repeat(43);assert.equal((await f.call('/api/guest/access',{method:'POST',body:{access:invalid}})).statusCode,404);
  await f.commercial.query("UPDATE guest_order_grants SET expires_at=now()-interval '1 minute'");assert.equal((await f.call('/api/guest/order',{cookie})).statusCode,401);
  const link=await f.store.get('guest_order_links',id);await f.store.set('guest_order_links',id,{...link,expires_at:new Date(Date.now()-60000).toISOString()});assert.equal((await f.call('/api/guest/access',{method:'POST',body:{access:secret}})).statusCode,404);
});

test('anonymous shop quote and checkout preserve stock/idempotency and protect private lists and verified-email claim',async t=>{
  const f=await fixture(t);await f.call('/api/commercial/shop-channel/examples',{method:'POST',cookie:f.admin,body:{confirm:true}});
  const v=(await f.call('/api/shop-channel/catalogue')).json().items[0].variants[0],body={customer:buyer,idempotency_key:randomUUID(),consent:true,lines:[{variant_id:v.id,quantity:2}]};
  const quote=await f.call('/api/client/shop-channel/quote',{method:'POST',body:{lines:body.lines}});assert.equal(quote.statusCode,200,quote.body);assert.equal(quote.json().breakdown.total_minor,v.price_minor*2);
  const created=await f.call('/api/client/shop-channel/checkouts',{method:'POST',body});assert.equal(created.statusCode,200,created.body);const id=created.json().id,browser=cookieOf(created);
  assert.equal((await f.call('/api/client/shop-channel/checkouts',{method:'POST',cookie:browser,body})).json().id,id);
  assert.equal((await f.call('/api/client/shop-channel/checkouts',{method:'POST',cookie:browser,body:{...body,customer:{...buyer,email:'changed@example.invalid'}}})).statusCode,409);
  const row=(await f.commercial.query('SELECT * FROM channel_checkouts WHERE id=$1',[id])).rows[0];assert.equal(row.customer_id,null);assert.match(row.buyer_ref,/^guest:/);
  assert.equal((await f.call('/api/client/shop-channel/checkouts',{cookie:browser})).statusCode,401);
  const mail=(await f.commercial.query("SELECT * FROM commercial_mail WHERE dedupe=$1",['guest-access:channel:'+id])).rows[0],secret=linkOf(mail),cookie=await f.access(secret);
  assert.equal((await f.call('/api/guest/order',{cookie})).json().order.id,id);assert.equal((await f.call('/api/guest/order/payment',{method:'POST',cookie,body:{reference:id}})).statusCode,409);
  const other=await f.customer('different-guest@example.invalid');assert.equal((await f.call('/api/guest/order/claim',{method:'POST',cookie:cookie+'; '+other,body:{consent:true,reference:id}})).statusCode,403);
  assert.equal((await f.call('/api/guest/order/claim',{method:'POST',cookie,body:{consent:true,reference:id}})).statusCode,401);
  const account=await f.customer(buyer.email),claimed=await f.call('/api/guest/order/claim',{method:'POST',cookie:cookie+'; '+account,body:{consent:true,reference:id}});assert.equal(claimed.statusCode,200,claimed.body);
  assert.equal((await f.call('/api/client/shop-channel/checkouts',{cookie:account})).json().items[0].id,id);
  assert.equal((await f.call('/api/guest/access',{method:'POST',body:{access:secret}})).statusCode,404);assert.equal((await f.call('/api/guest/order',{cookie})).statusCode,401);
});

test('guest catalogue and general enquiries use server CAD prices, private tracking and correct customer/team delivery',async t=>{
  const f=await fixture(t),p=(await f.call('/api/commercial/service-catalogue',{cookie:f.admin})).json().items.find(x=>x.id==='home-cleaning');
  const {id,revision,...fields}=p,saved=await f.call('/api/commercial/service-catalogue/'+id,{method:'PUT',cookie:f.admin,body:{...fields,revision,published:true,images:['/assets/life.png'],pricing:{kind:'fixed',currency:'CAD',amount_minor:9999,basis:'hour'}}});assert.equal(saved.statusCode,200,saved.body);
  const body={customer:buyer,service_id:id,revision:saved.json().revision,channel:'viilife',mode:'once',quantity:3,phone:'+12505550123',address:'Fictional Home, Canada',message:'Morning preferred',consent:true,idempotency_key:randomUUID()};
  const r=await f.call('/api/client/service-catalogue/requests',{method:'POST',body});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().estimate.total_minor,29997);
  const mail=(await f.commercial.query('SELECT * FROM commercial_mail WHERE dedupe=$1',['catalogue:'+r.json().id+':customer'])).rows[0],cookie=await f.access(linkOf(mail));assert.equal((await f.call('/api/guest/order',{cookie})).json().order.id,r.json().id);
  const enquiry=await f.call('/api/client/requests',{method:'POST',body:{customer:{...buyer,email:'second-guest@example.invalid'},service:'home',phone:'+12505550123',company:'',address:'Another Fictional Home',sqft:1500,message:'Guest enquiry',consent:true,idempotency_key:randomUUID()}});assert.equal(enquiry.statusCode,200,enquiry.body);
  // The first capability is unaffected by submitting an enquiry with another email.
  assert.equal((await f.call('/api/guest/order',{cookie})).json().order.id,r.json().id);
  const sent=[];await deliverCommercialMail(f.commercial,{mailMode:'smtp',mailFrom:'accounts@example.invalid'},{sendMail:async m=>sent.push(m)});assert.equal(sent.filter(m=>m.to===buyer.email).length,1);assert.equal(sent.filter(m=>m.to==='second-guest@example.invalid').length,1);assert.equal(sent.filter(m=>m.to==='guest-team@example.invalid').length,2);
  assert.equal((await f.commercial.query('SELECT count(*)::int AS n FROM customer_accounts')).rows[0].n,0);
  for(const path of ['/solicitar','/guest-request.js','/guest-buyer.js','/guest-order.js'])assert.equal((await f.call(path)).statusCode,200,path);
});

test('claiming a platform order needs verified matching email; old links are revoked and account owns only that order',async t=>{
  const f=await fixture(t),one=await create(f),two=await create(f),mails=await f.store.list('mail_outbox'),mail=mails.find(m=>m.body.includes('/pedido#access=')&&m.id);
  const secret=linkOf(mail),cookie=await f.access(secret),target=(await f.call('/api/guest/order',{cookie})).json().order.id,account=await f.customer(buyer.email);
  const claim=await f.call('/api/guest/order/claim',{method:'POST',cookie:cookie+'; '+account,body:{consent:true,reference:target}});assert.equal(claim.statusCode,200,claim.body);
  const list=(await f.call('/api/account',{cookie:account})).json().items;assert.equal(list.length,1);assert.equal(list[0].id,target);assert.notEqual(one.checkout.id,two.checkout.id);
  assert.equal((await f.call('/api/guest/access',{method:'POST',body:{access:secret}})).statusCode,404);
});

test('Stripe guest return uses private page and still charges server amount and card only',async()=>{
  let posted;const gateway=paymentGateway({paymentProvider:'stripe',stripeKey:'sk_test_fictional',siteUrl:origin,checkoutReturnPath:async()=>'/pedido?reference=fixture'},{stripe:{checkout:{sessions:{create:async body=>{posted=body;return{id:'cs_test_local',url:'https://checkout.stripe.com/c/test-fixture'};}}}}});
  await gateway.create({id:randomUUID(),amount_minor:29997,currency:'CAD',expires_at:new Date(Date.now()+35*60000).toISOString()},{id:randomUUID(),kind:'cleaning',customer_email:buyer.email});
  assert.equal(posted.success_url,origin+'/pedido?reference=fixture');assert.equal(posted.cancel_url,origin+'/pedido?reference=fixture');assert.deepEqual(posted.payment_method_types,['card']);assert.equal(posted.line_items[0].price_data.unit_amount,29997);assert.equal(posted.customer_email,buyer.email);
});

test('guest enquiry continues through private agreement, consent, invoice and payment without creating an account',async t=>{
  const f=await fixture(t),post=(url,body={},cookie=f.admin)=>f.call(url,{method:'POST',body,cookie});
  const enquiry=await post('/api/client/requests',{customer:buyer,service:'home',phone:'+12505550123',company:'',address:'123 Fictional Home',sqft:2000,message:'Quote as a guest',consent:true,idempotency_key:randomUUID()},null);assert.equal(enquiry.statusCode,200,enquiry.body);
  const lead=(await f.commercial.query('SELECT lead_id FROM client_service_requests WHERE id=$1',[enquiry.json().id])).rows[0].lead_id;
  const quote=await post('/api/commercial/quotes',{lead_id:lead,service_id:'home-standard',rate_minor:11000,quantity:1,visits:2,frequency:'weekly',term:'month_to_month',properties:[]});assert.equal(quote.statusCode,200,quote.body);
  const q=(await f.call('/api/commercial/quotes',{cookie:f.admin})).json().items.find(x=>x.id===quote.json().id);assert.equal((await post('/api/commercial/quotes/'+q.id+'/review',{action:'approve',revision:q.revision})).statusCode,200);
  const created=await post('/api/commercial/contracts',{quote_id:q.id,scope:'Fictional guest service agreement for local tests',first_service_date:new Date(Date.now()+7*86400000).toISOString().slice(0,10),arrival_window:'09:00-12:00',billing_contact:buyer.name,properties:[{address:'123 Fictional Home',type:'house',sqft:2000}]});assert.equal(created.statusCode,200,created.body);const id=created.json().id;
  await post('/api/commercial/contracts/'+id+'/send');const mail=(await f.commercial.query('SELECT * FROM commercial_mail WHERE dedupe=$1',['contract:'+id+':sent'])).rows[0],cookie=await f.access(linkOf(mail));
  assert.equal((await f.call('/api/client/contracts',{cookie})).statusCode,401);assert.equal((await f.call('/api/client/contracts/'+randomUUID(),{cookie})).statusCode,401);
  const record=await f.call('/api/client/contracts/'+id,{cookie});assert.equal(record.statusCode,200,record.body);const c=record.json();
  const acceptance={snapshot_hash:c.snapshot_hash,signed_name:buyer.name,consent:true,subcontractors:true,access_method:'arrival',photo_marketing_optout:true};
  assert.equal((await post('/api/client/contracts/'+id+'/accept',{...acceptance,snapshot_hash:'0'.repeat(64)},cookie)).statusCode,409);
  for(let i=0;i<2;i++){const accepted=await post('/api/client/contracts/'+id+'/accept',acceptance,cookie);assert.equal(accepted.statusCode,200,accepted.body);}
  const saved=(await f.commercial.query('SELECT * FROM service_contracts WHERE id=$1',[id])).rows[0];assert.equal(saved.accepted_by,null);assert.equal(saved.acceptance.auth_method,'private_email_link');
  const pdf=await f.call('/api/client/contracts/'+id+'/pdf',{cookie});assert.equal(pdf.statusCode,200);assert.equal(pdf.rawPayload.subarray(0,5).toString(),'%PDF-');
  const v=(await f.commercial.query('SELECT * FROM service_visits WHERE contract_id=$1 ORDER BY service_date',[id])).rows[0];await post('/api/commercial/visits/'+v.id+'/status',{status:'completed'});
  const invoice=await post('/api/commercial/invoices',{contract_id:id,period:new Date(v.service_date).toISOString().slice(0,7),visit_id:v.id});assert.equal(invoice.statusCode,200,invoice.body);const i=invoice.json();
  const issued=(await f.commercial.query('SELECT * FROM commercial_mail WHERE dedupe=$1',['invoice:'+i.id+':issued'])).rows[0],invoiceCookie=await f.access(linkOf(issued));
  assert.equal((await post('/api/client/invoices/'+i.id+'/payment',{},cookie)).statusCode,401,'An agreement link cannot authorise an invoice');
  const payment=await post('/api/client/invoices/'+i.id+'/payment',{},invoiceCookie);assert.equal(payment.statusCode,200,payment.body);assert.equal((await post('/api/commercial/invoices/'+i.id+'/simulate-payment')).statusCode,200);
  assert.equal((await f.call('/api/guest/order',{cookie:invoiceCookie})).json().order.status,'paid');
  assert.equal((await f.commercial.query('SELECT count(*)::int AS n FROM customer_accounts')).rows[0].n,0);
});

test('guest Shopify adapter receives checkout contact once and never creates a local stock hold',async t=>{
  let calls=0;const shopify={enabled:true,checkoutEnabled:true,createCart:async(customer,variants)=>{calls++;assert.equal(customer.email,buyer.email);assert.equal(customer.guest,true);assert.equal(variants.length,1);return{url:'https://fixture.myshopify.com/checkouts/guest',total_minor:5999};}};
  const f=await fixture(t,{providerGateways:{shopify}});await f.call('/api/commercial/shop-channel/examples',{method:'POST',cookie:f.admin,body:{confirm:true}});
  const p=(await f.call('/api/shop-channel/catalogue')).json().items[0],v=p.variants[0];await f.commercial.query("UPDATE channel_products SET provider='shopify' WHERE id=$1",[p.id]);
  const body={customer:buyer,request_id:randomUUID(),external_checkout_acknowledged:true,lines:[{variant_id:v.id,quantity:1}]},url='/api/client/shopify/carts',r=await f.call(url,{method:'POST',body});assert.equal(r.statusCode,200,r.body);
  assert.equal((await f.call(url,{method:'POST',body,cookie:cookieOf(r)})).statusCode,200);assert.equal(calls,1);
  const row=(await f.commercial.query('SELECT * FROM shopify_carts')).rows[0],mail=(await f.commercial.query('SELECT * FROM commercial_mail WHERE dedupe=$1',['guest-access:shopify:'+row.id])).rows[0],cookie=await f.access(linkOf(mail));
  assert.equal((await f.call('/api/guest/order',{cookie})).json().order.checkout_url,r.json().checkout_url);assert.equal(row.customer_id,null);assert.equal((await f.commercial.query('SELECT count(*)::int AS n FROM channel_holds')).rows[0].n,0);
});
