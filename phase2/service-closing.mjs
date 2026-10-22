import {randomUUID} from 'node:crypto';
import {fail} from '../viicasa-backend/src/lib.js';
import * as s from '../viicasa-backend/src/schemas.js';
import {audit} from './api.mjs';
import {snapshotHash} from './agreement-content.mjs';
import {serviceDay} from './service-time.mjs';
import {invoiceFinance} from './financial-core.mjs';
import {queueCommercialMail,serviceMail} from './mail.mjs';
import {pdfAttachment} from './service-pdf.mjs';

const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const lock=tx=>tx.query('SELECT pg_advisory_xact_lock(73182008)');
const iso=v=>v?new Date(v).toISOString().slice(0,10):null;
const cash=n=>(Number(n)/100).toFixed(2)+' CAD';
const defaults={revision:0,enabled:false,approved:false,recovery_enabled:false,charge_cap_minor:null,taxes:null,note:''};
const policy=async db=>({...defaults,...(await one(db,"SELECT value FROM phase2_settings WHERE key='closing_policy'"))?.value});
const numbers=q=>({...q,recovery_minor:Number(q.recovery_minor),charge_minor:Number(q.charge_minor),due_date:iso(q.due_date)});
export function closingCalculation(amounts,settings){
  const recovery=Number(amounts.recovery_minor),charge=Number(amounts.charge_minor),base=recovery+charge;
  if(![recovery,charge,base].every(n=>Number.isSafeInteger(n)&&n>=0))fail(400,'Invalid closing amounts.');
  const taxes=(settings.taxes||[]).map(t=>{const taxable=t.applies_to==='recovery'?recovery:t.applies_to==='charge'?charge:base;
    return{...t,amount_minor:Number((BigInt(taxable)*BigInt(t.basis_points)+5000n)/10000n)};});
  const tax=taxes.reduce((n,t)=>n+t.amount_minor,0),total=base+tax;
  if(!Number.isSafeInteger(total)||total>99999999)fail(400,'Closing amount exceeds the supported limit.');
  return{base_minor:base,tax_minor:tax,total_minor:total,taxes,taxes_defined:settings.taxes!==null};
}
function annualEnd(day){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day||'')||iso(day)!==day)fail(409,'The agreement start date needs review.');
  const [year,month,date]=day.split('-').map(Number),last=new Date(Date.UTC(year+1,month,0)).getUTCDate();
  return new Date(Date.UTC(year+1,month-1,Math.min(date,last))).toISOString().slice(0,10);
}

