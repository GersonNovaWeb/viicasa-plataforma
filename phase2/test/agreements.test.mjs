import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Stripe from 'stripe';
import {openPhase2Databases} from '../database.mjs';
import {seedPhase2,demoCredentials} from '../bootstrap.mjs';
import {buildPhase2App} from '../app.mjs';
import {secretVault,totp} from '../security.mjs';
import {allocateMinor,plannedVisits,snapshotHash} from '../agreement-content.mjs';
import {quoteService} from '../service-menu.mjs';
import {invoiceGateway} from '../invoice-gateway.mjs';
import {deliverCommercialMail} from '../mail.mjs';
import {processServiceOperations,serviceToday} from '../service-operations.mjs';
import {postgresDatabase,databaseIdentity} from '../postgres.mjs';

const password='Customer-Demo-2026!',origin='http://127.0.0.1:3030';
test('price allocation preserves cents; monthly dates stay in-month and documents hash independently of JSON key order',()=>{
  assert.deepEqual(allocateMinor(100,[1,1,1]),[34,33,33]);assert.equal(snapshotHash({b:2,a:1}),snapshotHash({a:1,b:2}));
  const quote=quoteService({service_id:'home-standard',rate_minor:11000,quantity:1,visits:3,frequency:'monthly',term:'month_to_month'});
  assert.deepEqual(plannedVisits(quote,{first_service_date:'2027-01-31',arrival_window:'9–12',properties:[{address:'123 Test Street',sqft:2000}]}).map(v=>v.service_date),['2027-01-31','2027-02-28','2027-03-31']);
  const commercial=quoteService({service_id:'commercial-laundry',rate_minor:2500,quantity:2,visits:4,frequency:'weekly',term:'annual'});assert.equal(commercial.total_minor,14000);
});

