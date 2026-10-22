import {randomUUID} from 'node:crypto';
import {snapshotHash} from './agreement-content.mjs';
import {fail} from '../viicasa-backend/src/lib.js';

export const commissionLock=tx=>tx.query('SELECT pg_advisory_xact_lock(73182008)');
export const commissionEvidence=(sale,entry)=>({sale_id:sale.id,invoice_id:entry.invoice_id,refund_entry_id:entry.id,
  refund_reference:entry.reference,refund_minor:Number(entry.amount_minor),provider:entry.provider,
  original_commission_minor:Number(sale.commission_minor),sale_minor:Number(sale.amount_minor),seller_id:sale.seller_id,currency:sale.currency,
  commission_status:sale.commission_status,commission_paid_minor:sale.commission_paid_minor===null?null:Number(sale.commission_paid_minor),basis_points:sale.basis_points});

// Only completed ledger refunds trigger review. Approval or a failed refund does not.
// Caller owns the financial advisory lock; do not acquire sale then that lock.
export async function queueCommissionReviews(tx){
  const rows=(await tx.query(`SELECT e.id FROM financial_entries e JOIN commercial_sales v ON v.service_invoice_id=e.invoice_id
    WHERE e.kind='refund' AND NOT EXISTS(SELECT 1 FROM commission_reviews q WHERE q.refund_entry_id=e.id)
    ORDER BY e.created_at,e.id`)).rows;
  for(const row of rows){
    const entry=(await tx.query('SELECT * FROM financial_entries WHERE id=$1',[row.id])).rows[0];
    const sale=(await tx.query('SELECT * FROM commercial_sales WHERE service_invoice_id=$1 FOR UPDATE',[entry.invoice_id])).rows[0];
    if(!sale)continue;
    const evidence=commissionEvidence(sale,entry),id=randomUUID();
    const inserted=await tx.query(`INSERT INTO commission_reviews(id,sale_id,refund_entry_id,evidence,evidence_hash)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(refund_entry_id) DO NOTHING RETURNING id`,[id,sale.id,entry.id,JSON.stringify(evidence),snapshotHash(evidence)]);
    if(inserted.rows.length)await tx.query('INSERT INTO team_notifications(id,user_id,body) VALUES($1,$2,$3)',
      [randomUUID(),sale.seller_id,'A completed demo refund requires administrator review of this sale commission. No automatic deduction was applied. Reference: '+sale.reference]);
  }
}

export async function commissionBalance(db,saleId){
  await verifyCommissionCorrections(db,saleId);
  const row=(await db.query('SELECT * FROM commercial_commission_balances WHERE id=$1',[saleId])).rows[0];
  if(!row)fail(404,'Sale not found.');
  return Object.fromEntries(Object.entries(row).map(([k,v])=>[k,k.endsWith('_minor')?Number(v):v]));
}

export const reviewRoot=q=>snapshotHash({id:q.id,revision:q.revision,status:q.status,decision:q.decision,reduction_minor:Number(q.reduction_minor),disposition:q.disposition,note:q.note,actor_id:q.actor_id,evidence_hash:q.evidence_hash});
export async function verifyCommissionCorrections(db,saleId){
  const reviews=(await db.query('SELECT * FROM commission_reviews WHERE sale_id=$1',[saleId])).rows;
  for(const q of reviews){if(snapshotHash(q.evidence)!==q.evidence_hash)fail(409,'Commission review evidence needs investigation.');const entries=(await db.query('SELECT * FROM commission_corrections WHERE review_id=$1 ORDER BY sequence',[q.id])).rows;let previous=reviewRoot(q),seq=0;
    for(const c of entries){if(snapshotHash(q.evidence)!==q.evidence_hash||c.previous_hash!==previous||c.sequence!==++seq||snapshotHash(c.evidence)!==c.evidence_hash||c.evidence.previous_hash!==previous||c.evidence.reduction_minor!==Number(c.reduction_minor)||c.evidence.sequence!==seq||c.evidence.note!==c.note||c.evidence.actor_id!==c.actor_id)fail(409,'Commission correction history needs investigation.');previous=c.evidence_hash;}
  }
}

export async function requireReviewedCommission(tx,saleId){
  const balance=await commissionBalance(tx,saleId);
  if(balance.commission_review_required)fail(409,'Review the completed refund in Commission review before changing this commission or sale.');
  return balance;
}
