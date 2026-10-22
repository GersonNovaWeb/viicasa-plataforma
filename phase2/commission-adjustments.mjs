import {randomUUID} from 'node:crypto';
import {fail} from '../viicasa-backend/src/lib.js';
import * as s from '../viicasa-backend/src/schemas.js';
import {audit} from './api.mjs';
import {snapshotHash} from './agreement-content.mjs';
import {commissionLock,commissionEvidence,queueCommissionReviews,commissionBalance} from './commission-core.mjs';
import {registerCommissionCorrections} from './commission-corrections.mjs';

const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const numeric=row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,k.endsWith('_minor')?Number(v):v]));
const uuid={type:'string',format:'uuid'};

export async function reconcileCommissionReviews(db){
  await db.transaction(async tx=>{
    await commissionLock(tx);
    // Old sales are never linked by resemblance. Explicit admin linking is below.
    await queueCommissionReviews(tx);
  });
}

export async function registerCommissionAdjustments(app,{db,userGuard,adminGuard}){
  registerCommissionCorrections(app,{db,userGuard,adminGuard});
  await reconcileCommissionReviews(db);
  app.get('/api/commercial/commission-review',{preHandler:userGuard},async(r,reply)=>{
    reply.header('Cache-Control','private, no-store');
    const args=[r.teamUser.role==='admin',r.teamUser.id];
    const items=(await db.query(`SELECT q.*,v.reference,v.seller_id,u.name AS seller_name,l.name AS client_name,
      v.commission_minor,v.effective_commission_minor,v.commission_status,v.recovery_due_minor,
      e.amount_minor AS refund_minor,i.number AS invoice_number,
      q.recovery_remaining_minor AS remaining_recovery_minor,q.supplement_due_minor AS review_supplement_due_minor
      FROM commission_review_effects q JOIN commercial_commission_balances v ON v.id=q.sale_id
      JOIN team_users u ON u.id=v.seller_id JOIN crm_leads l ON l.id=v.lead_id
      JOIN financial_entries e ON e.id=q.refund_entry_id JOIN service_invoices i ON i.id=e.invoice_id
      WHERE ($1::boolean OR v.seller_id=$2) ORDER BY q.created_at DESC LIMIT 200`,args)).rows.map(numeric);
    const recoveries=(await db.query(`SELECT x.* FROM commission_recoveries x JOIN commission_reviews q ON q.id=x.review_id
      JOIN commercial_sales v ON v.id=q.sale_id WHERE ($1::boolean OR v.seller_id=$2) ORDER BY x.created_at DESC LIMIT 200`,args)).rows.map(numeric);
    const unmatched=r.teamUser.role==='admin'?(await db.query(`SELECT e.id,i.id AS invoice_id,i.number,e.amount_minor,e.created_at,
      (SELECT v.id FROM commercial_sales v JOIN service_contracts c ON c.id=i.contract_id
       WHERE v.service_invoice_id IS NULL AND v.reference=i.number AND v.lead_id=c.lead_id AND v.seller_id=c.seller_id
       AND v.status='paid' AND v.currency='CAD' AND i.status='paid'
       AND v.amount_minor=(SELECT sum(p.amount_minor) FROM service_invoice_payments p WHERE p.invoice_id=i.id AND p.status='paid')) AS candidate_sale_id
      FROM financial_entries e JOIN service_invoices i ON i.id=e.invoice_id WHERE e.kind='refund' AND i.invoice_kind='service'
      AND NOT EXISTS(SELECT 1 FROM commercial_sales v WHERE v.service_invoice_id=i.id) ORDER BY e.created_at DESC LIMIT 100`)).rows.map(numeric):[];
    return{mode:'demo',items:items.map(q=>({...q,original_reduction_minor:q.reduction_minor,reduction_minor:q.current_reduction_minor,disposition:q.current_disposition,original_decision:q.decision,decision:q.current_reduction_minor>0?'reduce':'retain'})),recoveries,unmatched,external_transfer_enabled:false};
  });
  app.post('/api/commercial/commission-review/link',{preHandler:adminGuard,schema:{body:s.object({invoice_id:s.uuid,sale_id:s.uuid,note:s.str(2000,3)})}},async r=>db.transaction(async tx=>{
    await commissionLock(tx);
    const i=await one(tx,'SELECT * FROM service_invoices WHERE id=$1 FOR UPDATE',[r.body.invoice_id]);
    const sale=await one(tx,'SELECT * FROM commercial_sales WHERE id=$1 FOR UPDATE',[r.body.sale_id]);
    if(!i||!sale)fail(404,'Invoice or sale not found.');
    const note=r.body.note.trim();if(note.length<3)fail(400,'Explain the verified legacy linkage.');
    if(sale.service_invoice_id===i.id)return{ok:true,duplicate:true};
    if(sale.service_invoice_id||await one(tx,'SELECT id FROM commercial_sales WHERE service_invoice_id=$1',[i.id]))fail(409,'Invoice or sale is already linked.');
    const contract=await one(tx,'SELECT lead_id,seller_id FROM service_contracts WHERE id=$1',[i.contract_id]);
    const paid=Number((await one(tx,"SELECT COALESCE(sum(amount_minor),0)::bigint AS amount FROM service_invoice_payments WHERE invoice_id=$1 AND status='paid'",[i.id])).amount);
    if(i.status!=='paid'||sale.status!=='paid'||sale.currency!=='CAD'||i.currency!=='CAD'||sale.reference!==i.number||sale.lead_id!==contract.lead_id||sale.seller_id!==contract.seller_id||paid<=0||Number(sale.amount_minor)!==paid)fail(409,'Original invoice, sale, seller and recorded payment must match. Investigate mismatches; do not force a link.');
    if(!await one(tx,"SELECT id FROM team_audit WHERE action='invoice.paid' AND resource=$1 LIMIT 1",[i.id]))fail(409,'This invoice does not have a settlement audit record.');
    await tx.query('UPDATE commercial_sales SET service_invoice_id=$2 WHERE id=$1',[sale.id,i.id]);
    await audit(tx,r.teamUser.id,'commission.invoice_link',sale.id,{invoice_id:i.id,note});
    await queueCommissionReviews(tx);return{ok:true};
  }));
  app.post('/api/commercial/commission-review/:id/resolve',{preHandler:adminGuard,schema:{params:s.object({id:uuid}),body:s.object({revision:s.int(1),decision:s.choice(['retain','reduce']),reduction_minor:s.int(0),note:s.str(2000,3)})}},async r=>db.transaction(async tx=>{
    await commissionLock(tx);
    const q=await one(tx,'SELECT * FROM commission_reviews WHERE id=$1 FOR UPDATE',[r.params.id]);if(!q)fail(404,'Review not found.');
    const body={decision:r.body.decision,reduction_minor:r.body.reduction_minor,note:r.body.note.trim()};
    if(body.note.length<3)fail(400,'Enter the review reason.');
    if(q.status==='resolved'){
      if(q.decision===body.decision&&Number(q.reduction_minor)===body.reduction_minor&&q.note===body.note)return{ok:true,duplicate:true};
      fail(409,'This review is already resolved. Its history cannot be rewritten.');
    }
    if(q.revision!==r.body.revision)fail(409,'Refresh this review before deciding.');
    const sale=await one(tx,'SELECT * FROM commercial_sales WHERE id=$1 FOR UPDATE',[q.sale_id]);
    const entry=await one(tx,'SELECT * FROM financial_entries WHERE id=$1',[q.refund_entry_id]);
    if(!entry||entry.kind!=='refund'||sale.service_invoice_id!==entry.invoice_id||snapshotHash(q.evidence)!==q.evidence_hash||snapshotHash(commissionEvidence(sale,entry))!==q.evidence_hash)fail(409,'The review evidence needs investigation.');
    const balance=await commissionBalance(tx,sale.id);
    if(body.decision==='retain'&&body.reduction_minor!==0||body.decision==='reduce'&&body.reduction_minor<=0)fail(400,'Retain uses zero; reduction requires a positive amount.');
    if(body.reduction_minor>balance.effective_commission_minor)fail(409,'Reduction exceeds the remaining original commission.');
    if(body.decision==='reduce'&&(sale.status!=='paid'||sale.commission_status==='cancelled'))fail(409,'A cancelled or unpaid commission cannot be reduced. Retain its history with a review note.');
    const disposition=body.decision==='retain'?'retained':sale.commission_status==='paid'?'recovery_due':'unpaid_reduction';
    await tx.query(`UPDATE commission_reviews SET status='resolved',revision=revision+1,decision=$2,reduction_minor=$3,
      disposition=$4,note=$5,actor_id=$6,resolved_at=now() WHERE id=$1`,[q.id,body.decision,body.reduction_minor,disposition,body.note,r.teamUser.id]);
    await audit(tx,r.teamUser.id,'commission.review',q.id,{...body,disposition,simulated_only:true});
    await tx.query('INSERT INTO team_notifications(id,user_id,body) VALUES($1,$2,$3)',[randomUUID(),sale.seller_id,
      'Commission review recorded in demo: '+body.decision+' · '+(body.reduction_minor/100).toFixed(2)+' CAD. '+body.note]);
    return{ok:true,disposition};
  }));
  app.post('/api/commercial/commission-review/:id/recovery',{preHandler:adminGuard,schema:{params:s.object({id:uuid}),body:s.object({idempotency_key:s.uuid,amount_minor:s.int(1),note:s.str(2000,3)})}},async r=>db.transaction(async tx=>{
    await commissionLock(tx);
    const q=await one(tx,'SELECT * FROM commission_reviews WHERE id=$1 FOR UPDATE',[r.params.id]);if(!q)fail(404,'Review not found.');
    const note=r.body.note.trim();if(note.length<3)fail(400,'Enter a recovery note.');
    const old=await one(tx,'SELECT * FROM commission_recoveries WHERE id=$1',[r.body.idempotency_key]);
    if(old){if(old.review_id!==q.id||Number(old.amount_minor)!==r.body.amount_minor||old.note!==note)fail(409,'Recovery key has different details.');return{ok:true,duplicate:true};}
    await commissionBalance(tx,q.sale_id);const effect=await one(tx,'SELECT * FROM commission_review_effects WHERE id=$1',[q.id]);
    if(q.status!=='resolved'||!effect.commission_is_paid||r.body.amount_minor>Number(effect.recovery_remaining_minor))fail(409,'Recovery exceeds the remaining review balance.');
    await tx.query('INSERT INTO commission_recoveries(id,review_id,amount_minor,actor_id,note) VALUES($1,$2,$3,$4,$5)',[r.body.idempotency_key,q.id,r.body.amount_minor,r.teamUser.id,note]);
    await audit(tx,r.teamUser.id,'commission.recovery_demo',q.id,{amount_minor:r.body.amount_minor,note});
    const sale=await one(tx,'SELECT seller_id FROM commercial_sales WHERE id=$1',[q.sale_id]);
    await tx.query('INSERT INTO team_notifications(id,user_id,body) VALUES($1,$2,$3)',[randomUUID(),sale.seller_id,'A demo commission recovery record was added. No real transfer or deduction from other sales was made.']);
    return{ok:true,simulated_only:true};
  }));
}