async function fixture(t,options={}){
  const databases=await openPhase2Databases('',{memory:true});t.after(()=>databases.close());await seedPhase2(databases);
  const app=await buildPhase2App(databases,secretVault(Buffer.alloc(32,8)),{testing:true,...options});t.after(()=>app.close());
  const call=(path,{method='GET',body,cookie,headers={}}={})=>app.inject({method,url:path,headers:{origin,...(cookie?{cookie}:{}),...headers},payload:body});
  const teamLogin=async credentials=>{
    const challenge=(await call('/api/commercial/login',{method:'POST',body:credentials})).json();
    const response=await call('/api/commercial/verify',{method:'POST',body:{challenge:challenge.challenge,code:totp(challenge.secret)}});assert.equal(response.statusCode,200,response.body);return{user:response.json().user,cookie:response.headers['set-cookie'].split(';')[0]};
  };
  const admin=await teamLogin(demoCredentials.admin),seller=await teamLogin(demoCredentials.seller);
  const customer=async(email='buyer@example.invalid')=>{
    const response=await call('/api/client/register',{method:'POST',body:{email,name:'Avery Reed',password}});assert.equal(response.statusCode,200,response.body);
    const challenge=response.json().challenge,mail=(await databases.commercial.query("SELECT * FROM commercial_mail WHERE recipient=$1 AND subject LIKE '%Verify your email%' ORDER BY created_at DESC LIMIT 1",[email])).rows[0],code=mail.body.match(/code is (\d{6})/)[1];
    const verified=await call('/api/client/verify',{method:'POST',body:{challenge,code}});assert.equal(verified.statusCode,200,verified.body);return{profile:verified.json().profile,cookie:verified.headers['set-cookie'].split(';')[0],challenge,code};
  };
  const proposal=async(client,segment='home')=>{
    const body={service:segment,phone:'+12505550123',company:segment==='commercial'?'Test Company':'',address:'123 Test Street, Kelowna',sqft:2000,message:'Phase 2 testing',consent:true,idempotency_key:randomUUID()};
    const request=await call('/api/client/requests',{method:'POST',cookie:client.cookie,body});assert.equal(request.statusCode,200,request.body);
    const repeated=await call('/api/client/requests',{method:'POST',cookie:client.cookie,body});assert.equal(repeated.json().id,request.json().id);
    const lead=(await call('/api/commercial/leads',{cookie:admin.cookie})).json().items.find(l=>l.email===client.profile.email&&l.service===segment);
    await call('/api/commercial/leads/'+lead.id+'/assign',{method:'POST',cookie:admin.cookie,body:{owner_id:seller.user.id}});
    const selection={lead_id:lead.id,service_id:segment==='home'?'home-standard':'commercial-team',rate_minor:segment==='home'?11000:7500,quantity:segment==='home'?1:2,visits:2,frequency:'weekly',term:segment==='home'?'month_to_month':'annual',properties:segment==='home'?[]:[{address:'100 Demo Office',sqft:1000},{address:'200 Demo Office',sqft:2000}]};
    const quote=await call('/api/commercial/quotes',{method:'POST',cookie:seller.cookie,body:selection});assert.equal(quote.statusCode,200,quote.body);return{lead,selection,quoteId:quote.json().id};
  };
  const createContract=async(p)=>{
    const q=(await call('/api/commercial/quotes',{cookie:seller.cookie})).json().items.find(q=>q.id===p.quoteId);
    const approval=await call('/api/commercial/quotes/'+q.id+'/review',{method:'POST',cookie:admin.cookie,body:{action:'approve',revision:q.revision}});assert.equal(approval.statusCode,200,approval.body);
    const date=new Date();date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+1);date.setUTCDate(3);
    const body={quote_id:q.id,scope:'Services for the agreed demonstration schedule',first_service_date:date.toISOString().slice(0,10),arrival_window:'09:00–12:00',billing_contact:'Avery Reed',properties:p.selection.properties.length?p.selection.properties.map(v=>({...v,type:'office'})):[{address:'123 Test Street, Kelowna',type:'house',sqft:2000}]};
    const result=await call('/api/commercial/contracts',{method:'POST',cookie:seller.cookie,body});assert.equal(result.statusCode,200,result.body);return result.json();
  };
  const accept=async(c,client)=>{
    await call('/api/commercial/contracts/'+c.id+'/send',{method:'POST',cookie:seller.cookie,body:{}});
    const current=(await call('/api/client/contracts/'+c.id,{cookie:client.cookie})).json();
    const body={snapshot_hash:current.snapshot_hash,signed_name:client.profile.name,consent:true,subcontractors:true,access_method:'standing',photo_marketing_optout:true};
    const accepted=await call('/api/client/contracts/'+c.id+'/accept',{method:'POST',cookie:client.cookie,body});assert.equal(accepted.statusCode,200,accepted.body);return body;
  };
  return{...databases,app,call,admin,seller,customer,proposal,createContract,accept};
}

