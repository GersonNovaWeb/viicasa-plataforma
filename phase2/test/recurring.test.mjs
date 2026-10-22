import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openPhase2Databases} from '../database.mjs';
import {seedPhase2,demoCredentials} from '../bootstrap.mjs';
import {buildPhase2App} from '../app.mjs';
import {secretVault,totp} from '../security.mjs';
import {agreementTerms,plannedVisits,snapshotHash} from '../agreement-content.mjs';
import {quoteService} from '../service-menu.mjs';
import {prepareRecurring} from '../recurring.mjs';
import {serviceToday} from '../service-operations.mjs';

const origin='http://127.0.0.1:3030';
async function fixture(t,options={}){
  const dbs=await openPhase2Databases('',{memory:true});t.after(()=>dbs.close());await seedPhase2(dbs);
  const db=dbs.commercial,app=await buildPhase2App(dbs,secretVault(Buffer.alloc(32,16)),{testing:true,...options});t.after(()=>app.close());
  const call=(url,{method='GET',cookie,body,headers={}}={})=>app.inject({url,method,headers:{origin,...(cookie?{cookie}:{}),...headers},payload:body});
  const login=async credentials=>{const c=(await call('/api/commercial/login',{method:'POST',body:credentials})).json();const r=await call('/api/commercial/verify',{method:'POST',body:{challenge:c.challenge,code:totp(c.secret)}});assert.equal(r.statusCode,200,r.body);return{cookie:r.headers['set-cookie'].split(';')[0],user:r.json().user};};
  const admin=await login(demoCredentials.admin),seller=await login(demoCredentials.seller);
  const customer=async email=>{
    const c=(await call('/api/client/register',{method:'POST',body:{name:'Alex Example',email,password:'Recurring-Demo-2026!'}})).json();
    const mail=(await db.query("SELECT body FROM commercial_mail WHERE recipient=$1 AND subject LIKE '%Verify your email%' ORDER BY created_at DESC LIMIT 1",[email])).rows[0];
    const r=await call('/api/client/verify',{method:'POST',body:{challenge:c.challenge,code:mail.body.match(/code is (\d{6})/)[1]}});assert.equal(r.statusCode,200,r.body);return{cookie:r.headers['set-cookie'].split(';')[0],profile:r.json().profile};
  };
  const buyer=await customer('recurring@example.invalid'),other=await customer('other@example.invalid');
  const schedule=async({segment='home',frequency='weekly',owner=seller.user.id}={})=>{
    const lead=randomUUID(),qid=randomUUID(),cid=randomUUID();
    await db.query("INSERT INTO crm_leads(id,owner_id,name,email,phone,company,service,stage,priority,source) VALUES($1,$2,'Alex Example',$3,'+12505550111','',$4,'won','normal','Isolated test')",[lead,owner,buyer.profile.email,segment]);
    const selection={service_id:segment==='home'?'home-standard':'commercial-team',rate_minor:segment==='home'?11000:7500,quantity:segment==='home'?1:2,visits:frequency==='once'?1:2,frequency,term:segment==='home'?'month_to_month':'annual'};
    const q=quoteService(selection);
    const date=new Date();date.setUTCDate(date.getUTCDate()-15);
    const details={first_service_date:date.toISOString().slice(0,10),arrival_window:'09:00–12:00',billing_contact:'Alex Example',properties:[{address:'123 Demo Street',type:segment==='home'?'house':'office',sqft:2000}]};
    const snapshot={segment,customer:{name:buyer.profile.name,email:buyer.profile.email},quote:q,details,terms:agreementTerms(segment),visits:plannedVisits(q,details)};
    await db.query("INSERT INTO service_quotes(id,lead_id,actor_id,selection,result,status) VALUES($1,$2,$3,$4,$5,'approved')",[qid,lead,owner,JSON.stringify(selection),JSON.stringify(q)]);
    await db.query("INSERT INTO service_contracts(id,quote_id,lead_id,seller_id,customer_email,status,snapshot,snapshot_hash,accepted_by,acceptance) VALUES($1,$2,$3,$4,$5,'accepted',$6,$7,$8,$9)",[cid,qid,lead,owner,buyer.profile.email,JSON.stringify(snapshot),snapshotHash(snapshot),buyer.profile.id,JSON.stringify({consent:true})]);
    const visits=[];
    for(const v of snapshot.visits){const id=randomUUID();visits.push({...v,id});await db.query("INSERT INTO service_visits(id,contract_id,property_index,service_date,arrival_window,address,amount_minor,discount_minor,status,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'completed',now())",[id,cid,v.property_index,v.service_date,v.arrival_window,v.address,v.amount_minor,v.discount_minor]);}
    const issue=async(index=0)=>{const body={contract_id:cid,period:visits[index].service_date.slice(0,7),...(segment==='home'?{visit_id:visits[index].id}:{})};const r=await call('/api/commercial/invoices',{method:'POST',cookie:admin.cookie,body});assert.equal(r.statusCode,200,r.body);return r.json().id;};
    return{id:cid,lead,visits,snapshot,issue};
  };
  const authorize=async c=>{const body={snapshot_hash:snapshotHash(c.snapshot),signed_name:buyer.profile.name,consent:true,demo_acknowledged:true};const r=await call('/api/client/contracts/'+c.id+'/authorize-demo',{method:'POST',cookie:buyer.cookie,body});assert.equal(r.statusCode,200,r.body);return{id:r.json().id,body};};
  const settings=async enabled=>{const r=await call('/api/commercial/recurring/settings',{method:'PUT',cookie:admin.cookie,body:{enabled,retry_limit:3}});assert.equal(r.statusCode,200,r.body);};
  const activate=async a=>{const r=await call('/api/commercial/recurring/'+a.id+'/status',{method:'POST',cookie:admin.cookie,body:{revision:1,status:'active',reason:'Isolated demo review'}});assert.equal(r.statusCode,200,r.body);};
  const job=async invoice=>(await db.query('SELECT * FROM recurring_jobs WHERE invoice_id=$1',[invoice])).rows[0];
  const simulate=async j=>(await call('/api/commercial/recurring/jobs/'+j.id+'/simulate',{method:'POST',cookie:admin.cookie,body:{revision:j.revision,request_id:randomUUID(),outcome:'paid'}}));
  return{db,app,call,admin,seller,buyer,other,schedule,authorize,settings,activate,job,simulate};
}

