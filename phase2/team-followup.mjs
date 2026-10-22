import {randomUUID} from 'node:crypto';
import {fail} from '../viicasa-backend/src/lib.js';
import * as s from '../viicasa-backend/src/schemas.js';
import {audit} from './api.mjs';
import {serviceToday} from './service-operations.mjs';

export const followupDefaults={task_reminders:false,team_visit_reminders:false,team_invoice_alerts:false,team_review_alerts:false,mail_failure_alerts:false,revision:0};
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const iso=v=>new Date(v).toISOString();
const date=v=>iso(v).slice(0,10);
const tomorrow=now=>new Date(Date.parse(serviceToday(now)+'T12:00:00Z')+86400000).toISOString().slice(0,10);
export async function followupSettings(db){return{...followupDefaults,...(await one(db,"SELECT value FROM phase2_settings WHERE key='team_followup'"))?.value};}
const enabledKinds=p=>[...(p.task_reminders?['task_due','task_overdue']:[]),...(p.team_visit_reminders?['visit_upcoming']:[]),...(p.team_invoice_alerts?['invoice_overdue','payment_review']:[]),...(p.team_review_alerts?['change_review']:[]),...(p.mail_failure_alerts?['mail_failure']:[])];

// Both the alert centre and notifications re-check the source, role and assignment
// on every read. A worker interval must never create a temporary permission gap.
export const visibleAlertSql=`a.status='active' AND a.kind=ANY($3::text[])
  AND (a.required_role IS NULL OR a.required_role=$2)
  AND (a.lead_id IS NULL OR EXISTS(SELECT 1 FROM crm_leads l WHERE l.id=a.lead_id AND ($2='admin' OR l.owner_id=$1)))
  AND CASE a.kind
    WHEN 'task_due' THEN EXISTS(SELECT 1 FROM crm_activities t WHERE t.id=a.resource_id AND t.kind='task' AND NOT t.done AND t.due_at=(a.details->>'due_at')::timestamptz AND t.due_at>=now() AND t.due_at<=now()+interval '24 hours')
    WHEN 'task_overdue' THEN EXISTS(SELECT 1 FROM crm_activities t WHERE t.id=a.resource_id AND t.kind='task' AND NOT t.done AND t.due_at=(a.details->>'due_at')::timestamptz AND t.due_at<now())
    WHEN 'visit_upcoming' THEN EXISTS(SELECT 1 FROM service_visits v JOIN service_contracts c ON c.id=v.contract_id WHERE v.id=a.resource_id AND v.status='scheduled' AND c.status='accepted' AND v.service_date=(a.details->>'service_date')::date AND v.service_date=(now() AT TIME ZONE 'America/Vancouver')::date+1)
    WHEN 'invoice_overdue' THEN EXISTS(SELECT 1 FROM service_invoices i WHERE i.id=a.resource_id AND i.status='issued' AND i.due_date=(a.details->>'due_date')::date AND i.due_date<(now() AT TIME ZONE 'America/Vancouver')::date)
    WHEN 'payment_review' THEN EXISTS(SELECT 1 FROM service_invoices i WHERE i.id=a.resource_id AND (i.status='payment_review' OR i.status='issued' AND (SELECT p.status FROM service_invoice_payments p WHERE p.invoice_id=i.id ORDER BY p.created_at DESC,p.id DESC LIMIT 1)='failed'))
    WHEN 'change_review' THEN EXISTS(SELECT 1 FROM service_change_requests q JOIN service_contracts c ON c.id=q.contract_id WHERE q.id=a.resource_id AND q.status='pending' AND c.status='accepted')
    WHEN 'mail_failure' THEN EXISTS(SELECT 1 FROM commercial_mail m WHERE m.id=a.resource_id AND m.delivery_scope='standard' AND (m.status='failed' OR m.status='pending' AND m.attempts>=3))
    ELSE false END`;
export async function visibleTeamAlerts(db,user){const p=await followupSettings(db);return(await db.query(`SELECT a.*,n.read FROM commercial_alerts a LEFT JOIN team_notifications n ON n.alert_id=a.id WHERE a.user_id=$1 AND ${visibleAlertSql} ORDER BY a.created_at DESC LIMIT 150`,[user.id,user.role,enabledKinds(p)])).rows;}
export async function visibleTeamNotifications(db,user){const p=await followupSettings(db);return(await db.query(`SELECT n.id,n.user_id,n.body,n.read,n.created_at,n.alert_id,a.kind AS alert_kind FROM team_notifications n LEFT JOIN commercial_alerts a ON a.id=n.alert_id WHERE n.user_id=$1 AND (n.alert_id IS NULL OR (${visibleAlertSql})) ORDER BY n.created_at DESC LIMIT 100`,[user.id,user.role,enabledKinds(p)])).rows;}

