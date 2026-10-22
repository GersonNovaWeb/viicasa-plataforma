import {randomUUID} from 'node:crypto';
import {fail} from '../viicasa-backend/src/lib.js';
import * as s from '../viicasa-backend/src/schemas.js';
import {audit} from './api.mjs';
import {csvCell} from './commercial-reports.mjs';
import {snapshotHash} from './agreement-content.mjs';
import {launchCatalogue,launchCatalogueVersion} from './launch-catalogue.mjs';
import {connectionRequirements,approvalKeys} from './readiness.mjs';

export const launchStates=['pending','in_progress','blocked','ready_for_test','passed','failed'];
const secretPattern=/\b(?:sk_(?:test|live)_|rk_(?:test|live)_|whsec_|AIza|ghp_|github_pat_|xox[baprs]-)|-----BEGIN[^\r\n]*PRIVATE KEY/i;
const validDate=v=>v===null||/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T12:00:00Z'))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v;
const lock=tx=>tx.query('SELECT pg_advisory_xact_lock(73182012)');

// Presence, not values. Adding keys never claims an external adapter is implemented.
export function safeLaunchRuntime({origin,config,databaseDriver,identityStatus,connectionEnvironment,paymentProvider,sourceRevision,adapterStatus={}}){
  return{origin,runtime_mode:config.runtimeMode||'demo',source_revision:sourceRevision,database_driver:databaseDriver,payment_provider:paymentProvider,
    stripe_test_key:Boolean(config.stripeKey?.startsWith('sk_test_')),stripe_webhook:Boolean(config.stripeWebhookSecret),
    smtp_ready:config.mailMode==='smtp'&&Boolean(config.smtp?.host&&config.smtp?.auth?.user&&config.smtp?.auth?.pass),
    mail_delivery_reference:snapshotHash({host:config.smtp?.host||'',port:config.smtp?.port||null,secure:Boolean(config.smtp?.secure),
      user:config.smtp?.auth?.user||'',from:config.mailFrom||'',administrator:config.adminEmail||''}),
    mail_mode:config.mailMode,google_enabled:Boolean(identityStatus.google?.enabled),apple_enabled:Boolean(identityStatus.apple?.enabled),
    credentials:Object.fromEntries(Object.entries(connectionRequirements).map(([provider,r])=>[provider,r.variables.map(name=>({name,present:Boolean(connectionEnvironment[name])}))])),
    adapter_code:{stripe_recurring:true,stripe_refund:true,shopify:true,stay:false,analytics:true},
    adapters:{stripe_recurring:false,stripe_refund:false,shopify:false,stay:false,analytics:false,...adapterStatus},
    provider_configuration_reference:snapshotHash(Object.fromEntries(['PHASE2_SHOPIFY_STORE','PHASE2_SHOPIFY_LOCATION_ID','PHASE2_SHOPIFY_API_VERSION','PHASE2_SHOPIFY_CHECKOUT_HOSTS','PHASE2_SHOPIFY_CHECKOUT_APPROVED','PHASE2_SHOPIFY_MAIL_APPROVED','PHASE2_SHOPIFY_SYNC_ENABLED','PHASE2_SHOPIFY_TEST_ONLY','PHASE2_STRIPE_AUTO_COLLECT','PHASE2_GA4_MEASUREMENT_ID','PHASE2_META_PIXEL_ID','PHASE2_META_GRAPH_VERSION','PHASE2_META_TEST_EVENT_CODE','PHASE2_GTM_CONTAINER_ID','PHASE2_GTM_CONTAINER_APPROVED'].map(key=>[key,connectionEnvironment[key]||null])))};
}

function requirementBlockers(requirements,runtime){
  return requirements.filter(id=>!({stripe_test:runtime.payment_provider==='stripe'&&runtime.stripe_test_key&&runtime.stripe_webhook,
    smtp:runtime.smtp_ready,google:runtime.google_enabled,apple:runtime.apple_enabled,remote_database:runtime.database_driver==='postgres',
    stripe_recurring_adapter:runtime.adapters.stripe_recurring,stripe_refund_adapter:runtime.adapters.stripe_refund,
    shopify_adapter:runtime.adapters.shopify,stay_adapter:runtime.adapters.stay,analytics_adapter:runtime.adapters.analytics})[id])
    .map(id=>'requirement:'+id);
}

