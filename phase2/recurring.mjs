import {randomUUID} from 'node:crypto';
import {fail} from '../viicasa-backend/src/lib.js';
import * as s from '../viicasa-backend/src/schemas.js';
import {audit} from './api.mjs';
import {snapshotHash} from './agreement-content.mjs';
import {serviceToday} from './service-operations.mjs';
import {queueCommercialMail,serviceMail} from './mail.mjs';
import {settleInvoiceInTransaction} from './agreements.mjs';
import {recordPaidMeasurement} from './measurement.mjs';
import {invoiceFinance} from './financial-core.mjs';

const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const iso=v=>new Date(v).toISOString().slice(0,10);
const numeric=row=>({...row,...Object.fromEntries(Object.entries(row).filter(([k])=>k.endsWith('_minor')).map(([k,v])=>[k,Number(v)]))});
const preferences=async db=>({enabled:false,retry_limit:3,...(await one(db,"SELECT value FROM phase2_settings WHERE key='recurring_demo'"))?.value});
export const authorizationText='DEMO ONLY. Authorise simulated CAD payments for issued invoices covering completed visits in this accepted schedule only. Home invoices are due on completion; commercial invoices are due Net 15. No additional visits, renewal, fees, late-cancellation charges or penalties are authorised. You may revoke this payment authorisation without deleting the service agreement or outstanding invoices. No real card is collected or charged.';

export function validContract(c){
  if(c.status!=='accepted'||!c.acceptance||snapshotHash(c.snapshot)!==c.snapshot_hash)fail(409,'An unchanged accepted agreement is required.');
  if(!['weekly','biweekly','monthly','daily'].includes(c.snapshot.quote.frequency))fail(409,'This agreement is not a recurring schedule.');
}
export function budget(c){
  const total=c.snapshot.visits.reduce((n,v)=>n+v.amount_minor,0);
  if(!Number.isSafeInteger(total)||total<=0||total!==c.snapshot.quote.total_minor)fail(409,'The accepted schedule has inconsistent prices.');return total;
}

// Issued invoices only; no new invoices or visits are invented by this collector.
export async function eligible(tx,i,a,c,today,ignorePaymentId=null){
  validContract(c);
  if(a.status!=='active'||snapshotHash(a.consent)!==a.evidence_hash||a.consent.snapshot_hash!==c.snapshot_hash||Number(a.max_total_minor)!==budget(c))fail(409,'Payment authorisation is not active for this schedule.');
  if(i.invoice_kind==='closing'||i.status!=='issued'||i.currency!=='CAD'||iso(i.due_date)>today)fail(409,'Only due service invoices may be collected; closing adjustments require manual payment.');
  if(await one(tx,"SELECT id FROM financial_entries WHERE invoice_id=$1 AND kind='credit' LIMIT 1",[i.id])||await one(tx,"SELECT id FROM financial_requests WHERE invoice_id=$1 AND kind='credit' AND status='approved' LIMIT 1",[i.id]))fail(409,'An adjusted invoice requires supervised individual payment.');
  const lines=i.snapshot.lines;
  if(!Array.isArray(lines)||!lines.length||new Set(lines.map(l=>l.visit_id)).size!==lines.length)fail(409,'Invoice lines need review.');
  const visits=(await tx.query('SELECT * FROM service_visits WHERE contract_id=$1 AND invoice_id=$2',[c.id,i.id])).rows;
  const plan=await one(tx,'SELECT effective_date FROM service_termination_plans WHERE contract_id=$1',[c.id]);
  if(visits.length!==lines.length||visits.some(v=>v.status!=='completed'||iso(v.service_date)>today||plan&&iso(v.service_date)>=iso(plan.effective_date)))fail(409,'Only completed visits within the active agreement can be collected.');
  let total=0;
  for(const v of visits){
    const original=c.snapshot.visits.find(x=>x.property_index===v.property_index&&x.address===v.address&&x.amount_minor===Number(v.amount_minor)&&x.discount_minor===Number(v.discount_minor));
    const line=lines.find(l=>l.visit_id===v.id);
    if(!original||!line||line.amount_minor!==Number(v.amount_minor)||line.discount_minor!==Number(v.discount_minor))fail(409,'The invoice price is outside the accepted schedule.');
    if(original.pricing&&(snapshotHash(original.pricing)!==snapshotHash(v.pricing)||snapshotHash(v.pricing)!==snapshotHash(line.pricing)))fail(409,'The invoice pricing breakdown differs from the authorised schedule.');
    total+=Number(v.amount_minor);
  }
  if(total!==Number(i.total_minor))fail(409,'Invoice total does not match completed visits.');
  const paid=await one(tx,"SELECT COALESCE(sum(total_minor),0) AS total FROM service_invoices WHERE contract_id=$1 AND invoice_kind='service' AND status IN ('paid','payment_review')",[c.id]);
  const reserved=await one(tx,"SELECT COALESCE(sum(p.amount_minor),0) AS total FROM service_invoice_payments p JOIN service_invoices x ON x.id=p.invoice_id WHERE x.contract_id=$1 AND x.status='issued' AND ($2::uuid IS NULL OR p.id<>$2) AND ((p.status IN ('creating','open') AND p.expires_at>now()) OR EXISTS(SELECT 1 FROM stripe_collection_operations o WHERE o.payment_id=p.id AND o.status IN ('queued','sending','processing','action_required','unknown')))",[c.id,ignorePaymentId]);
  if(Number(paid.total)+Number(reserved.total)+total>Number(a.max_total_minor))fail(409,'The accepted payment budget would be exceeded.');
  const checkout=await one(tx,"SELECT id FROM service_invoice_payments WHERE invoice_id=$1 AND ($2::uuid IS NULL OR id<>$2) AND (status='paid' OR (status IN ('creating','open') AND expires_at>now())) LIMIT 1",[i.id,ignorePaymentId]);
  if(checkout)fail(409,'A payment for this invoice is already paid or in progress.');
}