test('verified customer → assigned CRM → approved quote → immutable agreement → visits → invoice → demo payment',async t=>{
  const f=await fixture(t),{call,commercial:db,admin,seller}=f;const buyer=await f.customer(),other=await f.customer('other@example.invalid');
  await t.test('verification is one-use, welcome once; team and customer sessions are separate',async()=>{
    assert.equal((await call('/api/client/verify',{method:'POST',body:{challenge:buyer.challenge,code:buyer.code}})).statusCode,401);
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM commercial_mail WHERE dedupe=$1",['customer-welcome:'+buyer.profile.id])).rows[0].n,1);
    assert.equal((await call('/api/commercial/customers',{cookie:buyer.cookie})).statusCode,401);
    assert.equal((await call('/api/client/me',{cookie:admin.cookie})).statusCode,401);
    assert.equal((await call('/api/commercial/outbox',{cookie:seller.cookie})).statusCode,403);
  });
  const p=await f.proposal(buyer);
  await t.test('only admin approves; stale revisions and editing an approved quote are rejected',async()=>{
    const edited=await call('/api/commercial/quotes/'+p.quoteId,{method:'PUT',cookie:seller.cookie,body:{...p.selection,rate_minor:12000,revision:1}});assert.equal(edited.statusCode,200,edited.body);
    p.selection.rate_minor=12000;
    assert.equal((await call('/api/commercial/quotes/'+p.quoteId+'/review',{method:'POST',cookie:seller.cookie,body:{action:'approve',revision:2}})).statusCode,403);
    assert.equal((await call('/api/commercial/quotes/'+p.quoteId+'/review',{method:'POST',cookie:admin.cookie,body:{action:'approve',revision:1}})).statusCode,409);
  });
  const c=await f.createContract(p);let acceptance;
  await t.test('draft hidden from customer; acceptance requires owner and exact snapshot',async()=>{
    assert.equal((await call('/api/client/contracts/'+c.id,{cookie:buyer.cookie})).statusCode,404);
    await call('/api/commercial/contracts/'+c.id+'/send',{method:'POST',cookie:seller.cookie,body:{}});await call('/api/commercial/contracts/'+c.id+'/send',{method:'POST',cookie:seller.cookie,body:{}});
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM commercial_mail WHERE dedupe=$1',['contract:'+c.id+':sent'])).rows[0].n,1);
    assert.equal((await call('/api/client/contracts/'+c.id,{cookie:other.cookie})).statusCode,404);
    const body={snapshot_hash:'0'.repeat(64),signed_name:buyer.profile.name,consent:true,subcontractors:true,access_method:'standing',photo_marketing_optout:true};
    assert.equal((await call('/api/client/contracts/'+c.id+'/accept',{method:'POST',cookie:buyer.cookie,body})).statusCode,409);
    acceptance=await f.accept(c,buyer);
    assert.equal((await call('/api/client/contracts/'+c.id+'/accept',{method:'POST',cookie:buyer.cookie,body:acceptance})).statusCode,200);
    assert.equal((await call('/api/client/contracts/'+c.id+'/accept',{method:'POST',cookie:buyer.cookie,body:{...acceptance,photo_marketing_optout:false}})).statusCode,409);
    const accepted=(await call('/api/client/contracts/'+c.id,{cookie:buyer.cookie})).json();assert.equal(accepted.acceptance.photo_marketing_optout,true);assert.ok(accepted.acceptance.evidence_hash);
    assert.equal((await call('/api/commercial/quotes/'+p.quoteId,{method:'PUT',cookie:seller.cookie,body:{...p.selection,rate_minor:22000,revision:3}})).statusCode,409);
  });
  const visits=(await call('/api/client/visits',{cookie:buyer.cookie})).json().items;assert.equal(visits.length,2);assert.equal(visits.reduce((n,v)=>n+v.amount_minor,0),24000);
  const period=visits[0].service_date.slice(0,7),invoiceBody={contract_id:c.id,period,visit_id:visits[0].id};let invoice;
  await t.test('home invoices bill one completed visit; other clients and sellers cannot issue or pay it',async()=>{
    assert.equal((await call('/api/commercial/invoices',{method:'POST',cookie:admin.cookie,body:invoiceBody})).statusCode,409);
    assert.equal((await call('/api/commercial/visits/'+visits[0].id+'/status',{method:'POST',cookie:seller.cookie,body:{status:'completed'}})).statusCode,403);
    await call('/api/commercial/visits/'+visits[0].id+'/status',{method:'POST',cookie:admin.cookie,body:{status:'completed'}});
    const issued=await call('/api/commercial/invoices',{method:'POST',cookie:admin.cookie,body:invoiceBody});assert.equal(issued.statusCode,200,issued.body);invoice=issued.json();assert.equal(invoice.total_minor,12000);
    assert.equal((await call('/api/commercial/invoices',{method:'POST',cookie:admin.cookie,body:invoiceBody})).statusCode,409);
    assert.equal((await call('/api/client/invoices/'+invoice.id+'/payment',{method:'POST',cookie:other.cookie,body:{}})).statusCode,404);
    const document=await call('/api/client/invoices/'+invoice.id+'/print',{cookie:buyer.cookie});assert.equal(document.statusCode,200);assert.match(document.body,/120.00 CAD/);
  });
  await t.test('demo settlement records payment and commission once; mail goes to buyer and configured admin',async()=>{
    for(let n=0;n<2;n++)assert.equal((await call('/api/client/invoices/'+invoice.id+'/payment',{method:'POST',cookie:buyer.cookie,body:{}})).statusCode,200);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM service_invoice_payments WHERE invoice_id=$1',[invoice.id])).rows[0].n,1);
    for(let n=0;n<2;n++)assert.equal((await call('/api/commercial/invoices/'+invoice.id+'/simulate-payment',{method:'POST',cookie:admin.cookie,body:{}})).statusCode,200);
    assert.equal((await call('/api/client/invoices',{cookie:buyer.cookie})).json().items[0].status,'paid');
    const sales=(await db.query('SELECT * FROM commercial_sales WHERE reference=$1',[invoice.number])).rows;assert.equal(sales.length,1);assert.equal(Number(sales[0].commission_minor),600);
    const sent=[];const delivered=await deliverCommercialMail(db,{mailMode:'smtp',mailFrom:'accounts@example.invalid'},{sendMail:async m=>sent.push(m)});assert.ok(delivered.sent>0);
    assert.ok(sent.some(m=>m.to==='buyer@example.invalid'&&/payment confirmation/.test(m.subject)));assert.ok(sent.some(m=>m.to==='team@example.invalid'&&/payment recorded/.test(m.subject)));
    assert.equal((await deliverCommercialMail(db,{mailMode:'smtp'},{sendMail:async()=>assert.fail('Repeated delivery')})).sent,0);
  });
  await t.test('expired account cannot be reused as anonymous guest to recover private order history',async()=>{
    assert.equal((await call('/api/account',{cookie:buyer.cookie})).json().profile.email,buyer.profile.email);
    const products=(await call('/api/products',{cookie:buyer.cookie})).json().items;
    const product=(await call('/api/products/'+products[0].slug,{cookie:buyer.cookie})).json();
    await call('/api/cart/items/'+product.variants[0].id,{method:'PUT',cookie:buyer.cookie,body:{quantity:1}});
    const order=await call('/api/orders',{method:'POST',cookie:buyer.cookie,headers:{'idempotency-key':randomUUID()},body:{customer:{name:'Avery Reed',email:'other@example.invalid',phone:'+12505550123',consent:true},delivery:'pickup',currency:'CAD'}});
    assert.equal(order.statusCode,201,order.body);assert.equal(order.json().customer_email,buyer.profile.email);
    assert.equal((await call('/api/account',{cookie:buyer.cookie})).json().items.length,1);
    await call('/api/client/logout',{method:'POST',cookie:buyer.cookie,body:{}});
    const stolen=buyer.cookie.replace('vc2_client=','vc2_guest=');const anonymous=(await call('/api/account',{cookie:stolen})).json();assert.equal(anonymous.profile,null);assert.equal(anonymous.items.length,0);
  });
});

