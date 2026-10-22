import {randomUUID} from 'node:crypto';
import {fail} from '../viicasa-backend/src/lib.js';
import * as s from '../viicasa-backend/src/schemas.js';
import {audit} from './api.mjs';
import {snapshotHash} from './agreement-content.mjs';
import {invoiceFinance,invoiceWithFinance} from './financial-core.mjs';
import {queueCommercialMail,serviceMail} from './mail.mjs';
import {pdfAttachment} from './service-pdf.mjs';
import {queueCommissionReviews} from './commission-core.mjs';

const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const cash=n=>(Number(n)/100).toFixed(2)+' CAD';
const numbers=r=>({...r,amount_minor:Number(r.amount_minor),...(r.approved_minor?{approved_minor:Number(r.approved_minor)}:{})});
const lock=tx=>tx.query('SELECT pg_advisory_xact_lock(73182008)');

async function currentInvoice(tx,id,actor,kind){
  const i=await one(tx,'SELECT * FROM service_invoices WHERE id=$1 FOR UPDATE',[id]);if(!i)fail(404,'Invoice not found.');
  if(kind==='customer'){if(i.customer_email!==actor.email)fail(404,'Invoice not found.');}
  else{const lead=await one(tx,'SELECT l.owner_id FROM service_contracts c JOIN crm_leads l ON l.id=c.lead_id WHERE c.id=$1',[i.contract_id]);if(actor.role!=='admin'&&lead?.owner_id!==actor.id)fail(404,'Invoice not found.');}
  return i;
}
async function capacity(tx,i,kind){
  const f=await invoiceFinance(tx,i);
  if(i.currency!=='CAD')fail(409,'Only CAD service invoices are supported.');
  if(kind==='credit'){
    if(i.status!=='issued'||f.paid_minor)fail(409,'Credits require an unpaid issued invoice. Use a refund request for a paid invoice.');
    return f.net_total_minor-f.reserved_credit_minor;
  }
  if(i.status!=='paid'||f.paid_minor<=0)fail(409,'A confirmed invoice payment is required for a refund request.');
  return f.paid_minor-f.refunds_minor-f.reserved_refund_minor;
}
async function noCheckout(tx,id){
  if(await one(tx,"SELECT id FROM stripe_collection_operations WHERE invoice_id=$1 AND status NOT IN ('failed','paid','cancelled') LIMIT 1",[id]))fail(409,'Resolve the submitted Stripe collection before changing this invoice.');
  if(await one(tx,"SELECT id FROM service_invoice_payments WHERE invoice_id=$1 AND status IN ('creating','open') AND expires_at>now() LIMIT 1",[id]))fail(409,'A payment is already open. Wait for expiry or resolve it before approving a credit.');
}
const event=(tx,q,actor,kind,action,detail={})=>tx.query('INSERT INTO financial_events(id,request_id,actor_id,actor_kind,action,detail) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),q.id,actor,kind,action,JSON.stringify(detail)]);
async function mailChange(tx,q,i,origin,config,action){
  const texts={requested:['Request received','The ViiLife team will review your request. No credit or refund has been applied.'],approved:['Request approved for demonstration','Your request was approved for demo processing. Approval alone is not a completed credit or refund. No real money has been returned.'],declined:['Request reviewed','Your request was not approved. Review the team response in your account.'],withdrawn:['Request withdrawn','Your pending request was withdrawn. No credit or refund was applied.'],cancelled:['Demo approval cancelled','The approved demo operation was cancelled before execution. No credit or refund was applied.'],completed:q.kind==='credit'?['Demo credit recorded','A demo credit note was recorded. Your unpaid balance has been reduced; the original invoice and service agreement remain unchanged.']:['Demo refund recorded','A simulated refund was recorded in the review environment. No real money has been returned. Review the payment and refund history in your account.']};
  const [title,description]=texts[action],amount=q.approved_minor||q.amount_minor;
  await queueCommercialMail(tx,`financial:${q.id}:${action}:${q.revision}:customer`,i.customer_email,{...serviceMail({subject:'ViiLife · '+title,title,paragraphs:[description],details:[['Invoice',i.number],['Request type',q.kind],['Amount',cash(amount)],...(q.resolution?[['Team response',q.resolution]]:[])],actionUrl:new URL('/cliente?financial='+q.id,origin).href}),...(action==='completed'?{attachments:[pdfAttachment('invoice',await invoiceWithFinance(tx,await one(tx,'SELECT * FROM service_invoices WHERE id=$1',[i.id])))]}:{})});
  if(['requested','completed'].includes(action))await queueCommercialMail(tx,`financial:${q.id}:${action}:${q.revision}:team`,config.adminEmail,serviceMail({subject:'ViiLife financial request · '+action,title:'Financial follow-up',paragraphs:[action==='requested'?'A client/service invoice request needs administrator review.':'A demo financial operation was recorded. Review any commission/tax consequences separately; no automatic commission deduction is made.'],details:[['Invoice',i.number],['Customer',i.customer_email],['Type',q.kind],['Amount',cash(amount)]],actionUrl:new URL('/admin',origin).href}));
}

async function overview(db,actor,kind){
  const args=[kind==='customer',actor.email||'',actor.role==='admin',actor.id];
  const where=`WHERE ($1::boolean AND i.customer_email=$2) OR (NOT $1::boolean AND ($3::boolean OR l.owner_id=$4::uuid))`;
  const join='JOIN service_invoices i ON i.id=q.invoice_id JOIN service_contracts c ON c.id=i.contract_id JOIN crm_leads l ON l.id=c.lead_id';
  const requests=(await db.query(`SELECT q.*,i.number,i.customer_email FROM financial_requests q ${join} ${where} ORDER BY q.created_at DESC LIMIT 200`,args)).rows;
  const entries=(await db.query(`SELECT e.* FROM financial_entries e JOIN financial_requests q ON q.id=e.request_id ${join} ${where} ORDER BY e.created_at DESC LIMIT 200`,args)).rows;
  const events=(await db.query(`SELECT e.id,e.request_id,e.action,e.detail,e.created_at FROM financial_events e JOIN financial_requests q ON q.id=e.request_id ${join} ${where} ORDER BY e.created_at DESC LIMIT 200`,args)).rows;
  const attempts=(await db.query(`SELECT a.* FROM financial_attempts a JOIN financial_requests q ON q.id=a.request_id ${join} ${where} ORDER BY a.created_at DESC LIMIT 200`,args)).rows;
  const invoices=(await db.query(`SELECT i.* FROM service_invoices i JOIN service_contracts c ON c.id=i.contract_id JOIN crm_leads l ON l.id=c.lead_id ${where} ORDER BY i.issued_at DESC LIMIT 200`,args)).rows;
  return{items:requests.map(numbers),entries:entries.map(numbers),events,attempts,
    invoices:await Promise.all(invoices.map(async i=>({id:i.id,number:i.number,customer_email:i.customer_email,status:i.status,finance:await invoiceFinance(db,i)})))};
}

export function registerFinancialAdjustments(app,{db,origin,config,gateway,teamGuard,adminGuard,customerGuard}){
  const route=(method,url,body,guard,handler)=>app.route({method,url,...(body?{schema:{body}}:{}),preHandler:guard,handler});
  const requestBody=s.object({invoice_id:s.uuid,kind:s.choice(['credit','refund']),amount_minor:s.int(1),reason:s.str(2000,3),idempotency_key:s.uuid});
  const create=(actorKind)=>async r=>db.transaction(async tx=>{
    await lock(tx);const actor=actorKind==='customer'?r.customer:r.teamUser,i=await currentInvoice(tx,r.body.invoice_id,actor,actorKind);
    const old=await one(tx,'SELECT * FROM financial_requests WHERE requester_kind=$1 AND requester_id=$2 AND idempotency_key=$3',[actorKind,actor.id,r.body.idempotency_key]);
    const requested={invoice_id:i.id,kind:r.body.kind,amount_minor:r.body.amount_minor,reason:r.body.reason.trim()};
    if(requested.reason.length<3)fail(400,'Enter the request reason.');
    if(old){if(snapshotHash(old.evidence.request)!==snapshotHash(requested))fail(409,'Request key was used for different details.');return{id:old.id,status:old.status,duplicate:true};}
    if(requested.amount_minor>await capacity(tx,i,requested.kind))fail(409,'Amount exceeds the available unpaid or refundable balance.');
    const evidence={request:requested,invoice_snapshot_hash:snapshotHash(i.snapshot),original_total_minor:Number(i.total_minor),currency:'CAD',requester_kind:actorKind,requester_id:actor.id},id=randomUUID();
    await tx.query('INSERT INTO financial_requests(id,invoice_id,requester_id,requester_kind,kind,amount_minor,reason,evidence,evidence_hash,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,i.id,actor.id,actorKind,requested.kind,requested.amount_minor,requested.reason,JSON.stringify(evidence),snapshotHash(evidence),r.body.idempotency_key]);
    const q=await one(tx,'SELECT * FROM financial_requests WHERE id=$1',[id]);await event(tx,q,actor.id,actorKind,'requested');await mailChange(tx,q,i,origin,config,'requested');return{id,status:'pending'};
  });
  route('POST','/api/client/financial/requests',requestBody,customerGuard,create('customer'));
  route('POST','/api/commercial/financial/requests',requestBody,adminGuard,create('team'));
  route('GET','/api/client/financial',null,customerGuard,async r=>({...await overview(db,r.customer,'customer'),mode:'demo',external_refund_enabled:false}));
  route('GET','/api/commercial/financial',null,teamGuard,async r=>({...await overview(db,r.teamUser,'team'),mode:'demo',simulation_available:gateway.provider==='demo',external_refund_enabled:false}));
  route('POST','/api/client/financial/requests/:id/withdraw',s.object({revision:s.int(1)}),customerGuard,r=>db.transaction(async tx=>{
    await lock(tx);const q=await one(tx,'SELECT * FROM financial_requests WHERE id=$1 FOR UPDATE',[r.params.id]);if(!q)fail(404,'Request not found.');
    const i=await currentInvoice(tx,q.invoice_id,r.customer,'customer');if(q.requester_kind!=='customer'||q.requester_id!==r.customer.id)fail(404,'Request not found.');
    if(q.status==='withdrawn')return{ok:true};if(q.status!=='pending'||q.revision!==r.body.revision)fail(409,'Only your current pending request may be withdrawn.');
    await tx.query("UPDATE financial_requests SET status='withdrawn',revision=revision+1,updated_at=now() WHERE id=$1",[q.id]);q.revision++;await event(tx,q,r.customer.id,'customer','withdrawn');await mailChange(tx,q,i,origin,config,'withdrawn');return{ok:true};
  }));
  route('POST','/api/commercial/financial/requests/:id/review',s.object({revision:s.int(1),action:s.choice(['approve','decline','cancel']),resolution:s.str(2000,3),approved_minor:s.int(1)},['revision','action','resolution']),adminGuard,r=>db.transaction(async tx=>{
    await lock(tx);const q=await one(tx,'SELECT * FROM financial_requests WHERE id=$1 FOR UPDATE',[r.params.id]);if(!q)fail(404,'Request not found.');const i=await currentInvoice(tx,q.invoice_id,r.teamUser,'team');
    if(q.revision!==r.body.revision||r.body.action==='cancel'&&q.status!=='approved'||r.body.action!=='cancel'&&q.status!=='pending')fail(409,'Request changed or has already been reviewed.');
    if(await one(tx,"SELECT request_id FROM stripe_refund_operations WHERE request_id=$1 AND status NOT IN ('failed','succeeded')",[q.id]))fail(409,'Resolve the external refund before changing its approval.');
    if(r.body.resolution.trim().length<3)fail(400,'Enter the review response.');
    if(snapshotHash(q.evidence)!==q.evidence_hash||q.evidence.invoice_snapshot_hash!==snapshotHash(i.snapshot)||q.evidence.original_total_minor!==Number(i.total_minor))fail(409,'The request/invoice evidence needs review.');
    let approved=null,status=r.body.action==='approve'?'approved':r.body.action==='cancel'?'cancelled':'declined';
    if(status==='approved'){
      approved=r.body.approved_minor||Number(q.amount_minor);
      if(approved>Number(q.amount_minor)||approved>await capacity(tx,i,q.kind))fail(409,'Approval exceeds the request or remaining balance.');
      if(q.kind==='credit'){
        await noCheckout(tx,i.id);
        await tx.query("UPDATE commercial_mail SET status='cancelled' WHERE status IN ('pending','failed') AND dedupe LIKE $1",['invoice-reminder:'+i.id+':%']);
      }
    }
    await tx.query('UPDATE financial_requests SET status=$2,approved_minor=COALESCE($3,approved_minor),resolution=$4,reviewed_by=$5,reviewed_at=now(),revision=revision+1,updated_at=now() WHERE id=$1',[q.id,status,approved,r.body.resolution.trim(),r.teamUser.id]);
    const updated=await one(tx,'SELECT * FROM financial_requests WHERE id=$1',[q.id]);await event(tx,updated,r.teamUser.id,'team',status,{resolution:updated.resolution,approved_minor:approved});await audit(tx,r.teamUser.id,'financial.'+status,q.id);await mailChange(tx,updated,i,origin,config,status);return{ok:true,status};
  }));
  route('POST','/api/commercial/financial/requests/:id/simulate',s.object({revision:s.int(1),attempt_id:s.uuid,outcome:s.choice(['succeeded','failed'])}),adminGuard,r=>db.transaction(async tx=>{
    if(gateway.provider!=='demo')fail(409,'Refund/credit execution is not connected to Stripe. This endpoint only simulates locally.');
    await lock(tx);const q=await one(tx,'SELECT * FROM financial_requests WHERE id=$1 FOR UPDATE',[r.params.id]);if(!q)fail(404,'Request not found.');const i=await currentInvoice(tx,q.invoice_id,r.teamUser,'team');
    const previous=await one(tx,'SELECT * FROM financial_attempts WHERE id=$1',[r.body.attempt_id]);if(previous){if(previous.request_id!==q.id||previous.outcome!==r.body.outcome)fail(409,'Conflicting attempt key.');return{ok:true,duplicate:true};}
    if(q.status!=='approved'||q.revision!==r.body.revision||q.attempts>=3)fail(409,'Refresh the request. It may no longer be approved or reached the demo attempt limit.');
    if(snapshotHash(q.evidence)!==q.evidence_hash||q.evidence.invoice_snapshot_hash!==snapshotHash(i.snapshot)||q.evidence.original_total_minor!==Number(i.total_minor))fail(409,'Financial evidence changed.');
    // Capacity reserves this approved request; add it back when checking execution.
    if(Number(q.approved_minor)>await capacity(tx,i,q.kind)+Number(q.approved_minor))fail(409,'The balance no longer supports this operation.');
    if(q.kind==='credit')await noCheckout(tx,i.id);
    await tx.query('INSERT INTO financial_attempts(id,request_id,outcome) VALUES($1,$2,$3)',[r.body.attempt_id,q.id,r.body.outcome]);
    if(r.body.outcome==='failed'){
      await tx.query('UPDATE financial_requests SET attempts=attempts+1,revision=revision+1,updated_at=now() WHERE id=$1',[q.id]);await event(tx,q,r.teamUser.id,'team','simulation_failed');await audit(tx,r.teamUser.id,'financial.simulation_failed',q.id);
      await queueCommercialMail(tx,'financial-attempt:'+r.body.attempt_id+':team',config.adminEmail,serviceMail({subject:'ViiLife demo financial operation needs follow-up',title:'Demo operation did not complete',paragraphs:['The approved operation remains unexecuted. Review the request before retrying or cancelling its approval. No real money has been returned.'],details:[['Invoice',i.number],['Request type',q.kind]],actionUrl:new URL('/admin',origin).href}));
      return{ok:true,status:'approved',simulated_only:true};
    }
    const reference='adjustment-demo:'+q.id;
    await tx.query('INSERT INTO financial_entries(id,request_id,invoice_id,kind,amount_minor,reference) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),q.id,i.id,q.kind,Number(q.approved_minor),reference]);
    if(q.kind==='refund')await queueCommissionReviews(tx);
    await tx.query("UPDATE financial_requests SET status='completed',attempts=attempts+1,revision=revision+1,updated_at=now() WHERE id=$1",[q.id]);
    if(q.kind==='credit'){
      const f=await invoiceFinance(tx,i);if(f.net_total_minor===0)await tx.query("UPDATE service_invoices SET status='cancelled' WHERE id=$1",[i.id]);
      await tx.query("UPDATE recurring_jobs SET status='cancelled',revision=revision+1,updated_at=now() WHERE invoice_id=$1 AND status<>'paid'",[i.id]);
      await tx.query("UPDATE commercial_mail SET status='cancelled' WHERE status IN ('pending','failed') AND dedupe LIKE $1",['invoice-reminder:'+i.id+':%']);
    }
    const updated=await one(tx,'SELECT * FROM financial_requests WHERE id=$1',[q.id]);await event(tx,updated,r.teamUser.id,'team','completed',{reference,simulated_only:true});await audit(tx,r.teamUser.id,'financial.simulated.'+q.kind,q.id,{amount_minor:Number(q.approved_minor)});await mailChange(tx,updated,i,origin,config,'completed');
    return{ok:true,status:'completed',simulated_only:true,reference};
  }));
}