async function overview(db,{email,user}={}){
  const scope=[!!email,email||'',user?.role==='admin',user?.id||null];
  const rows=(await db.query(`SELECT a.*,c.snapshot->'quote'->>'service' AS service,c.customer_email,c.status AS contract_status
    FROM recurring_authorizations a JOIN service_contracts c ON c.id=a.contract_id JOIN crm_leads l ON l.id=c.lead_id
    WHERE ($1::boolean AND c.customer_email=$2) OR (NOT $1::boolean AND ($3::boolean OR l.owner_id=$4::uuid)) ORDER BY a.created_at DESC`,scope)).rows;
  const invoices=(await db.query(`SELECT i.id,i.contract_id,i.number,i.total_minor,i.due_date,i.status AS invoice_status,
    j.id AS job_id,j.status AS job_status,j.attempts,j.revision AS job_revision,
    a.status AS authorization_status FROM service_invoices i JOIN service_contracts c ON c.id=i.contract_id
    JOIN crm_leads l ON l.id=c.lead_id JOIN recurring_authorizations a ON a.contract_id=c.id
    LEFT JOIN recurring_jobs j ON j.invoice_id=i.id
    WHERE ($1::boolean AND c.customer_email=$2) OR (NOT $1::boolean AND ($3::boolean OR l.owner_id=$4::uuid)) ORDER BY i.due_date,i.id`,scope)).rows;
  const attempts=(await db.query(`SELECT t.id,t.job_id,t.outcome,t.created_at FROM recurring_attempts t
    JOIN recurring_jobs j ON j.id=t.job_id JOIN recurring_authorizations a ON a.id=j.authorization_id
    JOIN service_contracts c ON c.id=a.contract_id JOIN crm_leads l ON l.id=c.lead_id
    WHERE ($1::boolean AND c.customer_email=$2) OR (NOT $1::boolean AND ($3::boolean OR l.owner_id=$4::uuid)) ORDER BY t.created_at DESC LIMIT 100`,scope)).rows;
  return{items:rows.map(numeric),calendar:await Promise.all(invoices.map(async i=>({...numeric(i),total_minor:(await invoiceFinance(db,i)).net_total_minor,due_date:iso(i.due_date)}))),attempts};
}