async function impact(tx,changeId,user){
  const change=await one(tx,'SELECT * FROM service_change_requests WHERE id=$1 FOR UPDATE',[changeId]);if(!change)fail(404,'Change request not found.');
  const contract=await one(tx,'SELECT c.*,l.owner_id FROM service_contracts c JOIN crm_leads l ON l.id=c.lead_id WHERE c.id=$1 FOR UPDATE OF c',[change.contract_id]);
  if(user.role!=='admin'&&contract.owner_id!==user.id)fail(404,'Change request not found.');
  if(change.status!=='approved'||!['terminate','cancel_visit'].includes(change.kind))fail(409,'Approve a cancellation or termination before preparing its economic closing.');
  if(!contract.acceptance||!['accepted','cancelled'].includes(contract.status)||snapshotHash(contract.snapshot)!==contract.snapshot_hash)fail(409,'An unchanged accepted agreement is required.');
  const visit=change.visit_id?await one(tx,'SELECT * FROM service_visits WHERE id=$1 AND contract_id=$2',[change.visit_id,contract.id]):null;
  if(change.kind==='cancel_visit'&&(!visit||visit.status!=='cancelled'||visit.invoice_id))fail(409,'Only an approved, uninvoiced cancelled visit can receive a closing adjustment.');
  const effective=change.kind==='terminate'?iso(change.effective_date):iso(visit.service_date);
  if(!effective)fail(409,'Confirm the effective cancellation date.');
  if(change.kind==='terminate'){
    const plan=await one(tx,'SELECT request_id,effective_date FROM service_termination_plans WHERE contract_id=$1',[contract.id]);
    if(!plan||plan.request_id!==change.id||iso(plan.effective_date)!==effective)fail(409,'The approved termination plan needs review.');
  }
  const invoices=(await tx.query("SELECT * FROM service_invoices WHERE contract_id=$1 AND invoice_kind='service' ORDER BY id FOR UPDATE",[contract.id])).rows;
  const receipts=[];let received=0,unsettled=false;
  for(const i of invoices){
    const f=await invoiceFinance(tx,i),eligible=i.status==='paid'&&f.paid_minor===Number(i.total_minor)&&!f.credits_minor&&!f.refunds_minor&&!f.reserved_credit_minor&&!f.reserved_refund_minor;
    if(eligible)received+=Number(i.discount_minor);
    if(['issued','payment_review'].includes(i.status)||f.reserved_credit_minor||f.reserved_refund_minor)unsettled=true;
    receipts.push({id:i.id,number:i.number,status:i.status,discount_minor:Number(i.discount_minor),finance:f,eligible});
  }
  const prior=(await one(tx,"SELECT COALESCE(sum(recovery_minor),0)::bigint AS n FROM service_closings WHERE contract_id=$1 AND status='issued'",[contract.id])).n;
  if(!Number.isSafeInteger(received)||!Number.isSafeInteger(Number(prior))||received<0||Number(prior)<0)fail(409,'Historical discount amounts need review.');
  const q=contract.snapshot.quote,start=contract.snapshot.details.first_service_date,annual=change.kind==='terminate'&&contract.snapshot.segment==='commercial'&&q.term==='annual'&&['daily','weekly'].includes(q.frequency)&&effective>=start&&effective<annualEnd(start);
  const unbilled=(await tx.query("SELECT id FROM service_visits WHERE contract_id=$1 AND status IN ('completed','missed') AND invoice_id IS NULL ORDER BY id",[contract.id])).rows;
  if(await one(tx,"SELECT q.id FROM financial_requests q JOIN service_invoices i ON i.id=q.invoice_id WHERE i.contract_id=$1 AND i.invoice_kind='service' AND q.status IN ('pending','approved') LIMIT 1",[contract.id]))unsettled=true;
  const settings=await policy(tx),approvals=(await tx.query("SELECT key,value FROM phase2_settings WHERE key IN ('approval:cancellation_policy','approval:taxes') ORDER BY key")).rows;
  return{contract,change,visit,context:{contract_id:contract.id,snapshot_hash:contract.snapshot_hash,change_id:change.id,change_revision:change.revision,
    kind:change.kind,effective_date:effective,annual_discount_eligible:annual,eligible_discount_minor:received,
    recovery_available_minor:annual?Math.max(0,received-Number(prior)):0,prior_recovery_minor:Number(prior),receipts,
    unsettled_invoices:unsettled,unbilled_visits:unbilled.map(v=>v.id),policy:settings,approvals,
    charge_available_minor:settings.charge_cap_minor===null?0:Math.min(settings.charge_cap_minor,visit?Number(visit.amount_minor):settings.charge_cap_minor)}};
}
function validateAmounts(q,context){
  const total=Number(q.recovery_minor)+Number(q.charge_minor),p=context.policy;
  if(total<=0)return;
  if(!p.enabled||!p.approved||p.taxes===null||!context.approvals.some(a=>a.key==='approval:cancellation_policy'&&a.value.approved===true)||!context.approvals.some(a=>a.key==='approval:taxes'&&a.value.approved===true))fail(409,'Closing charges and their tax treatment need explicit client policy approval. Drafts may still be prepared.');
  if(q.recovery_minor>0&&(!p.recovery_enabled||q.recovery_minor>context.recovery_available_minor))fail(409,'Recovery exceeds eligible discounts actually recorded as received, or the policy is not approved.');
  if(q.charge_minor>context.charge_available_minor)fail(409,'The manual charge exceeds the approved cap. No default penalty is supplied.');
  if(context.kind==='terminate'&&(context.effective_date>serviceDay()||context.unsettled_invoices||context.unbilled_visits.length))fail(409,'Wait for the effective termination and settle earlier service invoices/visits before billing its closing.');
  if(!q.due_date||iso(q.due_date)<serviceDay())fail(409,'Choose a current or future due date before approving the adjustment.');
}
async function record(tx,q,user,action,detail){
  await tx.query('INSERT INTO service_closing_events(id,closing_id,actor_id,action,detail) VALUES($1,$2,$3,$4,$5)',[randomUUID(),q.id,user.id,action,JSON.stringify(detail)]);
  await audit(tx,user.id,'closing.'+action,q.id,{revision:q.revision});
}