test('recurring demo: separate consent, due invoices, bounded collection, recovery and ACL',async t=>{
  const f=await fixture(t),{db,call,admin,seller,buyer,other}=f;
  await t.test('default disabled; separate consent never taken from acceptance; role and origin guards',async()=>{
    assert.equal((await prepareRecurring(db)).disabled,true);
    assert.equal((await call('/api/commercial/recurring')).statusCode,401);
    assert.equal((await call('/api/commercial/recurring/settings',{method:'PUT',cookie:seller.cookie,body:{enabled:true,retry_limit:3}})).statusCode,403);
    assert.equal((await call('/api/client/recurring',{cookie:admin.cookie})).statusCode,401);
    const c=await f.schedule(),i=await c.issue();
    await f.settings(true);assert.equal((await prepareRecurring(db)).prepared,0);assert.equal(await f.job(i),undefined);
    const body={snapshot_hash:snapshotHash(c.snapshot),signed_name:buyer.profile.name,consent:true,demo_acknowledged:true};
    assert.equal((await call('/api/client/contracts/'+c.id+'/authorize-demo',{method:'POST',cookie:other.cookie,body})).statusCode,404);
    assert.equal((await call('/api/client/contracts/'+c.id+'/authorize-demo',{method:'POST',cookie:buyer.cookie,headers:{origin:'https://outside.invalid'},body})).statusCode,403);
    assert.equal((await call('/api/client/contracts/'+c.id+'/authorize-demo',{method:'POST',cookie:buyer.cookie,body:{...body,consent:false}})).statusCode,400);
    assert.equal((await call('/api/client/contracts/'+c.id+'/authorize-demo',{method:'POST',cookie:buyer.cookie,body:{...body,card_number:'4242424242424242'}})).statusCode,400);
    const a=await f.authorize(c);assert.equal((await f.authorize(c)).id,a.id);assert.equal((await prepareRecurring(db)).prepared,0);
    await f.activate(a);assert.equal((await prepareRecurring(db)).prepared,1);assert.equal((await prepareRecurring(db)).prepared,0);
    const j=await f.job(i);assert.equal((await db.query('SELECT status FROM service_invoices WHERE id=$1',[i])).rows[0].status,'issued');
    const visible=(await call('/api/commercial/recurring',{cookie:seller.cookie})).json();assert.ok(visible.items.some(x=>x.id===a.id));
    await db.query('UPDATE crm_leads SET owner_id=$2 WHERE id=$1',[c.lead,admin.user.id]);assert.ok(!(await call('/api/commercial/recurring',{cookie:seller.cookie})).json().items.some(x=>x.id===a.id));
    assert.equal((await call('/api/client/recurring',{cookie:other.cookie})).json().items.length,0);
    const key=randomUUID(),body2={revision:j.revision,request_id:key,outcome:'paid'};
    const url='/api/commercial/recurring/jobs/'+j.id+'/simulate';
    assert.equal((await call(url,{method:'POST',cookie:seller.cookie,body:body2})).statusCode,403);
    const results=await Promise.all([call(url,{method:'POST',cookie:admin.cookie,body:body2}),call(url,{method:'POST',cookie:admin.cookie,body:body2})]);assert.ok(results.every(r=>r.statusCode===200),results.map(r=>r.body).join('\n'));
    assert.equal((await call(url,{method:'POST',cookie:admin.cookie,body:{...body2,outcome:'failed'}})).statusCode,409);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM recurring_attempts WHERE job_id=$1',[j.id])).rows[0].n,1);
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM commercial_mail WHERE dedupe=$1",['invoice:'+i+':paid:customer'])).rows[0].n,1);
    const receipt=(await db.query('SELECT * FROM commercial_mail WHERE dedupe=$1',['invoice:'+i+':paid:customer'])).rows[0];assert.equal(receipt.recipient,buyer.profile.email);assert.equal(receipt.attachments.length,1);
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM commercial_sales WHERE reference=(SELECT number FROM service_invoices WHERE id=$1)',[i])).rows[0].n,1);
  });
  await t.test('retries manual and bounded; action-required has no automatic retry and no receipt',async()=>{
    const c=await f.schedule(),i=await c.issue(),a=await f.authorize(c);await f.activate(a);await prepareRecurring(db);
    let j=await f.job(i);
    for(let n=0;n<3;n++){
      const r=await call('/api/commercial/recurring/jobs/'+j.id+'/simulate',{method:'POST',cookie:admin.cookie,body:{revision:j.revision,request_id:randomUUID(),outcome:'failed'}});assert.equal(r.statusCode,200,r.body);j=await f.job(i);
    }
    assert.equal((await f.simulate(j)).statusCode,409);
    assert.equal((await db.query('SELECT status FROM service_invoices WHERE id=$1',[i])).rows[0].status,'issued');
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM commercial_mail WHERE dedupe=$1',['invoice:'+i+':paid:customer'])).rows[0].n,0);
    const notices=(await db.query("SELECT * FROM commercial_mail WHERE dedupe LIKE 'recurring-attempt:%:customer'")).rows;assert.equal(notices.length,3);assert.ok(notices.every(m=>m.recipient===buyer.profile.email&&m.body.includes('/cliente?invoice=')));
    const c2=await f.schedule(),i2=await c2.issue(),a2=await f.authorize(c2);await f.activate(a2);await prepareRecurring(db);const j2=await f.job(i2);
    assert.equal((await call('/api/commercial/recurring/jobs/'+j2.id+'/simulate',{method:'POST',cookie:admin.cookie,body:{revision:1,request_id:randomUUID(),outcome:'action_required'}})).statusCode,200);
    assert.equal((await f.simulate(await f.job(i2))).statusCode,409);
    // Existing manual invoice payment remains available to resolve action-required.
    assert.equal((await call('/api/client/invoices/'+i2+'/payment',{method:'POST',cookie:buyer.cookie,body:{}})).statusCode,200);
    assert.equal((await call('/api/commercial/invoices/'+i2+'/simulate-payment',{method:'POST',cookie:admin.cookie,body:{}})).statusCode,200);
    await prepareRecurring(db);assert.equal((await f.job(i2)).status,'paid');
  });
  await t.test('revocation cannot be overridden, keeps issued invoice and prevents further simulation',async()=>{
    const c=await f.schedule(),i=await c.issue(),a=await f.authorize(c);await f.activate(a);await prepareRecurring(db);const j=await f.job(i);
    assert.equal((await call('/api/client/recurring/'+a.id+'/revoke',{method:'POST',cookie:other.cookie,body:{revision:2}})).statusCode,404);
    assert.equal((await call('/api/client/recurring/'+a.id+'/revoke',{method:'POST',cookie:buyer.cookie,body:{revision:1}})).statusCode,409);
    assert.equal((await call('/api/client/recurring/'+a.id+'/revoke',{method:'POST',cookie:buyer.cookie,body:{revision:2}})).statusCode,200);
    assert.equal((await f.simulate(j)).statusCode,409);
    assert.equal((await call('/api/commercial/recurring/'+a.id+'/status',{method:'POST',cookie:admin.cookie,body:{revision:3,status:'active',reason:'Try override'}})).statusCode,409);
    assert.equal((await db.query('SELECT status FROM service_invoices WHERE id=$1',[i])).rows[0].status,'issued');
    assert.equal((await db.query('SELECT status FROM service_contracts WHERE id=$1',[c.id])).rows[0].status,'accepted');
  });
  await t.test('commercial Net15 is not collected early; scheduled and missed visits are excluded',async()=>{
    const c=await f.schedule({segment:'commercial'}),i=await c.issue(),a=await f.authorize(c);await f.activate(a);await prepareRecurring(db);assert.equal(await f.job(i),undefined);
    await db.query("UPDATE service_invoices SET due_date=$2 WHERE id=$1",[i,serviceToday()]);await prepareRecurring(db);assert.ok(await f.job(i));
    const c2=await f.schedule(),i2=await c2.issue(),a2=await f.authorize(c2);await f.activate(a2);
    await db.query("UPDATE service_visits SET status='missed' WHERE id=$1",[c2.visits[0].id]);await prepareRecurring(db);assert.equal(await f.job(i2),undefined);
    await db.query("UPDATE service_visits SET status='scheduled' WHERE id=$1",[c2.visits[0].id]);await prepareRecurring(db);assert.equal(await f.job(i2),undefined);
    const once=await f.schedule({frequency:'once'});assert.equal((await call('/api/client/contracts/'+once.id+'/authorize-demo',{method:'POST',cookie:buyer.cookie,body:{snapshot_hash:snapshotHash(once.snapshot),signed_name:buyer.profile.name,consent:true,demo_acknowledged:true}})).statusCode,409);
  });
  await t.test('pause, disabled setting, immutable evidence and pending manual payment all block collection',async()=>{
    const c=await f.schedule(),i=await c.issue(),a=await f.authorize(c);await f.activate(a);await prepareRecurring(db);const j=await f.job(i);
    await f.settings(false);assert.equal((await f.simulate(j)).statusCode,409);await f.settings(true);
    const pause=await call('/api/commercial/recurring/'+a.id+'/status',{method:'POST',cookie:admin.cookie,body:{revision:2,status:'paused',reason:'Client request'}});assert.equal(pause.statusCode,200);
    assert.equal((await f.simulate(j)).statusCode,409);
    await call('/api/commercial/recurring/'+a.id+'/status',{method:'POST',cookie:admin.cookie,body:{revision:3,status:'active',reason:'Resume demo'}});
    await db.query("UPDATE recurring_authorizations SET consent=consent||'{\"signed_name\":\"Tampered\"}'::jsonb WHERE id=$1",[a.id]);assert.equal((await f.simulate(j)).statusCode,409);
    const c2=await f.schedule(),i2=await c2.issue(),a2=await f.authorize(c2);await f.activate(a2);await prepareRecurring(db);const j2=await f.job(i2);
    assert.equal((await call('/api/client/invoices/'+i2+'/payment',{method:'POST',cookie:buyer.cookie,body:{}})).statusCode,200);assert.equal((await f.simulate(j2)).statusCode,409);
  });
  await t.test('changed invoice totals and termination block collections; no extra visits or fees created',async()=>{
    const c=await f.schedule(),i=await c.issue(),a=await f.authorize(c);await f.activate(a);await prepareRecurring(db);const j=await f.job(i);
    await db.query('UPDATE service_invoices SET total_minor=total_minor+1 WHERE id=$1',[i]);assert.equal((await f.simulate(j)).statusCode,409);
    await db.query('UPDATE service_invoices SET total_minor=total_minor-1 WHERE id=$1',[i]);
    await db.query("UPDATE service_contracts SET status='cancelled' WHERE id=$1",[c.id]);assert.equal((await f.simulate(j)).statusCode,409);await prepareRecurring(db);assert.equal((await f.job(i)).status,'cancelled');
    assert.equal((await db.query('SELECT count(*)::integer AS n FROM service_visits WHERE contract_id=$1',[c.id])).rows[0].n,2);
  });
  await t.test('new modules served and both language/role panels present without third-party card collection',async()=>{
    for(const file of ['recurring-customer.js','recurring-workspace.js']){const r=await call('/'+file);assert.equal(r.statusCode,200);assert.ok(!r.body.includes('stripe.com/v1'));}
    assert.ok((await call('/portal.js')).body.includes("if(tab==='recurring')"));
    assert.ok((await call('/customer.js')).body.includes('renderCustomerRecurring'));
    assert.ok((await call('/recurring-customer.js')).body.includes('Revocar autorización'));
  });
  await t.test('the cumulative CAD limit covers the complete finite schedule, including previous manual payments',async()=>{
    const c=await f.schedule(),i=await c.issue(),i2=await c.issue(1),a=await f.authorize(c);await f.activate(a);await prepareRecurring(db);
    assert.equal((await f.simulate(await f.job(i))).statusCode,200);
    assert.equal((await f.simulate(await f.job(i2))).statusCode,200);
    const total=(await db.query("SELECT sum(total_minor) AS total FROM service_invoices WHERE contract_id=$1 AND status='paid'",[c.id])).rows[0].total;assert.equal(Number(total),c.snapshot.quote.total_minor);
    const c2=await f.schedule(),i3=await c2.issue(),i4=await c2.issue(1),a2=await f.authorize(c2);await f.activate(a2);await prepareRecurring(db);const j=await f.job(i3);
    // Corrupt legacy/manual history in an isolated DB; collector must fail closed.
    await db.query("UPDATE service_invoices SET status='paid',total_minor=$2 WHERE id=$1",[i4,c2.snapshot.quote.total_minor]);
    assert.equal((await f.simulate(j)).statusCode,409);assert.equal((await db.query('SELECT attempts FROM recurring_jobs WHERE id=$1',[j.id])).rows[0].attempts,0);
  });
});

test('recurring simulation is blocked with a Stripe invoice gateway and does not call it',async t=>{
  let calls=0;
  const f=await fixture(t,{serviceGateway:{provider:'stripe',create:async()=>{calls++;throw Error('Must not call Stripe');}}});
  const c=await f.schedule();
  const r=await f.call('/api/client/contracts/'+c.id+'/authorize-demo',{method:'POST',cookie:f.buyer.cookie,body:{snapshot_hash:snapshotHash(c.snapshot),signed_name:f.buyer.profile.name,consent:true,demo_acknowledged:true}});assert.equal(r.statusCode,409);
  assert.equal((await f.call('/api/commercial/recurring/settings',{method:'PUT',cookie:f.admin.cookie,body:{enabled:true,retry_limit:3}})).statusCode,409);
  assert.equal((await prepareRecurring(f.db,{provider:'stripe'})).disabled,true);assert.equal(calls,0);
});
