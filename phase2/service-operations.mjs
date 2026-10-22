import {randomUUID} from 'node:crypto';
import {fail} from '../viicasa-backend/src/lib.js';
import * as s from '../viicasa-backend/src/schemas.js';
import {audit} from './api.mjs';
import {snapshotHash} from './agreement-content.mjs';
import {queueCommercialMail,serviceMail} from './mail.mjs';
import {invoiceFinance} from './financial-core.mjs';
import {serviceDay as serviceToday,addServiceDays as addDays} from './service-time.mjs';
const one=async(db,sql,args)=>(await db.query(sql,args)).rows[0];
const iso=v=>new Date(v).toISOString().slice(0,10);
export {serviceToday};
const validDate=v=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||Number.isNaN(Date.parse(v))||iso(v)!==v)fail(400,'Enter a valid date.');return v;};
const defaults={visit_reminders:false,invoice_reminders:false};
const settings=async db=>(await one(db,"SELECT value FROM phase2_settings WHERE key='service_reminders'",[]))?.value||defaults;

export async function registerServiceOperations(app,{db,origin,teamGuard,adminGuard,customerGuard,config}){
  const team='/api/commercial',client='/api/client';
  const route=(method,url,body,guard,handler)=>app.route({method,url,...(body?{schema:{body}}:{}),preHandler:guard,handler});
  const own=async(tx,id,u)=>{const c=await one(tx,'SELECT c.*,l.owner_id FROM service_contracts c JOIN crm_leads l ON l.id=c.lead_id WHERE c.id=$1 FOR UPDATE OF c',[id]);if(!c||u.role!=='admin'&&c.owner_id!==u.id)fail(404,'Agreement not found.');return c;};
  const notify=async(tx,c,id,subject,paragraphs,toCustomer=true)=>{
    if(toCustomer)await queueCommercialMail(tx,id+':client',c.customer_email,serviceMail({subject,title:subject,paragraphs,actionUrl:new URL('/cliente',origin).href}));
    await queueCommercialMail(tx,id+':team',config.adminEmail,serviceMail({subject:subject+' · team notice',title:subject,paragraphs,details:[['Client',c.customer_email],['Agreement',c.id]],actionUrl:new URL('/equipo',origin).href,actionLabel:'Open team workspace'}));
    await tx.query('INSERT INTO team_notifications(id,user_id,body) VALUES($1,$2,$3)',[randomUUID(),c.seller_id,subject+' · '+c.customer_email]);
  };
  route('GET',client+'/changes',null,customerGuard,async r=>({items:(await db.query('SELECT * FROM service_change_requests WHERE customer_id=$1 ORDER BY created_at DESC',[r.customer.id])).rows}));
  route('POST',client+'/changes',s.object({contract_id:s.uuid,visit_id:s.uuid,kind:s.choice(['reschedule','cancel_visit','terminate']),requested_date:s.date,requested_window:s.str(120,3),reason:s.str(2000,3),idempotency_key:s.uuid},['contract_id','kind','reason','idempotency_key']),customerGuard,async r=>db.transaction(async tx=>{
    const {idempotency_key,...details}=r.body,request_hash=snapshotHash(details),old=await one(tx,'SELECT * FROM service_change_requests WHERE customer_id=$1 AND idempotency_key=$2',[r.customer.id,idempotency_key]);
    if(old){if(old.request_hash!==request_hash)fail(409,'Request key used for different details.');return{id:old.id};}
    const c=await one(tx,"SELECT * FROM service_contracts WHERE id=$1 AND customer_email=$2 AND status='accepted' FOR UPDATE",[details.contract_id,r.customer.email]);if(!c)fail(404,'Active agreement not found.');
    const replay=await one(tx,'SELECT * FROM service_change_requests WHERE customer_id=$1 AND idempotency_key=$2',[r.customer.id,idempotency_key]);if(replay){if(replay.request_hash!==request_hash)fail(409,'Request key used for different details.');return{id:replay.id};}
    if(details.kind==='terminate'){
      if(details.visit_id||details.requested_window)fail(400,'Termination applies to the agreement.');
      if(await one(tx,'SELECT 1 FROM service_termination_plans WHERE contract_id=$1',[c.id]))fail(409,'A termination plan is already approved.');
    }else{
      if(!details.visit_id)fail(400,'Select a visit.');const v=await one(tx,"SELECT * FROM service_visits WHERE id=$1 AND contract_id=$2 AND status='scheduled' AND invoice_id IS NULL FOR UPDATE",[details.visit_id,c.id]);if(!v)fail(409,'Visit can no longer be changed.');
      if(details.kind==='reschedule'&&(!details.requested_date||!details.requested_window))fail(400,'Choose a new date and arrival window.');
    }
    if(details.requested_date&&validDate(details.requested_date)<serviceToday())fail(400,'Choose today or a future date.');
    if(await one(tx,"SELECT 1 FROM service_change_requests WHERE contract_id=$1 AND status='pending' AND (kind='terminate' OR $2='terminate' OR visit_id=$3::uuid)",[c.id,details.kind,details.visit_id||null]))fail(409,'Resolve or withdraw the existing change request first.');
    const id=randomUUID();await tx.query('INSERT INTO service_change_requests(id,contract_id,customer_id,visit_id,kind,requested_date,requested_window,reason,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,c.id,r.customer.id,details.visit_id||null,details.kind,details.requested_date||null,details.requested_window||'',details.reason,idempotency_key,request_hash]);
    await notify(tx,c,'change:'+id+':requested','Your ViiLife change request was received',['Your request has been saved for team review. The original schedule and payment terms remain unchanged until ViiLife confirms the change.','Request: '+details.kind+'. '+details.reason]);
    await tx.query('INSERT INTO contract_events(id,contract_id,actor_id,actor_kind,action,detail) VALUES($1,$2,$3,\'customer\',\'change.requested\',$4)',[randomUUID(),c.id,r.customer.id,JSON.stringify({request_id:id,...details})]);return{id};
  }));
  route('POST',client+'/changes/:id/withdraw',s.object({}),customerGuard,async r=>db.transaction(async tx=>{
    const q=await one(tx,'SELECT * FROM service_change_requests WHERE id=$1 AND customer_id=$2 FOR UPDATE',[r.params.id,r.customer.id]);if(!q)fail(404,'Request not found.');if(q.status==='withdrawn')return{ok:true};if(q.status!=='pending')fail(409,'Only pending requests can be withdrawn.');await tx.query("UPDATE service_change_requests SET status='withdrawn',revision=revision+1 WHERE id=$1",[q.id]);return{ok:true};
  }));
  route('GET',team+'/changes',null,teamGuard,async r=>({items:(await db.query('SELECT q.*,c.snapshot,c.customer_email,l.name AS client_name FROM service_change_requests q JOIN service_contracts c ON c.id=q.contract_id JOIN crm_leads l ON l.id=c.lead_id WHERE ($1::boolean OR l.owner_id=$2) ORDER BY q.created_at DESC',[r.teamUser.role==='admin',r.teamUser.id])).rows}));
  route('GET',team+'/changes/:id/impact',null,teamGuard,async r=>db.transaction(async tx=>{
    const q=await one(tx,'SELECT * FROM service_change_requests WHERE id=$1',[r.params.id]);if(!q)fail(404,'Request not found.');const c=await own(tx,q.contract_id,r.teamUser);
    const received=(await tx.query("SELECT coalesce(sum(discount_minor),0)::bigint AS n FROM service_invoices WHERE contract_id=$1 AND status='paid'",[c.id])).rows[0];
    const visits=(await tx.query("SELECT id,service_date,address,amount_minor FROM service_visits WHERE contract_id=$1 AND status='scheduled' AND invoice_id IS NULL ORDER BY service_date",[c.id])).rows;
    return{request:q,visits,earliest_standard_termination:c.snapshot.segment==='home'&&c.snapshot.quote.frequency!=='once'?addDays(serviceToday(new Date(q.created_at)),14):serviceToday(),received_discount_minor:Number(received.n),annual_discount_review:c.snapshot.segment==='commercial'&&c.snapshot.quote.term==='annual',automatic_penalties:false};
  }));
  route('POST',team+'/changes/:id/resolve',s.object({action:s.choice(['approve','decline']),revision:s.int(1),resolution:s.str(2000,3),effective_date:s.date,notice_waiver:s.bool},['action','revision','resolution']),adminGuard,async r=>db.transaction(async tx=>{
    const q=await one(tx,'SELECT * FROM service_change_requests WHERE id=$1 FOR UPDATE',[r.params.id]);if(!q)fail(404,'Request not found.');const c=await own(tx,q.contract_id,r.teamUser);
    if(q.status!=='pending'||q.revision!==r.body.revision)fail(409,'Request changed. Refresh before reviewing.');if(c.status!=='accepted')fail(409,'Agreement is no longer active.');
    let effective=null;
    if(r.body.action==='approve'){
      if(q.kind==='terminate'){
        effective=validDate(r.body.effective_date||'');if(effective<serviceToday()||q.requested_date&&effective<iso(q.requested_date))fail(400,'Choose an eligible termination date.');
        const minimum=c.snapshot.segment==='home'&&c.snapshot.quote.frequency!=='once'?addDays(serviceToday(new Date(q.created_at)),14):serviceToday();if(effective<minimum&&!r.body.notice_waiver)fail(409,'Use the notice period or explicitly approve an exception.');
        await tx.query('INSERT INTO service_termination_plans(contract_id,request_id,effective_date,resolution) VALUES($1,$2,$3,$4)',[c.id,q.id,effective,r.body.resolution]);
        const affected=(await tx.query("SELECT id FROM service_visits WHERE contract_id=$1 AND status='scheduled' AND invoice_id IS NULL AND service_date>=$2::date",[c.id,effective])).rows;
        for(const v of affected)await tx.query("UPDATE commercial_mail SET status='cancelled' WHERE status IN ('pending','failed') AND dedupe LIKE $1",['visit-reminder:'+v.id+':%']);
        await tx.query("UPDATE service_visits SET status='cancelled' WHERE contract_id=$1 AND status='scheduled' AND invoice_id IS NULL AND service_date>=$2::date",[c.id,effective]);
      }else{
        const v=await one(tx,"SELECT * FROM service_visits WHERE id=$1 AND contract_id=$2 AND status='scheduled' AND invoice_id IS NULL FOR UPDATE",[q.visit_id,c.id]);if(!v)fail(409,'Visit can no longer be changed.');
        if(q.kind==='cancel_visit')await tx.query("UPDATE service_visits SET status='cancelled' WHERE id=$1",[v.id]);
        else{
          effective=iso(q.requested_date);if(effective<serviceToday())fail(409,'Requested date is in the past. Ask for another date.');
          const plan=await one(tx,'SELECT * FROM service_termination_plans WHERE contract_id=$1',[c.id]);if(plan&&effective>=iso(plan.effective_date))fail(409,'Visit would fall after termination.');
          if(c.snapshot.quote.discount_months){const d=new Date(c.snapshot.details.first_service_date+'T12:00:00Z');d.setUTCMonth(d.getUTCMonth()+3);if(effective<c.snapshot.details.first_service_date||effective>=iso(d))fail(409,'Prepare a revised quote outside the introductory period.');}
          if(await one(tx,'SELECT 1 FROM service_visits WHERE contract_id=$1 AND property_index=$2 AND service_date=$3::date AND id<>$4',[c.id,v.property_index,effective,v.id]))fail(409,'Another visit already occupies this property and date.');
          await tx.query('UPDATE service_visits SET service_date=$2,arrival_window=$3 WHERE id=$1',[v.id,effective,q.requested_window]);
        }
        await tx.query("UPDATE commercial_mail SET status='cancelled' WHERE status IN ('pending','failed') AND dedupe LIKE $1",['visit-reminder:'+v.id+':%']);
      }
    }
    await tx.query('UPDATE service_change_requests SET status=$2,revision=revision+1,resolution=$3,effective_date=$4,resolved_by=$5,resolved_at=now() WHERE id=$1',[q.id,r.body.action==='approve'?'approved':'declined',r.body.resolution,effective,r.teamUser.id]);
    await audit(tx,r.teamUser.id,'service.change.'+r.body.action,q.id,{kind:q.kind,effective_date:effective,notice_waiver:r.body.notice_waiver||false,automatic_charge:false});
    await notify(tx,c,'change:'+q.id+':resolved','ViiLife has reviewed your change request',[r.body.action==='approve'?'Your change request has been approved.':'Your request was not approved; the existing schedule remains in place.',r.body.resolution,...(effective?['Confirmed date: '+effective]:[]),'No penalty, refund or additional charge has been processed automatically.']);return{ok:true};
  }));
  route('GET',team+'/operations/settings',null,adminGuard,()=>settings(db));
  route('PUT',team+'/operations/settings',s.object({visit_reminders:s.bool,invoice_reminders:s.bool}),adminGuard,async r=>{await db.transaction(async tx=>{await tx.query("INSERT INTO phase2_settings(key,value) VALUES('service_reminders',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[JSON.stringify(r.body)]);await audit(tx,r.teamUser.id,'service.reminders.update','settings',r.body);});return r.body;});
  route('POST',team+'/operations/process',s.object({}),adminGuard,()=>processServiceOperations(db,config,origin));
}

export async function processServiceOperations(db,config,origin,{now=new Date()}={}){
  const today=serviceToday(now);return db.transaction(async tx=>{
    const plans=(await tx.query('SELECT * FROM service_termination_plans WHERE executed_at IS NULL AND effective_date<=$1::date FOR UPDATE',[today])).rows;
    for(const p of plans){await tx.query("UPDATE service_contracts SET status='cancelled' WHERE id=$1 AND status='accepted'",[p.contract_id]);await tx.query('UPDATE service_termination_plans SET executed_at=now() WHERE contract_id=$1',[p.contract_id]);await audit(tx,null,'service.termination.effective',p.contract_id,{effective_date:iso(p.effective_date),automatic_charge:false});}
    const preferences=await settings(tx);let reminders=0;
    if(preferences.visit_reminders){
      const visits=(await tx.query("SELECT v.*,c.customer_email FROM service_visits v JOIN service_contracts c ON c.id=v.contract_id WHERE v.status='scheduled' AND c.status='accepted' AND v.service_date=$1::date",[addDays(today,1)])).rows;
      for(const v of visits){await queueCommercialMail(tx,'visit-reminder:'+v.id+':'+iso(v.service_date),v.customer_email,serviceMail({subject:'Your upcoming ViiLife visit',title:'Your visit is coming up',paragraphs:['Please make sure property access is available. Contact ViiLife through your account if your plans have changed.'],details:[['Date',iso(v.service_date)],['Arrival window',v.arrival_window],['Property',v.address]],actionUrl:new URL('/cliente',origin).href}));reminders++;}
    }
    if(preferences.invoice_reminders){
      const invoices=(await tx.query("SELECT * FROM service_invoices WHERE status='issued' AND due_date<$1::date ORDER BY id FOR UPDATE",[today])).rows;
      for(const i of invoices){const f=await invoiceFinance(tx,i);if(f.reserved_credit_minor||f.due_minor<=0)continue;const weeks=Math.floor((new Date(today)-new Date(i.due_date))/604800000);await queueCommercialMail(tx,'invoice-reminder:'+i.id+':'+weeks,i.customer_email,serviceMail({subject:'Your ViiLife invoice is awaiting payment',title:'Invoice reminder',paragraphs:['Our records show this service invoice is awaiting payment. If you have questions, please contact ViiLife. No late charge has been added automatically.'],details:[['Invoice',i.number],['Amount',(f.due_minor/100).toFixed(2)+' CAD'],['Due date',iso(i.due_date)]],actionUrl:new URL('/cliente?invoice='+i.id,origin).href}));reminders++;}
    }
    return{terminations:plans.length,reminders_considered:reminders};
  });
}