export async function launchReadiness(db,runtime){
  const settings=(await db.query('SELECT key,value FROM phase2_settings ORDER BY key')).rows;
  const rules=(await db.query('SELECT service,basis_points,approved FROM commission_rules ORDER BY service')).rows;
  const team=(await db.query('SELECT id,name,role,active,deleted,auth_version FROM team_users ORDER BY id')).rows;
  const saved=(await db.query("SELECT *,to_char(due_date,'YYYY-MM-DD') AS planned_date FROM launch_checks")).rows;
  const configuration=settings.filter(r=>r.key.startsWith('approval:')||r.key.startsWith('connection:')||r.key.startsWith('pricing:')||['measurement','external_analytics','recurring_demo','service_reminders','team_followup','closing_policy','channel_pricing'].includes(r.key));
  const fingerprint=snapshotHash({catalogue_version:launchCatalogueVersion,runtime,configuration,rules,
    permissions:team.map(({id,role,active,deleted,auth_version})=>({id,role,active,deleted,auth_version}))});
  const items=launchCatalogue.map(definition=>{
    const row=saved.find(r=>r.check_id===definition.id),state=row?.state||'pending';
    const owner=team.find(u=>u.id===row?.owner_id),ownerValid=!row?.owner_id||Boolean(owner?.active&&!owner.deleted&&owner.role==='admin');
    return{...definition,revision:row?.revision||0,state,effective_state:state==='passed'&&(row.fingerprint!==fingerprint||!ownerValid)?'stale':state,
      owner_id:row?.owner_id||null,owner_name:owner?.name||'',due_date:row?.planned_date||null,note:row?.note||'',evidence:row?.evidence||'',
      actor_id:row?.actor_id||null,updated_at:row?.updated_at||null,result_fingerprint:row?.fingerprint||null,
      blockers:[...requirementBlockers(definition.requires,runtime),...definition.approvals.filter(id=>settings.find(r=>r.key==='approval:'+id)?.value.approved!==true).map(id=>'approval:'+id)]};
  });
  // Catalogue dependencies are declared before their consumers. A withdrawn or
  // stale dependency makes dependent results stale too, without rewriting history.
  for(const item of items){
    item.blockers.push(...item.dependencies.filter(id=>items.find(i=>i.id===id)?.effective_state!=='passed').map(id=>'check:'+id));
    if(item.state==='passed'&&item.blockers.length)item.effective_state='stale';
    item.eligible_for_reported_pass=item.blockers.length===0;
  }
  const totals={total:items.length,passed:0,stale:0,pending:0,in_progress:0,blocked:0,ready_for_test:0,failed:0};
  for(const item of items)totals[item.effective_state]++;
  const missingApprovals=approvalKeys.filter(id=>settings.find(r=>r.key==='approval:'+id)?.value.approved!==true);
  return{mode:runtime.runtime_mode||'demo',production_enabled:false,independently_verified:false,verification:'manual_team_report',fingerprint,
    source_revision:runtime.source_revision,catalogue_version:launchCatalogueVersion,totals,items,
    owners:team.filter(u=>u.role==='admin'&&u.active&&!u.deleted).map(({id,name})=>({id,name})),
    missing_recorded_approvals:missingApprovals,generated_at:new Date().toISOString(),
    limitations:['No tests run from this panel.','Recorded results are team reports, not independent certification.',
      'No secret values or remote requests are used. Credential rotation with unchanged presence requires manual revalidation.',
      'Source revision belongs to this running process. Restart after editing code.','Promotion to the official platform is a separate authorised workflow.']};
}

