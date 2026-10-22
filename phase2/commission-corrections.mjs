import {randomUUID} from 'node:crypto';
import {fail} from '../viicasa-backend/src/lib.js';
import * as s from '../viicasa-backend/src/schemas.js';
import {snapshotHash} from './agreement-content.mjs';
import {audit} from './api.mjs';
import {commissionLock,commissionBalance,reviewRoot} from './commission-core.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
export function registerCommissionCorrections(app,{db,adminGuard,userGuard}){
  app.get('/api/commercial/commission-review/:id/corrections',{preHandler:userGuard,schema:{params:s.object({id:s.uuid})}},async(r,reply)=>{
    reply.header('Cache-Control','private, no-store');const q=await one(db,'SELECT q.* FROM commission_reviews q JOIN commercial_sales v ON v.id=q.sale_id WHERE q.id=$1 AND ($2::boolean OR v.seller_id=$3)',[r.params.id,r.teamUser.role==='admin',r.teamUser.id]);if(!q)fail(404,'Review not found.');
    await commissionBalance(db,q.sale_id);return{original:q,items:(await db.query('SELECT * FROM commission_corrections WHERE review_id=$1 ORDER BY sequence',[q.id])).rows,supplements:(await db.query('SELECT * FROM commission_supplements WHERE review_id=$1 ORDER BY created_at,id',[q.id])).rows};
  });
  app.post('/api/commercial/commission-review/:id/correct',{preHandler:adminGuard,schema:{params:s.object({id:s.uuid}),body:s.object({request_id:s.uuid,correction_revision:s.int(0),reduction_minor:s.int(0),note:s.str(2000,3),acknowledged:{const:true}})}},r=>db.transaction(async tx=>{
    await commissionLock(tx);const q=await one(tx,'SELECT * FROM commission_reviews WHERE id=$1 FOR UPDATE',[r.params.id]);if(!q)fail(404,'Review not found.');
    const input={...r.body,note:r.body.note.trim()};if(input.note.length<3)fail(400,'Explain the authorised correction.');const payload=snapshotHash({review_id:q.id,...input}),old=await one(tx,'SELECT * FROM commission_corrections WHERE id=$1',[input.request_id]);
    if(old){if(old.review_id!==q.id||old.payload_hash!==payload)fail(409,'Correction key has different details.');return{ok:true,duplicate:true,sequence:old.sequence};}
    if(q.status!=='resolved'||snapshotHash(q.evidence)!==q.evidence_hash)fail(409,'An unchanged resolved review is required.');
    const sale=await one(tx,'SELECT * FROM commercial_sales WHERE id=$1 FOR UPDATE',[q.sale_id]),balance=await commissionBalance(tx,sale.id),current=await one(tx,'SELECT * FROM commission_review_effects WHERE id=$1',[q.id]);
    if(current.correction_revision!==input.correction_revision)fail(409,'Correction history changed. Refresh first.');
    if(sale.status!=='paid'||sale.commission_status==='cancelled')fail(409,'Unpaid sales or cancelled commissions require a separate investigation.');
    if(balance.commission_review_required)fail(409,'Resolve pending refund reviews before correcting a prior decision.');
    if(input.reduction_minor>balance.effective_commission_minor+Number(current.current_reduction_minor))fail(409,'Reduction exceeds the original commission remaining across all reviews.');
    if(input.reduction_minor===Number(current.current_reduction_minor))fail(400,'Choose a different reduction target; history notes do not change a decision.');
    const last=await one(tx,'SELECT evidence_hash FROM commission_corrections WHERE review_id=$1 ORDER BY sequence DESC LIMIT 1',[q.id]),previous=last?.evidence_hash||reviewRoot(q),sequence=input.correction_revision+1;
    const evidence={previous_hash:previous,sequence,review_id:q.id,reduction_minor:input.reduction_minor,previous_reduction_minor:Number(current.current_reduction_minor),baseline_minor:Number(current.baseline_minor),recovered_minor:Number(current.recovered_minor),supplemented_minor:Number(current.supplemented_minor),commission_paid_minor:sale.commission_paid_minor===null?null:Number(sale.commission_paid_minor),note:input.note,actor_id:r.teamUser.id};
    await tx.query('INSERT INTO commission_corrections(id,review_id,sequence,reduction_minor,previous_hash,evidence,evidence_hash,payload_hash,actor_id,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[input.request_id,q.id,sequence,input.reduction_minor,previous,JSON.stringify(evidence),snapshotHash(evidence),payload,r.teamUser.id,input.note]);
    await audit(tx,r.teamUser.id,'commission.correction',q.id,{sequence,previous_hash:previous,evidence_hash:snapshotHash(evidence),simulated_only:true});
    await tx.query('INSERT INTO team_notifications(id,user_id,body) VALUES($1,$2,$3)',[randomUUID(),sale.seller_id,'A reviewed commission correction was appended in demo. Original decisions and payouts were preserved. '+input.note]);return{ok:true,sequence};
  }));
  app.post('/api/commercial/commission-review/:id/supplement',{preHandler:adminGuard,schema:{params:s.object({id:s.uuid}),body:s.object({request_id:s.uuid,amount_minor:s.int(1),note:s.str(2000,3),demo_acknowledged:{const:true}})}},r=>db.transaction(async tx=>{
    await commissionLock(tx);const q=await one(tx,'SELECT * FROM commission_reviews WHERE id=$1 FOR UPDATE',[r.params.id]);if(!q)fail(404,'Review not found.');const note=r.body.note.trim();if(note.length<3)fail(400,'Explain the simulated supplemental payment.');
    const old=await one(tx,'SELECT * FROM commission_supplements WHERE id=$1',[r.body.request_id]);if(old){if(old.review_id!==q.id||Number(old.amount_minor)!==r.body.amount_minor||old.note!==note)fail(409,'Supplement key has different details.');return{ok:true,duplicate:true};}
    const balance=await commissionBalance(tx,q.sale_id),effect=await one(tx,'SELECT * FROM commission_review_effects WHERE id=$1',[q.id]);
    if(q.status!=='resolved'||balance.commission_status!=='paid'||r.body.amount_minor>Number(effect.supplement_due_minor))fail(409,'Supplement exceeds this review’s outstanding amount.');
    await tx.query('INSERT INTO commission_supplements(id,review_id,amount_minor,actor_id,note) VALUES($1,$2,$3,$4,$5)',[r.body.request_id,q.id,r.body.amount_minor,r.teamUser.id,note]);
    await audit(tx,r.teamUser.id,'commission.supplement_demo',q.id,{amount_minor:r.body.amount_minor,note});
    await tx.query('INSERT INTO team_notifications(id,user_id,body) VALUES($1,$2,$3)',[randomUUID(),balance.seller_id,'A fictitious commission supplement was recorded separately. No real bank transfer or change to the original payout was made.']);return{ok:true,simulated_only:true};
  }));
}