test('email challenges enforce purpose, attempt limits, expiry and password recovery revokes sessions',async t=>{
  const f=await fixture(t),{call,commercial:db}=f,buyer=await f.customer('recovery@example.invalid');
  const attempt=await call('/api/client/register',{method:'POST',body:{name:'Test Reader',email:'attempts@example.invalid',password}});assert.equal(attempt.statusCode,200);
  const challenge=attempt.json().challenge,mail=(await db.query("SELECT * FROM commercial_mail WHERE recipient='attempts@example.invalid' ORDER BY created_at DESC LIMIT 1")).rows[0],code=mail.body.match(/code is (\d{6})/)[1],wrong=String((Number(code)+1)%1000000).padStart(6,'0');
  for(let i=0;i<5;i++)assert.equal((await call('/api/client/verify',{method:'POST',body:{challenge,code:wrong}})).statusCode,401);
  assert.equal((await call('/api/client/verify',{method:'POST',body:{challenge,code}})).statusCode,401);
  const request=await call('/api/client/recover',{method:'POST',body:{email:buyer.profile.email}}),secret=request.json().challenge;
  const resetMail=(await db.query("SELECT * FROM commercial_mail WHERE recipient=$1 AND subject LIKE '%Reset your password%' ORDER BY created_at DESC LIMIT 1",[buyer.profile.email])).rows[0],resetCode=resetMail.body.match(/code is (\d{6})/)[1];
  assert.equal((await call('/api/client/verify',{method:'POST',body:{challenge:secret,code:resetCode}})).statusCode,401);
  const reset=await call('/api/client/reset',{method:'POST',body:{challenge:secret,code:resetCode,password:'New-Customer-Password-2026!'}});assert.equal(reset.statusCode,200,reset.body);
  assert.equal((await call('/api/client/me',{cookie:buyer.cookie})).statusCode,401);
  assert.equal((await call('/api/client/login',{method:'POST',body:{email:buyer.profile.email,password}})).statusCode,401);
  assert.equal((await call('/api/client/login',{method:'POST',body:{email:buyer.profile.email,password:'New-Customer-Password-2026!'}})).statusCode,200);
  assert.equal((await call('/api/client/reset',{method:'POST',body:{challenge:secret,code:resetCode,password}})).statusCode,401);
});