export function registerLaunchReadiness(app,{db,adminGuard,runtime}){
  const read=()=>db.transaction(async tx=>{await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');return launchReadiness(tx,runtime);});
  app.get('/api/commercial/launch',{preHandler:adminGuard},async(_,reply)=>{reply.header('Cache-Control','private, no-store');return read();});
  app.get('/api/commercial/launch/checks/:id/history',{preHandler:adminGuard,schema:{params:s.object({id:s.str(80)})}},async(r,reply)=>{
    if(!launchCatalogue.some(i=>i.id===r.params.id))fail(404,'Launch item not found.');reply.header('Cache-Control','private, no-store');
    return{items:(await db.query('SELECT h.*,u.name AS actor_name FROM launch_check_history h JOIN team_users u ON u.id=h.actor_id WHERE h.check_id=$1 ORDER BY h.revision DESC LIMIT 100',[r.params.id])).rows};
  });
  const body=s.object({revision:s.int(0),state:s.choice(launchStates),owner_id:{anyOf:[s.uuid,{type:'null'}]},due_date:{anyOf:[s.date,{type:'null'}]},
    note:s.str(4000,0),evidence:s.str(6000,0),fingerprint:{type:'string',pattern:'^[a-f0-9]{64}$'}});
  app.put('/api/commercial/launch/checks/:id',{preHandler:adminGuard,schema:{params:s.object({id:s.str(80)}),body}},async r=>db.transaction(async tx=>{
    if(!launchCatalogue.some(i=>i.id===r.params.id))fail(404,'Launch item not found.');
    const b=r.body,note=b.note.trim(),evidence=b.evidence.trim();
    if(!validDate(b.due_date))fail(400,'Enter a valid calendar date.');
    if(secretPattern.test(note+'\n'+evidence))fail(400,'Do not store API keys or private keys in launch notes/evidence.');
    if(['blocked','failed'].includes(b.state)&&note.length<3)fail(400,'Describe the blocker or failure.');
    if(b.state==='passed'&&(note.length<3||evidence.length<10||!b.owner_id))fail(400,'A reported pass requires an active administrator owner, result note and evidence reference.');
    await lock(tx);
    await tx.query('INSERT INTO launch_checks(check_id) VALUES($1) ON CONFLICT(check_id) DO NOTHING',[r.params.id]);
    const old=(await tx.query('SELECT * FROM launch_checks WHERE check_id=$1 FOR UPDATE',[r.params.id])).rows[0];
    if(old.revision!==b.revision)fail(409,'This item changed. Refresh before saving.');
    const current=await launchReadiness(tx,runtime),item=current.items.find(i=>i.id===r.params.id);
    if(current.fingerprint!==b.fingerprint)fail(409,'Configuration or code revision changed. Refresh the plan before reporting a result.');
    if(b.owner_id&&!current.owners.some(u=>u.id===b.owner_id))fail(409,'Assign an active administrator.');
    if(b.state==='passed'&&!item.eligible_for_reported_pass)fail(409,'Prerequisites or dependencies are still pending. Do not report a pass yet.');
    const snapshot={state:b.state,owner_id:b.owner_id,due_date:b.due_date,note,evidence,fingerprint:current.fingerprint,source_revision:runtime.source_revision,verification:'manual_team_report'};
    await tx.query('UPDATE launch_checks SET revision=revision+1,state=$2,owner_id=$3,due_date=$4,note=$5,evidence=$6,fingerprint=$7,actor_id=$8,updated_at=now() WHERE check_id=$1',
      [r.params.id,b.state,b.owner_id,b.due_date,note,evidence,current.fingerprint,r.teamUser.id]);
    await tx.query('INSERT INTO launch_check_history(id,check_id,revision,actor_id,snapshot) VALUES($1,$2,$3,$4,$5)',[randomUUID(),r.params.id,old.revision+1,r.teamUser.id,JSON.stringify(snapshot)]);
    await audit(tx,r.teamUser.id,'launch.report',r.params.id,{state:b.state,revision:old.revision+1,fingerprint:current.fingerprint});
    return{ok:true,revision:old.revision+1,verification:'manual_team_report',production_enabled:false};
  }));
  app.get('/api/commercial/launch/export',{preHandler:adminGuard,schema:{querystring:s.object({format:s.choice(['json','csv'])},[])}},async(r,reply)=>{
    const report=await read();await audit(db,r.teamUser.id,'launch.export','phase2',{fingerprint:report.fingerprint});
    reply.header('Cache-Control','private, no-store');
    if(r.query.format!=='csv')return reply.header('Content-Disposition','attachment; filename="viicasa-phase2-launch-report.json"').send(report);
    const rows=[['Check','Group','Title','Recorded state','Current state','Owner','Due date','Note','Evidence reference','Pending prerequisites','Fingerprint','Source revision','Verification'],
      ...report.items.map(i=>[i.id,i.group,i.title.en,i.state,i.effective_state,i.owner_name,i.due_date,i.note,i.evidence,i.blockers.join(' | '),report.fingerprint,report.source_revision,'Manual team report; not production certification'])];
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition','attachment; filename="viicasa-phase2-launch-report.csv"').send('\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n'));
  });
}