export async function processTeamFollowup(db,{now=new Date(),source='worker',actorId=null}={}){
  if(!['worker','admin'].includes(source)||Number.isNaN(now.getTime()))throw Error('Invalid follow-up execution.');
  return db.transaction(async tx=>{
    await tx.query("INSERT INTO phase2_settings(key,value) VALUES('team_followup',$1) ON CONFLICT(key) DO NOTHING",[JSON.stringify(followupDefaults)]);
    await tx.query("SELECT key FROM phase2_settings WHERE key='team_followup' FOR UPDATE");
    const preferences=await followupSettings(tx),kinds=enabledKinds(preferences);
    if(!kinds.length){const resolved=(await tx.query("UPDATE commercial_alerts SET status='resolved',resolved_at=$1 WHERE status='active' RETURNING id",[now])).rows.length;return{disabled:true,considered:0,activated:0,resolved};}
    const admins=(await tx.query("SELECT id FROM team_users WHERE role='admin' AND active AND NOT deleted ORDER BY id")).rows;
    const pending=[];
    const add=(kind,resourceId,leadId,ownerId,body,details,version='',onlyAdmin=false)=>{
      const recipients=onlyAdmin?admins:[{id:ownerId},...admins];
      for(const id of new Set(recipients.map(u=>u.id).filter(Boolean)))pending.push({kind,resourceId,leadId,body,details,id,requiredRole:onlyAdmin?'admin':null,key:[kind,resourceId,version,id].join(':')});
    };
    if(preferences.task_reminders){
      const tasks=(await tx.query("SELECT t.*,l.owner_id,l.name,(u.active AND NOT u.deleted) AS owner_active FROM crm_activities t JOIN crm_leads l ON l.id=t.lead_id JOIN team_users u ON u.id=l.owner_id WHERE t.kind='task' AND NOT t.done AND t.due_at<=$1::timestamptz+interval '24 hours'",[now])).rows;
      for(const t of tasks){const kind=new Date(t.due_at)<now?'task_overdue':'task_due';add(kind,t.id,t.lead_id,t.owner_active?t.owner_id:null,(kind==='task_overdue'?'Overdue task':'Upcoming task')+' · '+t.name,{due_at:iso(t.due_at),tab:'tasks'},iso(t.due_at));}
    }
    if(preferences.team_visit_reminders){
      const visits=(await tx.query("SELECT v.*,c.lead_id,l.owner_id,l.name,(u.active AND NOT u.deleted) AS owner_active FROM service_visits v JOIN service_contracts c ON c.id=v.contract_id JOIN crm_leads l ON l.id=c.lead_id JOIN team_users u ON u.id=l.owner_id WHERE v.status='scheduled' AND c.status='accepted' AND v.service_date=$1::date",[tomorrow(now)])).rows;
      for(const v of visits)add('visit_upcoming',v.id,v.lead_id,v.owner_active?v.owner_id:null,'Tomorrow’s service visit · '+v.name,{service_date:date(v.service_date),tab:'visits'},date(v.service_date));
    }
    if(preferences.team_invoice_alerts){
      const invoices=(await tx.query("SELECT i.*,c.lead_id,l.owner_id,(u.active AND NOT u.deleted) AS owner_active,(SELECT p.status FROM service_invoice_payments p WHERE p.invoice_id=i.id ORDER BY p.created_at DESC,p.id DESC LIMIT 1) AS latest_payment FROM service_invoices i JOIN service_contracts c ON c.id=i.contract_id JOIN crm_leads l ON l.id=c.lead_id JOIN team_users u ON u.id=l.owner_id WHERE i.status IN ('issued','payment_review')")).rows;
      for(const i of invoices){const owner=i.owner_active?i.owner_id:null;if(i.status==='issued'&&date(i.due_date)<serviceToday(now))add('invoice_overdue',i.id,i.lead_id,owner,'Invoice awaiting payment · '+i.number,{due_date:date(i.due_date),tab:'invoices'},date(i.due_date));if(i.status==='payment_review'||i.latest_payment==='failed')add('payment_review',i.id,i.lead_id,owner,'Payment requires review · '+i.number,{tab:'invoices'});}
    }
    if(preferences.team_review_alerts){
      const changes=(await tx.query("SELECT q.*,c.lead_id,l.owner_id FROM service_change_requests q JOIN service_contracts c ON c.id=q.contract_id JOIN crm_leads l ON l.id=c.lead_id WHERE q.status='pending' AND c.status='accepted' AND q.created_at<=$1::timestamptz-interval '48 hours'",[now])).rows;
      for(const q of changes)add('change_review',q.id,q.lead_id,q.owner_id,'Service change awaiting review',{tab:'changes'},'',true);
    }
    if(preferences.mail_failure_alerts){const messages=(await tx.query("SELECT id FROM commercial_mail WHERE delivery_scope='standard' AND (status='failed' OR status='pending' AND attempts>=3)")).rows;for(const m of messages)add('mail_failure',m.id,null,null,'Queued email requires attention',{tab:'outbox'},'',true);}
    let activated=0;
    const retained=[];
    for(const p of pending){
      const old=(await tx.query('SELECT id,status FROM commercial_alerts WHERE event_key=$1 FOR UPDATE',[p.key])).rows[0],id=old?.id||randomUUID();retained.push(id);
      if(!old){await tx.query("INSERT INTO commercial_alerts(id,event_key,user_id,lead_id,kind,resource_id,required_role,status,body,details,last_seen_at) VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10)",[id,p.key,p.id,p.leadId,p.kind,p.resourceId,p.requiredRole,p.body,JSON.stringify(p.details),now]);}
      else await tx.query("UPDATE commercial_alerts SET status='active',body=$2,details=$3,last_seen_at=$4,resolved_at=NULL WHERE id=$1",[id,p.body,JSON.stringify(p.details),now]);
      if(!old||old.status==='resolved'){
        await tx.query('INSERT INTO team_notifications(id,user_id,body,alert_id) VALUES($1,$2,$3,$4) ON CONFLICT(alert_id) WHERE alert_id IS NOT NULL DO UPDATE SET read=false,body=EXCLUDED.body,created_at=now()',[randomUUID(),p.id,p.body,id]);activated++;
      }
    }
    const resolved=(await tx.query("UPDATE commercial_alerts SET status='resolved',resolved_at=$1 WHERE status='active' AND NOT(id=ANY($2::uuid[])) RETURNING id",[now,retained])).rows.length;
    await tx.query('INSERT INTO followup_runs(id,started_at,considered,activated,resolved,source,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),now,pending.length,activated,resolved,source,actorId]);
    await tx.query('DELETE FROM followup_runs WHERE id IN (SELECT id FROM followup_runs ORDER BY completed_at DESC,id DESC OFFSET 100)');
    return{disabled:false,considered:pending.length,activated,resolved};
  });
}
export function registerTeamFollowup(app,{db,userGuard,adminGuard}){
  const fields=Object.fromEntries(Object.keys(followupDefaults).map(k=>[k,k==='revision'?s.int(0):s.bool]));
  app.get('/api/commercial/followup/settings',{preHandler:adminGuard},()=>followupSettings(db));
  app.put('/api/commercial/followup/settings',{preHandler:adminGuard,schema:{body:s.object(fields)}},async r=>db.transaction(async tx=>{
    await tx.query("INSERT INTO phase2_settings(key,value) VALUES('team_followup',$1) ON CONFLICT(key) DO NOTHING",[JSON.stringify(followupDefaults)]);
    const old=(await tx.query("SELECT value FROM phase2_settings WHERE key='team_followup' FOR UPDATE")).rows[0].value;
    if(old.revision!==r.body.revision)fail(409,'Preferences changed. Reload before saving.');
    const saved={...r.body,revision:old.revision+1};await tx.query("UPDATE phase2_settings SET value=$1,updated_at=now() WHERE key='team_followup'",[JSON.stringify(saved)]);await audit(tx,r.teamUser.id,'followup.settings','team',saved);return saved;
  }));
  app.get('/api/commercial/followup/alerts',{preHandler:userGuard},async(r,reply)=>{reply.header('Cache-Control','private, no-store');return{items:await visibleTeamAlerts(db,r.teamUser),internal_only:true};});
  app.get('/api/commercial/followup/runs',{preHandler:adminGuard},async()=>({items:(await db.query('SELECT * FROM followup_runs ORDER BY completed_at DESC LIMIT 20')).rows}));
  app.post('/api/commercial/followup/process',{preHandler:adminGuard,schema:{body:s.object({})}},async r=>{const result=await processTeamFollowup(db,{source:'admin',actorId:r.teamUser.id});await audit(db,r.teamUser.id,'followup.process','team',result);return result;});
}
