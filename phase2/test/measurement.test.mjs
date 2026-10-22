import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openPhase2Databases} from '../database.mjs';
import {seedPhase2,demoCredentials} from '../bootstrap.mjs';
import {buildPhase2App} from '../app.mjs';
import {secretVault,totp} from '../security.mjs';
import {cleanupMeasurement} from '../measurement.mjs';

test('measurement remains local, consent-gated, revocable and server-authoritative',async t=>{
  const dbs=await openPhase2Databases('',{memory:true});t.after(()=>dbs.close());await seedPhase2(dbs);
  const db=dbs.commercial,app=await buildPhase2App(dbs,secretVault(Buffer.alloc(32,14)),{testing:true});t.after(()=>app.close());
  const origin='http://127.0.0.1:3030';
  const call=(url,{method='GET',cookie,body,headers={}}={})=>app.inject({url,method,headers:{origin,...(cookie?{cookie}:{}),...headers},payload:body});
  const login=async credentials=>{const c=(await call('/api/commercial/login',{method:'POST',body:credentials})).json();const r=await call('/api/commercial/verify',{method:'POST',body:{challenge:c.challenge,code:totp(c.secret)}});assert.equal(r.statusCode,200);return r.headers['set-cookie'].split(';')[0];};
  const admin=await login(demoCredentials.admin),seller=await login(demoCredentials.seller);
  let version,privacyCookie,clientCookie;
  const preferences=async(statistics,cookie=privacyCookie,headers={})=>call('/api/privacy/preferences',{method:'PUT',cookie,headers,body:{statistics,marketing:false,policy_version:version}});
  await t.test('no optional measurement or tracking cookie before approval/choice; dashboards are administrator-only',async()=>{
    const initial=await call('/api/privacy/preferences');version=initial.json().policy_version;
    assert.equal(initial.json().statistics,false);assert.equal(initial.json().chosen,false);assert.equal(initial.json().external_enabled,false);assert.equal(initial.headers['set-cookie'],undefined);
    assert.equal((await call('/api/commercial/measurement')).statusCode,401);assert.equal((await call('/api/commercial/measurement',{cookie:seller})).statusCode,403);
    assert.equal((await call('/api/commercial/measurement/settings',{method:'PUT',cookie:admin,body:{journal_enabled:true,retention_days:30,revision:0}})).statusCode,409);
    const pending=await preferences(true);assert.equal(pending.json().statistics,false);privacyCookie=pending.headers['set-cookie'].split(';')[0];
    assert.equal((await call('/api/measurement/events',{method:'POST',cookie:privacyCookie,body:{event_id:randomUUID(),name:'page_view',section:'home'}})).json().recorded,false);
    assert.ok(!(await call('/admin')).body.includes('/consent.js'));assert.ok((await call('/viilife')).body.includes('/consent.js'));
  });
  await t.test('approval and explicit statistics choice enable only whitelisted events; forged purchases and PII are rejected',async()=>{
    const approval=await call('/api/commercial/setup/approvals/privacy',{method:'PUT',cookie:admin,body:{approved:true,note:'Isolated technical fixture approval',revision:0}});assert.equal(approval.statusCode,200);
    const state=await call('/api/privacy/preferences',{cookie:privacyCookie});assert.equal(state.json().chosen,false);version=state.json().policy_version;
    const enable=await call('/api/commercial/measurement/settings',{method:'PUT',cookie:admin,body:{journal_enabled:true,retention_days:30,revision:0}});assert.equal(enable.statusCode,200);
    const consent=await preferences(true);privacyCookie=consent.headers['set-cookie'].split(';')[0];assert.equal(consent.json().statistics,true);
    const id=randomUUID(),event={event_id:id,name:'page_view',section:'viilife'};
    assert.equal((await call('/api/measurement/events',{method:'POST',cookie:privacyCookie,body:event})).json().recorded,true);
    assert.equal((await call('/api/measurement/events',{method:'POST',cookie:privacyCookie,body:event})).json().recorded,false);
    assert.equal((await call('/api/measurement/events',{method:'POST',cookie:privacyCookie,body:{...event,event_id:randomUUID(),name:'purchase'}})).statusCode,400);
    assert.equal((await call('/api/measurement/events',{method:'POST',cookie:privacyCookie,body:{...event,email:'not-stored@example.invalid'}})).statusCode,400);
    assert.equal((await call('/api/measurement/events',{method:'POST',cookie:privacyCookie,headers:{origin:'https://outside.invalid'},body:event})).statusCode,403);
    const dashboard=await call('/api/commercial/measurement',{cookie:admin});assert.equal(dashboard.json().events.length,1);assert.ok(!dashboard.body.includes('token_hash'));assert.ok(!dashboard.body.includes('consent_id'));
  });
  await t.test('successful enquiries are counted once from the backend without saving form contacts',async()=>{
    const register=await call('/api/client/register',{method:'POST',body:{name:'Journal fixture customer',email:'journal-fixture@example.invalid',password:'Fixture-Customer-2026!'}});
    const mail=(await db.query("SELECT body FROM commercial_mail WHERE recipient='journal-fixture@example.invalid' ORDER BY created_at DESC LIMIT 1")).rows[0];
    const verified=await call('/api/client/verify',{method:'POST',body:{challenge:register.json().challenge,code:mail.body.match(/code is (\d{6})/)[1]}});assert.equal(verified.statusCode,200);clientCookie=verified.headers['set-cookie'].split(';')[0];
    const body={service:'home',phone:'+12505550000',company:'',address:'Private address not in journal',sqft:1200,message:'Private message not in journal',consent:true,idempotency_key:randomUUID()};
    for(let i=0;i<2;i++)assert.equal((await call('/api/client/requests',{method:'POST',cookie:clientCookie+'; '+privacyCookie,body})).statusCode,200);
    const events=(await db.query("SELECT * FROM measurement_events WHERE name='generate_lead'")).rows;assert.equal(events.length,1);assert.deepEqual(events[0].params,{});
    const journal=JSON.stringify((await db.query('SELECT params FROM measurement_events')).rows);assert.ok(!journal.includes('Private'));assert.ok(!journal.includes('journal-fixture'));
  });
  await t.test('checkout attribution uses buyer consent; only confirmed simulation records purchase once',async()=>{
    await call('/api/commercial/shop-channel/examples',{method:'POST',cookie:admin,body:{confirm:true}});
    const product=(await call('/api/shop-channel/catalogue')).json().items[0],variant=product.variants[0];
    const begin=await call('/api/client/shop-channel/checkouts',{method:'POST',cookie:clientCookie+'; '+privacyCookie,body:{idempotency_key:randomUUID(),consent:true,lines:[{variant_id:variant.id,quantity:1}]}});assert.equal(begin.statusCode,200,begin.body);const id=begin.json().id;
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM measurement_events WHERE name='purchase'")).rows[0].n,0);
    for(let i=0;i<2;i++)assert.equal((await call('/api/commercial/shop-channel/checkouts/'+id+'/simulate-paid',{method:'POST',cookie:admin,body:{}})).statusCode,200);
    const purchase=(await db.query("SELECT params FROM measurement_events WHERE name='purchase'")).rows;assert.equal(purchase.length,1);assert.equal(purchase[0].params.currency,'CAD');assert.equal(purchase[0].params.amount_minor,begin.json().total_minor);
    assert.equal((await call('/cliente?payment=success')).statusCode,200);assert.equal((await db.query("SELECT count(*)::integer AS n FROM measurement_events WHERE name='purchase'")).rows[0].n,1);
  });
  await t.test('ViiLife invoice payment creates a server-confirmed conversion, not a return-page purchase',async()=>{
    const lead=(await db.query("SELECT id FROM crm_leads WHERE email='journal-fixture@example.invalid' ORDER BY created_at DESC LIMIT 1")).rows[0].id;
    const owner=(await db.query("SELECT id FROM team_users WHERE role='admin' ORDER BY created_at LIMIT 1")).rows[0].id;
    const quote=randomUUID(),contract=randomUUID(),invoice=randomUUID();
    await db.query("INSERT INTO service_quotes(id,lead_id,actor_id,selection,result,status) VALUES($1,$2,$3,'{}','{}','approved')",[quote,lead,owner]);
    await db.query("INSERT INTO service_contracts(id,quote_id,lead_id,seller_id,customer_email,status,snapshot,snapshot_hash) VALUES($1,$2,$3,$4,'journal-fixture@example.invalid','accepted',$5,$6)",[contract,quote,lead,owner,JSON.stringify({segment:'home'}),'0'.repeat(64)]);
    const snapshot={customer:{name:'Journal fixture customer'},payment_terms:'Fixture',lines:[],exclusions:[]};
    await db.query("INSERT INTO service_invoices(id,contract_id,number,customer_email,total_minor,period,snapshot,due_date) VALUES($1,$2,'JOURNAL-INVOICE','journal-fixture@example.invalid',12000,'fixture',$3,now()::date)",[invoice,contract,JSON.stringify(snapshot)]);
    const prepared=await call('/api/client/invoices/'+invoice+'/payment',{method:'POST',cookie:clientCookie+'; '+privacyCookie,body:{}});assert.equal(prepared.statusCode,200,prepared.body);
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM measurement_events WHERE name='purchase' AND section='viilife'")).rows[0].n,0);
    for(let i=0;i<2;i++)assert.equal((await call('/api/commercial/invoices/'+invoice+'/simulate-payment',{method:'POST',cookie:admin,body:{}})).statusCode,200);
    const events=(await db.query("SELECT params FROM measurement_events WHERE name='purchase' AND section='viilife'")).rows;assert.equal(events.length,1);assert.deepEqual(events[0].params,{amount_minor:12000,currency:'CAD'});
  });
  await t.test('existing ViiShop and ViiConcierge checkouts record only confirmed CAD payments',async()=>{
    const cookie=clientCookie+'; '+privacyCookie;
    const products=(await call('/api/products?limit=100',{cookie})).json().items;
    const product=(await call('/api/products/'+products[0].slug,{cookie})).json(),variant=product.variants[0];
    assert.equal((await call('/api/cart/items/'+variant.id,{method:'PUT',cookie,body:{quantity:1}})).statusCode,200);
    const customer={name:'Journal fixture customer',email:'journal-fixture@example.invalid',phone:'+12505550000',consent:true};
    const order=await call('/api/orders',{method:'POST',cookie,headers:{'idempotency-key':randomUUID()},body:{customer,currency:'CAD',delivery:'pickup'}});assert.equal(order.statusCode,201,order.body);
    const props=(await call('/api/properties?limit=100',{cookie})).json().items;
    const start=new Date(Date.now()+30*86400000).toISOString().slice(0,10),end=new Date(Date.now()+34*86400000).toISOString().slice(0,10);
    const booking=await call('/api/bookings',{method:'POST',cookie,headers:{'idempotency-key':randomUUID()},body:{property_id:props[0].id,check_in:start,check_out:end,guests:1,customer,currency:'CAD',pay:'full'}});assert.equal(booking.statusCode,201,booking.body);
    const before=(await db.query("SELECT count(*)::integer AS n FROM measurement_events WHERE name='purchase'")).rows[0].n;
    for(const c of [order.json(),booking.json()]){
      const payment=await call('/api/checkouts/'+c.id+'/payment',{method:'POST',cookie});assert.equal(payment.statusCode,200,payment.body);
      for(let i=0;i<2;i++)assert.equal((await call('/api/admin/payments/'+c.id+'/simulate',{method:'POST',cookie:admin,body:{event_id:randomUUID(),outcome:'paid'}})).statusCode,200);
    }
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM measurement_events WHERE name='purchase'")).rows[0].n,before+2);
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM measurement_events WHERE name='purchase' AND section='viiconcierge'")).rows[0].n,1);
  });
  await t.test('GPC blocks collection and preference updates revoke previous attribution/events',async()=>{
    const gpcState=(await call('/api/privacy/preferences',{cookie:privacyCookie,headers:{'sec-gpc':'1'}})).json();assert.equal(gpcState.statistics,false);assert.equal(gpcState.requires_gpc_reset,true);
    assert.equal((await call('/api/measurement/events',{method:'POST',cookie:privacyCookie,headers:{'sec-gpc':'1'},body:{event_id:randomUUID(),name:'page_view',section:'home'}})).json().recorded,false);
    const denied=await preferences(true,privacyCookie,{'sec-gpc':'1'});assert.equal(denied.json().statistics,false);privacyCookie=denied.headers['set-cookie'].split(';')[0];
    const remembered=(await call('/api/privacy/preferences',{cookie:privacyCookie,headers:{'sec-gpc':'1'}})).json();assert.equal(remembered.chosen,true);assert.equal(remembered.requires_gpc_reset,false);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM measurement_events')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::integer AS n FROM measurement_links')).rows[0].n,0);
    assert.equal((await call('/api/measurement/events',{method:'POST',cookie:privacyCookie,body:{event_id:randomUUID(),name:'page_view',section:'home'}})).json().recorded,false);
  });
  await t.test('stale notices require a new choice; event retention does not touch operational data',async()=>{
    const consent=await preferences(true);privacyCookie=consent.headers['set-cookie'].split(';')[0];
    await call('/api/measurement/events',{method:'POST',cookie:privacyCookie,body:{event_id:randomUUID(),name:'page_view',section:'home'}});
    await db.query("UPDATE measurement_events SET created_at=now()-interval '45 days'");await cleanupMeasurement(db);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM measurement_events')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::integer AS n FROM channel_orders')).rows[0].n,1);
    await call('/api/commercial/setup/approvals/privacy',{method:'PUT',cookie:admin,body:{approved:true,note:'Isolated updated notice',revision:1}});
    assert.equal((await call('/api/privacy/preferences',{cookie:privacyCookie})).json().chosen,false);
    assert.equal((await preferences(true)).statusCode,409);
    assert.equal((await call('/api/measurement/events',{method:'POST',cookie:privacyCookie,body:{event_id:randomUUID(),name:'page_view',section:'home'}})).json().recorded,false);
  });
});