test('commercial portfolio consolidates monthly visits; signed Stripe test events settle exactly once',async t=>{
  const secret='whsec_fixture';let sessionId;
  const gateway={provider:'stripe',create:async p=>{sessionId='cs_fixture_'+p.id;return{reference:sessionId,url:'https://checkout.stripe.com/test'};},verify:(raw,signature)=>{try{return Stripe.webhooks.constructEvent(raw,signature,secret);}catch{throw Object.assign(Error('Invalid signature'),{statusCode:400});}}};
  const f=await fixture(t,{stripeKey:'sk_test_fixture',stripeWebhookSecret:secret,serviceGateway:gateway}),{call,admin,commercial:db}=f;
  const buyer=await f.customer('portfolio@example.invalid'),p=await f.proposal(buyer,'commercial'),c=await f.createContract(p);await f.accept(c,buyer);
  const visits=(await call('/api/client/visits',{cookie:buyer.cookie})).json().items;assert.equal(visits.length,4);assert.equal(visits.reduce((n,v)=>n+v.amount_minor,0),21000);
  const period=visits[0].service_date.slice(0,7);
  await call('/api/commercial/visits/'+visits[0].id+'/status',{method:'POST',cookie:admin.cookie,body:{status:'completed'}});
  assert.equal((await call('/api/commercial/invoices',{method:'POST',cookie:admin.cookie,body:{contract_id:c.id,period}})).statusCode,409);
  for(const v of visits.slice(1))await call('/api/commercial/visits/'+v.id+'/status',{method:'POST',cookie:admin.cookie,body:{status:'completed'}});
  const issued=await call('/api/commercial/invoices',{method:'POST',cookie:admin.cookie,body:{contract_id:c.id,period}});assert.equal(issued.statusCode,200,issued.body);const invoice=issued.json();assert.equal(invoice.total_minor,21000);
  assert.equal((new Date(invoice.due_date)-new Date(serviceToday()))/86400000,15);
  await call('/api/client/invoices/'+invoice.id+'/payment',{method:'POST',cookie:buyer.cookie,body:{}});
  const event={id:'evt_phase2_invoice',type:'checkout.session.completed',data:{object:{id:sessionId,metadata:{phase2_invoice_id:invoice.id},amount_total:21000,currency:'cad',payment_status:'paid'}}};
  const webhook=async(value,signature)=>{const payload=JSON.stringify(value);return call('/v1/webhooks/stripe',{method:'POST',body:payload,headers:{'content-type':'application/json','stripe-signature':signature||Stripe.webhooks.generateTestHeaderString({payload,secret})}});};
  assert.equal((await webhook(event,'invalid')).statusCode,400);
  assert.equal((await webhook({...event,data:{object:{...event.data.object,amount_total:1}}})).statusCode,409);
  for(let i=0;i<2;i++){const response=await webhook(event);assert.equal(response.statusCode,200,response.body);}
  assert.equal((await call('/api/client/invoices',{cookie:buyer.cookie})).json().items[0].status,'paid');
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM commercial_sales WHERE reference=$1',[invoice.number])).rows[0].n,1);
  assert.equal((await call('/api/commercial/invoices/'+invoice.id+'/simulate-payment',{method:'POST',cookie:admin.cookie,body:{}})).statusCode,409);
});