export async function registerRecurring(app,{db,origin,config,gateway,customerGuard,teamGuard,adminGuard}){
  const route=(method,url,body,guard,handler)=>app.route({method,url,...(body?{schema:{body}}:{}),preHandler:guard,handler});
  route('GET','/api/client/recurring',null,customerGuard,async r=>({...await overview(db,{email:r.customer.email}),provider:'demo',available:gateway.provider==='demo',terms:authorizationText}));
  route('POST','/api/client/contracts/:id/authorize-demo',s.object({snapshot_hash:{type:'string',pattern:'^[a-f0-9]{64}$'},signed_name:s.str(120,2),consent:{const:true},demo_acknowledged:{const:true}}),customerGuard,r=>db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(73182008)');
    if(gateway.provider!=='demo')fail(409,'This endpoint is the internal simulator. Use the separate Stripe sandbox authorisation panel.');
    const c=await one(tx,'SELECT * FROM service_contracts WHERE id=$1 AND customer_email=$2 FOR UPDATE',[r.params.id,r.customer.email]);if(!c)fail(404,'Agreement not found.');validContract(c);
    if(c.accepted_by!==r.customer.id||c.snapshot_hash!==r.body.snapshot_hash)fail(409,'Review and accept the current agreement first.');
    const name=r.body.signed_name.trim();if(name.length<2)fail(400,'Enter your full name.');
    const old=await one(tx,'SELECT * FROM recurring_authorizations WHERE contract_id=$1',[c.id]);
    if(old){if(old.status==='revoked'||old.consent.signed_name!==name||old.consent.snapshot_hash!==c.snapshot_hash)fail(409,'This authorisation cannot be replaced. Contact the team for a new schedule.');return{id:old.id,status:old.status};}
    const id=randomUUID(),cap=budget(c),consent={version:1,signed_name:name,customer_id:r.customer.id,snapshot_hash:c.snapshot_hash,currency:'CAD',max_total_minor:cap,terms:authorizationText,method:'fictitious_demo_card',accepted_at:new Date().toISOString()};
    await tx.query('INSERT INTO recurring_authorizations(id,contract_id,customer_id,consent,evidence_hash,max_total_minor) VALUES($1,$2,$3,$4,$5,$6)',[id,c.id,r.customer.id,JSON.stringify(consent),snapshotHash(consent),cap]);
    await audit(tx,null,'recurring.authorize-demo',id,{customer_id:r.customer.id});
    await queueCommercialMail(tx,'recurring:'+id+':consent',c.customer_email,serviceMail({subject:'ViiLife demo payment authorisation saved',title:'Your demo authorisation',paragraphs:[authorizationText,'The team must activate the demo authorisation before any simulation.'],actionUrl:new URL('/cliente',origin).href}));
    return{id,status:'paused'};
  }));
  route('POST','/api/client/recurring/:id/revoke',s.object({revision:s.int(1,1000000)}),customerGuard,r=>db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(73182008)');
    const a=await one(tx,'SELECT * FROM recurring_authorizations WHERE id=$1 AND customer_id=$2 FOR UPDATE',[r.params.id,r.customer.id]);if(!a)fail(404,'Authorisation not found.');
    if(a.status==='revoked')return{ok:true};if(a.revision!==r.body.revision)fail(409,'Authorisation changed. Refresh the page.');
    await tx.query("UPDATE recurring_authorizations SET status='revoked',revision=revision+1,updated_at=now() WHERE id=$1",[a.id]);
    await tx.query("UPDATE recurring_jobs SET status='cancelled',revision=revision+1,updated_at=now() WHERE authorization_id=$1 AND status<>'paid'",[a.id]);
    const c=await one(tx,'SELECT customer_email FROM service_contracts WHERE id=$1',[a.contract_id]);
    await queueCommercialMail(tx,'recurring:'+a.id+':revoked',c.customer_email,serviceMail({subject:'ViiLife demo payment authorisation revoked',title:'Authorisation revoked',paragraphs:['No further automatic payment simulations will be made under this authorisation. Your agreement and outstanding invoices are unchanged. You can pay issued invoices manually in your account.'],actionUrl:new URL('/cliente',origin).href}));
    await audit(tx,null,'recurring.revoke',a.id,{customer_id:r.customer.id});return{ok:true};
  }));
  route('GET','/api/commercial/recurring',null,teamGuard,async r=>({...await overview(db,{user:r.teamUser}),settings:await preferences(db),available:gateway.provider==='demo'}));
  route('PUT','/api/commercial/recurring/settings',s.object({enabled:s.bool,retry_limit:s.int(1,3)}),adminGuard,r=>db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(73182008)');
    if(r.body.enabled&&gateway.provider!=='demo')fail(409,'This switch enables the internal simulator only. Stripe auto-collection has a separate private activation.');
    await tx.query("INSERT INTO phase2_settings(key,value) VALUES('recurring_demo',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()",[JSON.stringify(r.body)]);
    await audit(tx,r.teamUser.id,'recurring.settings','recurring_demo',r.body);return{ok:true};
  }));
  route('POST','/api/commercial/recurring/:id/status',s.object({revision:s.int(1,1000000),status:s.choice(['active','paused']),reason:s.str(1000,3)}),adminGuard,r=>db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(73182008)');
    if(gateway.provider!=='demo')fail(409,'This endpoint only controls simulated collections. Use the Stripe sandbox operations panel.');
    const a=await one(tx,'SELECT * FROM recurring_authorizations WHERE id=$1 FOR UPDATE',[r.params.id]);if(!a)fail(404,'Authorisation not found.');
    if(a.status==='revoked'||a.revision!==r.body.revision)fail(409,'Refresh this authorisation. Revocation cannot be overridden.');
    const c=await one(tx,'SELECT * FROM service_contracts WHERE id=$1',[a.contract_id]);if(r.body.status==='active')validContract(c);
    await tx.query('UPDATE recurring_authorizations SET status=$2,revision=revision+1,updated_at=now() WHERE id=$1',[a.id,r.body.status]);
    await audit(tx,r.teamUser.id,'recurring.'+r.body.status,a.id,{reason:r.body.reason});return{ok:true};
  }));
  route('POST','/api/commercial/recurring/prepare',s.object({}),adminGuard,()=>prepareRecurring(db,{provider:gateway.provider}));
  route('POST','/api/commercial/recurring/jobs/:id/simulate',s.object({revision:s.int(1,1000000),request_id:s.uuid,outcome:s.choice(['paid','failed','action_required'])}),adminGuard,async r=>{
    if(gateway.provider!=='demo')fail(409,'This simulation never calls Stripe. Disconnect Stripe to use it.');
    const result=await db.transaction(async tx=>{
      // Global collector lock serialises caps across invoices of the same agreement.
      await tx.query('SELECT pg_advisory_xact_lock(73182008)');
      const old=await one(tx,'SELECT * FROM recurring_attempts WHERE id=$1',[r.body.request_id]);
      if(old){if(old.job_id!==r.params.id||old.outcome!==r.body.outcome)fail(409,'Conflicting attempt key.');return{ok:true,duplicate:true};}
      const settings=await preferences(tx);if(!settings.enabled)fail(409,'Enable the local demo collector first.');
      const row=await one(tx,'SELECT invoice_id,authorization_id FROM recurring_jobs WHERE id=$1',[r.params.id]);if(!row)fail(404,'Collection not found.');
      const i=await one(tx,'SELECT * FROM service_invoices WHERE id=$1 FOR UPDATE',[row.invoice_id]);
      const a=await one(tx,'SELECT * FROM recurring_authorizations WHERE id=$1 FOR UPDATE',[row.authorization_id]);
      const j=await one(tx,'SELECT * FROM recurring_jobs WHERE id=$1 FOR UPDATE',[r.params.id]);
      if(j.revision!==r.body.revision||!['ready','failed'].includes(j.status)||j.attempts>=settings.retry_limit)fail(409,'Refresh the collection. It may require customer action or have reached the demo attempt limit.');
      const c=await one(tx,'SELECT * FROM service_contracts WHERE id=$1 FOR UPDATE',[a.contract_id]);await eligible(tx,i,a,c,serviceToday());
      const payment=randomUUID(),reference='recurring-demo-'+payment;
      await tx.query("INSERT INTO service_invoice_payments(id,invoice_id,provider,status,amount_minor,currency,reference,expires_at) VALUES($1,$2,'demo','open',$3,'CAD',$4,now()+interval '35 minutes')",[payment,i.id,Number(i.total_minor),reference]);
      await settleInvoiceInTransaction(tx,config,origin,{id:'recurring-demo:'+r.body.request_id,reference,outcome:r.body.outcome==='paid'?'paid':'failed',amount:Number(i.total_minor),currency:'CAD'});
      await tx.query('INSERT INTO recurring_attempts(id,job_id,payment_id,outcome) VALUES($1,$2,$3,$4)',[r.body.request_id,j.id,payment,r.body.outcome]);
      await tx.query('UPDATE recurring_jobs SET status=$2,attempts=attempts+1,revision=revision+1,updated_at=now() WHERE id=$1',[j.id,r.body.outcome]);
      if(r.body.outcome!=='paid'){
        const mail=serviceMail({subject:'ViiLife demo payment needs your attention',title:'Your invoice remains unpaid',paragraphs:['A simulated automatic payment did not complete. No real charge was made. Sign in to review and pay your invoice manually. No late fees have been added.'],actionUrl:new URL('/cliente?invoice='+i.id,origin).href});
        await queueCommercialMail(tx,'recurring-attempt:'+r.body.request_id+':customer',i.customer_email,mail);
        await queueCommercialMail(tx,'recurring-attempt:'+r.body.request_id+':team',config.adminEmail,serviceMail({subject:'ViiLife demo collection needs follow-up',title:'Payment follow-up',paragraphs:['A simulated collection did not complete. Review the invoice and contact the customer.'],details:[['Invoice',i.number],['Outcome',r.body.outcome]],actionUrl:new URL('/admin',origin).href}));
      }
      await audit(tx,r.teamUser.id,'recurring.simulate.'+r.body.outcome,j.id,{attempt:r.body.request_id});return{ok:true,invoice_id:i.id,amount_minor:Number(i.total_minor)};
    });
    if(r.body.outcome==='paid'&&result.invoice_id)try{await recordPaidMeasurement(db,{reference:'invoice:'+result.invoice_id,section:'viilife',amountMinor:result.amount_minor});}catch{/* Optional analytics. */}
    return result;
  });
}