export function registerServiceClosing(app,{db,teamGuard,adminGuard,customerGuard,origin,config}){
  const params=s.object({id:s.uuid}),draft=s.object({change_id:s.uuid,recovery_minor:s.int(0),charge_minor:s.int(0),due_date:{anyOf:[s.date,{type:'null'}]},reason:s.str(2000,3)});
  app.get('/api/commercial/closings',{preHandler:teamGuard},async r=>({policy:await policy(db),items:(await db.query(`SELECT q.*,c.customer_email,l.name AS client_name FROM service_closings q JOIN service_contracts c ON c.id=q.contract_id JOIN crm_leads l ON l.id=c.lead_id
    WHERE ($1::boolean OR l.owner_id=$2) ORDER BY q.created_at DESC`,[r.teamUser.role==='admin',r.teamUser.id])).rows.map(numbers),changes:(await db.query(`SELECT q.id,q.kind,q.effective_date,q.reason,c.customer_email,l.name AS client_name FROM service_change_requests q JOIN service_contracts c ON c.id=q.contract_id JOIN crm_leads l ON l.id=c.lead_id
      WHERE q.status='approved' AND q.kind IN ('terminate','cancel_visit') AND ($1::boolean OR l.owner_id=$2) AND NOT EXISTS(SELECT 1 FROM service_closings x WHERE x.change_id=q.id) ORDER BY q.created_at DESC`,[r.teamUser.role==='admin',r.teamUser.id])).rows.map(q=>({...q,effective_date:iso(q.effective_date)}))}));
  app.get('/api/client/closings',{preHandler:customerGuard},async r=>({items:(await db.query(`SELECT q.id,q.contract_id,q.status,q.recovery_minor,q.charge_minor,q.due_date,q.reason,q.invoice_id,q.updated_at
    FROM service_closings q JOIN service_contracts c ON c.id=q.contract_id WHERE c.customer_email=$1 AND q.status IN ('issued','no_charge') ORDER BY q.updated_at DESC`,[r.customer.email])).rows.map(numbers)}));
  app.get('/api/commercial/closings/impact/:id',{preHandler:teamGuard,schema:{params}},r=>db.transaction(async tx=>{await lock(tx);return(await impact(tx,r.params.id,r.teamUser)).context;}));
  app.get('/api/commercial/closings/:id/history',{preHandler:teamGuard,schema:{params}},async r=>{
    const q=await one(db,'SELECT q.id FROM service_closings q JOIN service_contracts c ON c.id=q.contract_id JOIN crm_leads l ON l.id=c.lead_id WHERE q.id=$1 AND ($2::boolean OR l.owner_id=$3)',[r.params.id,r.teamUser.role==='admin',r.teamUser.id]);if(!q)fail(404,'Closing not found.');
    return{items:(await db.query('SELECT * FROM service_closing_events WHERE closing_id=$1 ORDER BY created_at,id',[q.id])).rows};
  });
  app.put('/api/commercial/closings/policy',{preHandler:adminGuard,schema:{body:s.object({revision:s.int(0),enabled:s.bool,approved:s.bool,recovery_enabled:s.bool,charge_cap_minor:{anyOf:[s.int(0),{type:'null'}]},taxes:{anyOf:[s.array(s.object({id:{type:'string',pattern:'^[a-z][a-z0-9-]*$',maxLength:60},label:s.str(120,2),basis_points:s.int(0,10000),applies_to:s.choice(['recovery','charge','both'])}),5),{type:'null'}]},note:s.str(3000,3)})}},r=>db.transaction(async tx=>{
    await lock(tx);const old=await policy(tx);if(old.revision!==r.body.revision)fail(409,'Policy changed. Refresh.');
    if(r.body.note.trim().length<3)fail(400,'Enter the client policy reference.');
    if(new Set((r.body.taxes||[]).map(t=>t.id)).size!==(r.body.taxes||[]).length||(r.body.taxes||[]).reduce((n,t)=>n+t.basis_points,0)>10000)fail(400,'Tax identifiers must be unique and combined rates cannot exceed 100%.');
    const value={...r.body,revision:old.revision+1,note:r.body.note.trim(),actor_id:r.teamUser.id};
    await tx.query("INSERT INTO phase2_settings(key,value) VALUES('closing_policy',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[JSON.stringify(value)]);
    await audit(tx,r.teamUser.id,'closing.policy','closing_policy',value);return{ok:true};
  }));
  const save=edit=>r=>db.transaction(async tx=>{
    await lock(tx);let q=edit?await one(tx,'SELECT * FROM service_closings WHERE id=$1 FOR UPDATE',[r.params.id]):null;
    if(edit&&(!q||q.status!=='draft'||q.revision!==r.body.revision||q.change_id!==r.body.change_id))fail(409,'Only a current draft may be edited. Reopen the approval first.');
    const source=await impact(tx,r.body.change_id,r.teamUser),reason=r.body.reason.trim();if(reason.length<3)fail(400,'Enter an adjustment explanation.');
    if(r.body.due_date&&iso(r.body.due_date)!==r.body.due_date)fail(400,'Invalid due date.');
    if(!edit){q=await one(tx,'SELECT * FROM service_closings WHERE change_id=$1',[r.body.change_id]);if(q)fail(409,'This change already has a closing. Edit or reopen that record.');
      q={id:randomUUID(),revision:1};await tx.query('INSERT INTO service_closings(id,change_id,contract_id,recovery_minor,charge_minor,due_date,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[q.id,r.body.change_id,source.contract.id,r.body.recovery_minor,r.body.charge_minor,r.body.due_date,reason,r.teamUser.id]);
    }else{await tx.query('UPDATE service_closings SET recovery_minor=$2,charge_minor=$3,due_date=$4,reason=$5,revision=revision+1,updated_at=now() WHERE id=$1',[q.id,r.body.recovery_minor,r.body.charge_minor,r.body.due_date,reason]);q.revision++;}
    await record(tx,q,r.teamUser,edit?'edited':'drafted',{...r.body,reason});return{id:q.id,revision:q.revision};
  });
  app.post('/api/commercial/closings',{preHandler:adminGuard,schema:{body:draft}},save(false));
  app.put('/api/commercial/closings/:id',{preHandler:adminGuard,schema:{params,body:s.object({...draft.properties,revision:s.int(1)})}},save(true));
  app.post('/api/commercial/closings/:id/review',{preHandler:adminGuard,schema:{params,body:s.object({revision:s.int(1),action:s.choice(['approve','reopen','cancel']),note:s.str(2000,3)})}},r=>db.transaction(async tx=>{
    await lock(tx);const q=await one(tx,'SELECT * FROM service_closings WHERE id=$1 FOR UPDATE',[r.params.id]);if(!q)fail(404,'Closing not found.');
    const note=r.body.note.trim();if(note.length<3)fail(400,'Enter a review note.');
    if(q.revision!==r.body.revision||['issued','no_charge'].includes(q.status))fail(409,'Closing changed or already finalised.');
    let state,evidence=null;
    if(r.body.action==='approve'){
      if(q.status!=='draft')fail(409,'Approve a draft only.');const source=await impact(tx,q.change_id,r.teamUser);validateAmounts(q,source.context);
      evidence={context:source.context,amounts:{recovery_minor:Number(q.recovery_minor),charge_minor:Number(q.charge_minor),due_date:iso(q.due_date),reason:q.reason},calculation:closingCalculation(q,source.context.policy),note};state='approved';
    }else if(r.body.action==='reopen'){if(!['approved','cancelled'].includes(q.status))fail(409,'Reopen a reviewed closing only.');state='draft';}
    else{if(!['draft','approved'].includes(q.status))fail(409,'This draft/approval cannot be cancelled.');state='cancelled';}
    await tx.query('UPDATE service_closings SET status=$2,evidence=$3,evidence_hash=$4,approved_by=$5,revision=revision+1,updated_at=now() WHERE id=$1',[q.id,state,evidence?JSON.stringify(evidence):null,evidence?snapshotHash(evidence):null,state==='approved'?r.teamUser.id:null]);q.revision++;
    await record(tx,q,r.teamUser,state,{note,...(evidence?{evidence,evidence_hash:snapshotHash(evidence)}:{})});return{ok:true,status:state};
  }));
  app.post('/api/commercial/closings/:id/issue',{preHandler:adminGuard,schema:{params,body:s.object({revision:s.int(1),request_id:s.uuid})}},r=>db.transaction(async tx=>{
    await lock(tx);const q=await one(tx,'SELECT * FROM service_closings WHERE id=$1 FOR UPDATE',[r.params.id]);if(!q)fail(404,'Closing not found.');
    const old=await one(tx,'SELECT id,invoice_id,status FROM service_closings WHERE issue_key=$1',[r.body.request_id]);if(old){if(old.id!==q.id)fail(409,'Issue key belongs to a different closing.');return{ok:true,invoice_id:old.invoice_id,status:old.status,duplicate:true};}
    if(q.status!=='approved'||q.revision!==r.body.revision)fail(409,'Approve the current closing first.');
    const source=await impact(tx,q.change_id,r.teamUser),amounts={recovery_minor:Number(q.recovery_minor),charge_minor:Number(q.charge_minor),due_date:iso(q.due_date),reason:q.reason};
    if(!q.evidence||snapshotHash(q.evidence)!==q.evidence_hash||snapshotHash(q.evidence.context)!==snapshotHash(source.context)||snapshotHash(q.evidence.amounts)!==snapshotHash(amounts))fail(409,'Closing evidence or financial context changed. Reopen and review it again.');
    validateAmounts(q,source.context);const calculation=closingCalculation(amounts,source.context.policy);
    if(snapshotHash(q.evidence.calculation)!==snapshotHash(calculation))fail(409,'The approved tax calculation changed.');
    const total=calculation.total_minor;let invoice_id=null;
    if(total>0){
      invoice_id=randomUUID();const number='VII-DEMO-CLOSING-'+q.id.slice(0,8).toUpperCase(),c=source.contract;
      const lines=[...(amounts.recovery_minor?[{service:'Approved introductory discount recovery',amount_minor:amounts.recovery_minor}]:[]),...(amounts.charge_minor?[{service:'Approved cancellation adjustment',amount_minor:amounts.charge_minor}]:[]),...calculation.taxes.filter(t=>t.amount_minor>0).map(t=>({service:'Configured closing tax: '+t.label,amount_minor:t.amount_minor}))].map(l=>({...l,date:source.context.effective_date,address:'Agreement '+c.id.slice(0,8),discount_minor:0}));
      const snapshot={customer:c.snapshot.customer,payment_terms:'Manual payment by the approved due date',lines,exclusions:['Separately reviewed closing adjustment. No service visit was added or re-priced.','Demo only. Not a tax invoice. Tax treatment must be approved before issuing.'],closing:{id:q.id,change_id:q.change_id,reason:q.reason,evidence_hash:q.evidence_hash}};
      await tx.query("INSERT INTO service_invoices(id,contract_id,number,customer_email,total_minor,period,snapshot,due_date,segment,invoice_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'closing')",[invoice_id,c.id,number,c.customer_email,total,'closing:'+q.id,JSON.stringify(snapshot),q.due_date,c.snapshot.segment]);
      const invoice=await one(tx,'SELECT * FROM service_invoices WHERE id=$1',[invoice_id]);
      await queueCommercialMail(tx,'closing:'+q.id+':invoice:customer',c.customer_email,{...serviceMail({subject:'Your reviewed ViiLife closing adjustment',title:'Closing adjustment ready for review',paragraphs:[q.reason,'This approved adjustment is separate from your original service invoices. No automatic charge has been made. Sign in to review and pay by the agreed due date.'],details:[['Invoice',number],['Total',cash(total)],['Due date',iso(q.due_date)]],actionUrl:new URL('/cliente?invoice='+invoice_id,origin).href}),attachments:[pdfAttachment('invoice',invoice)]});
      await queueCommercialMail(tx,'closing:'+q.id+':invoice:team',config.adminEmail,serviceMail({subject:'ViiLife closing invoice issued',title:'Closing adjustment issued',paragraphs:['An administrator-approved closing invoice is awaiting manual customer payment. No visit or commission was created.'],details:[['Customer',c.customer_email],['Invoice',number],['Total',cash(total)]],actionUrl:new URL('/admin',origin).href}));
    }else await queueCommercialMail(tx,'closing:'+q.id+':no-charge',source.contract.customer_email,serviceMail({subject:'ViiLife closing reviewed without additional charges',title:'Closing review complete',paragraphs:[q.reason,'No additional invoice or charge was created by this review. Any existing invoices remain unchanged.'],actionUrl:new URL('/cliente',origin).href}));
    const state=invoice_id?'issued':'no_charge';await tx.query('UPDATE service_closings SET status=$2,invoice_id=$3,issue_key=$4,revision=revision+1,updated_at=now() WHERE id=$1',[q.id,state,invoice_id,r.body.request_id]);q.revision++;
    await record(tx,q,r.teamUser,state,{invoice_id,total_minor:total,automatic_charge:false});return{ok:true,status:state,invoice_id};
  }));
}