test('invoice Stripe adapter sends CAD and card-only Checkout with server amount and stable idempotency',async()=>{
  let captured;const gateway=invoiceGateway({paymentProvider:'stripe',stripeKey:'sk_test_fixture',siteUrl:origin},{stripe:{checkout:{sessions:{create:async(body,options)=>{captured={body,options};return{id:'cs_test',url:'https://checkout.stripe.com/test'};}}}}});
  await gateway.create({id:'p',amount_minor:9999,expires_at:new Date(Date.now()+35*60000).toISOString()},{id:'i',customer_email:'buyer@example.invalid',number:'VII-DEMO'});
  assert.equal(captured.body.line_items[0].price_data.unit_amount,9999);assert.equal(captured.body.line_items[0].price_data.currency,'cad');assert.deepEqual(captured.body.payment_method_types,['card']);assert.equal(captured.options.idempotencyKey,'phase2-invoice-p');assert.equal(captured.body.metadata.phase2_invoice_id,'i');
});

test('service operations preserve acceptance, require administrator review and attach private PDF snapshots',async t=>{
  const f=await fixture(t),{call,commercial:db,admin,seller}=f,buyer=await f.customer('changes@example.invalid'),other=await f.customer('unrelated@example.invalid'),p=await f.proposal(buyer),c=await f.createContract(p);await f.accept(c,buyer);
  let visits=(await call('/api/client/visits',{cookie:buyer.cookie})).json().items;
  const original=(await call('/api/client/contracts/'+c.id,{cookie:buyer.cookie})).json(),date=new Date(visits[0].service_date);date.setUTCDate(date.getUTCDate()+1);
  const change={contract_id:c.id,visit_id:visits[0].id,kind:'reschedule',requested_date:date.toISOString().slice(0,10),requested_window:'10:00-13:00',reason:'Please coordinate this demonstration change',idempotency_key:randomUUID()};
  const created=await call('/api/client/changes',{method:'POST',cookie:buyer.cookie,body:change});assert.equal(created.statusCode,200,created.body);const id=created.json().id;
  assert.equal((await call('/api/client/changes',{method:'POST',cookie:buyer.cookie,body:change})).json().id,id);
  assert.equal((await call('/api/client/changes',{method:'POST',cookie:other.cookie,body:{...change,idempotency_key:randomUUID()}})).statusCode,404);
  assert.equal((await call('/api/client/visits',{cookie:buyer.cookie})).json().items[0].service_date,visits[0].service_date);
  assert.equal((await call('/api/commercial/changes/'+id+'/resolve',{method:'POST',cookie:seller.cookie,body:{action:'approve',revision:1,resolution:'Available'}})).statusCode,403);
  assert.equal((await call('/api/commercial/changes/'+id+'/resolve',{method:'POST',cookie:admin.cookie,body:{action:'approve',revision:2,resolution:'Available'}})).statusCode,409);
  const decision=await call('/api/commercial/changes/'+id+'/resolve',{method:'POST',cookie:admin.cookie,body:{action:'approve',revision:1,resolution:'New date and access confirmed'}});assert.equal(decision.statusCode,200,decision.body);
  const updated=(await call('/api/client/visits',{cookie:buyer.cookie})).json().items.find(v=>v.id===visits[0].id);assert.equal(updated.service_date,change.requested_date);assert.equal(updated.amount_minor,visits[0].amount_minor);
  assert.equal((await call('/api/client/contracts/'+c.id,{cookie:buyer.cookie})).json().snapshot_hash,original.snapshot_hash);
  await call('/api/commercial/operations/settings',{method:'PUT',cookie:admin.cookie,body:{visit_reminders:true,invoice_reminders:false}});
  const dayBefore=new Date(change.requested_date+'T12:00:00Z');dayBefore.setUTCDate(dayBefore.getUTCDate()-1);
  for(let n=0;n<2;n++)await processServiceOperations(db,{},origin,{now:dayBefore});
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM commercial_mail WHERE dedupe=$1",['visit-reminder:'+visits[0].id+':'+change.requested_date])).rows[0].n,1);
  assert.equal((await call('/api/client/changes/'+id+'/withdraw',{method:'POST',cookie:buyer.cookie,body:{}})).statusCode,409);
  assert.equal((await call('/api/client/contracts/'+c.id+'/pdf',{cookie:other.cookie})).statusCode,404);
  const pdf=await call('/api/client/contracts/'+c.id+'/pdf',{cookie:buyer.cookie});assert.equal(pdf.statusCode,200,pdf.body);assert.equal(pdf.rawPayload.subarray(0,5).toString(),'%PDF-');
  const saved=(await db.query('SELECT attachments FROM commercial_mail WHERE dedupe=$1',['contract:'+c.id+':sent'])).rows[0].attachments[0];assert.equal(saved.record.acceptance,null);
  const accepted=(await db.query('SELECT attachments FROM commercial_mail WHERE dedupe=$1',['contract:'+c.id+':accepted:customer'])).rows[0].attachments[0];assert.equal(accepted.record.acceptance.signed_name,buyer.profile.name);
  // Issue a completed visit before ending the remaining schedule; its invoice survives.
  await call('/api/commercial/visits/'+visits[0].id+'/status',{method:'POST',cookie:admin.cookie,body:{status:'completed'}});
  const invoice=await call('/api/commercial/invoices',{method:'POST',cookie:admin.cookie,body:{contract_id:c.id,period:change.requested_date.slice(0,7),visit_id:visits[0].id}});assert.equal(invoice.statusCode,200,invoice.body);
  await db.query("UPDATE service_invoices SET due_date=($2::date-1) WHERE id=$1",[invoice.json().id,serviceToday()]);
  await call('/api/commercial/operations/settings',{method:'PUT',cookie:admin.cookie,body:{visit_reminders:false,invoice_reminders:true}});
  for(let n=0;n<2;n++)await processServiceOperations(db,{},origin);
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM commercial_mail WHERE dedupe LIKE $1",['invoice-reminder:'+invoice.json().id+':%'])).rows[0].n,1);
  const termination=await call('/api/client/changes',{method:'POST',cookie:buyer.cookie,body:{contract_id:c.id,kind:'terminate',reason:'End the demonstration agreement',requested_date:serviceToday(),idempotency_key:randomUUID()}});assert.equal(termination.statusCode,200,termination.body);
  const path='/api/commercial/changes/'+termination.json().id+'/resolve',body={action:'approve',revision:1,resolution:'Notice exception approved; financial adjustments require separate review',effective_date:serviceToday()};
  assert.equal((await call(path,{method:'POST',cookie:admin.cookie,body})).statusCode,409);
  assert.equal((await call(path,{method:'POST',cookie:admin.cookie,body:{...body,notice_waiver:true}})).statusCode,200);
  const processed=await processServiceOperations(db,{adminEmail:'team@example.invalid'},origin);assert.equal(processed.terminations,1);assert.equal((await processServiceOperations(db,{},origin)).terminations,0);
  const ended=(await call('/api/client/contracts/'+c.id,{cookie:buyer.cookie})).json();assert.equal(ended.status,'cancelled');assert.equal(ended.acceptance.evidence_hash,original.acceptance.evidence_hash);
  assert.equal((await call('/api/client/invoices/'+invoice.json().id+'/payment',{method:'POST',cookie:buyer.cookie,body:{}})).statusCode,200);
  assert.equal((await call('/api/client/visits',{cookie:buyer.cookie})).json().items.find(v=>v.id===visits[1].id).status,'cancelled');
});