export async function prepareRecurring(db,{provider='demo',now=new Date()}={}){
  if(provider!=='demo')return{prepared:0,disabled:true};
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(73182008)');
    const settings=await preferences(tx);
    // Reconcile manual settlements/withdrawal even while the collector is disabled.
    await tx.query(`UPDATE recurring_jobs j SET status=CASE WHEN i.status='paid' THEN 'paid' ELSE 'cancelled' END,
      revision=j.revision+1,updated_at=now() FROM service_invoices i,recurring_authorizations a,service_contracts c
      WHERE j.invoice_id=i.id AND j.authorization_id=a.id AND a.contract_id=c.id AND j.status NOT IN ('paid','cancelled')
      AND (i.status<>'issued' OR a.status='revoked' OR c.status<>'accepted')`);
    if(!settings.enabled)return{prepared:0,disabled:true};
    const candidates=(await tx.query(`SELECT i.id FROM service_invoices i JOIN recurring_authorizations a ON a.contract_id=i.contract_id
      WHERE i.status='issued' AND i.invoice_kind='service' AND a.status='active' AND i.due_date<=$1 AND NOT EXISTS(SELECT 1 FROM recurring_jobs j WHERE j.invoice_id=i.id)
      ORDER BY i.due_date,i.id LIMIT 100`,[serviceToday(now)])).rows;
    let prepared=0;
    for(const row of candidates){
      const i=await one(tx,'SELECT * FROM service_invoices WHERE id=$1 FOR UPDATE',[row.id]);
      const a=await one(tx,'SELECT * FROM recurring_authorizations WHERE contract_id=$1 FOR UPDATE',[i.contract_id]);
      const c=await one(tx,'SELECT * FROM service_contracts WHERE id=$1 FOR UPDATE',[i.contract_id]);
      try{await eligible(tx,i,a,c,serviceToday(now));}catch(e){if(e.statusCode===409)continue;throw e;}
      await tx.query('INSERT INTO recurring_jobs(id,invoice_id,authorization_id) VALUES($1,$2,$3)',[randomUUID(),i.id,a.id]);prepared++;
    }
    return{prepared,simulated_only:true};
  });
}