test('launch preparation masks connector credentials, rejects stale saves and cannot enable live payments',async t=>{
  const secret='test-only-private-provider-token',f=await fixture(t,{connectionEnvironment:{PHASE2_LODGIFY_API_KEY:secret}}),{call,admin,seller}=f;
  assert.equal((await call('/api/commercial/setup',{cookie:seller.cookie})).statusCode,403);
  const setup=await call('/api/commercial/setup',{cookie:admin.cookie});assert.equal(setup.statusCode,200);assert.ok(!setup.body.includes(secret));assert.equal(setup.json().approved_for_production,false);assert.equal(setup.json().connections.find(c=>c.provider==='lodgify').adapter_implemented,false);
  const body={approved:true,note:'Demo review only, not production approval',revision:0};assert.equal((await call('/api/commercial/setup/approvals/prices',{method:'PUT',cookie:admin.cookie,body})).statusCode,200);
  assert.equal((await call('/api/commercial/setup/approvals/prices',{method:'PUT',cookie:admin.cookie,body})).statusCode,409);
  assert.equal((await call('/api/config')).json().payment,'demo');
  const mapping={account_reference:'Demonstration account',mappings:[{external_id:'external-1',local_id:'local-1',kind:'property'}],revision:0};assert.equal((await call('/api/commercial/setup/connections/lodgify',{method:'PUT',cookie:admin.cookie,body:mapping})).statusCode,200);
  assert.equal((await call('/api/commercial/setup/connections/lodgify',{method:'PUT',cookie:admin.cookie,body:{...mapping,revision:1,mappings:[...mapping.mappings,...mapping.mappings]}})).statusCode,400);
  assert.equal((await call('/api/commercial/operations/settings',{method:'PUT',cookie:seller.cookie,body:{visit_reminders:true,invoice_reminders:true}})).statusCode,403);
});

test('remote database adapter commits, rolls back and releases connections without TLS downgrade',async()=>{
  assert.equal(databaseIdentity('postgresql://user:secret@example.invalid/db'),'example.invalid:5432/db');assert.throws(()=>databaseIdentity('postgresql://example.invalid/db?sslmode=disable'));
  const commands=[];let released=0,options;
  class Pool{constructor(o){options=o;}on(){}async query(sql){commands.push(sql);return{rows:[]};}async connect(){return{query:this.query.bind(this),release:()=>released++};}async end(){}}
  const db=postgresDatabase('postgresql://user:secret@example.invalid/db',{Pool});await db.waitReady;
  await db.transaction(tx=>tx.query('SELECT 2'));assert.ok(commands.includes('COMMIT'));
  await assert.rejects(db.transaction(async()=>{throw Error('Fixture failure');}));assert.ok(commands.includes('ROLLBACK'));assert.equal(released,2);assert.equal(options.ssl.rejectUnauthorized,true);await db.close();
});
