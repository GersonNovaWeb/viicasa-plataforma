import {randomUUID} from 'node:crypto';
import {passwordHash,fail} from '../viicasa-backend/src/lib.js';
import {audit} from './api.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
export function runtimeProfile(env={}){
  const mode=env.PHASE2_MODE||'demo';if(!['demo','staging'].includes(mode))throw Error('Use demo or staging. Production activation remains a separately authorised release.');
  if(mode==='staging'&&env.PHASE2_DATABASE_DRIVER==='postgres'&&env.PHASE2_DATABASE_SSL==='false')throw Error('Remote staging requires certificate-verified TLS.');
  if(mode==='staging'&&env.PHASE2_SITE_URL){const url=new URL(env.PHASE2_SITE_URL);if(url.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Public staging requires HTTPS; HTTP is restricted to loopback development.');}
  const directory=mode==='demo'?'data/phase2':'data/phase2-staging';
  return{mode,directory,seedExamples:mode==='demo',simulations:mode==='demo',payments:'test',productionEnabled:false};
}
export async function demoDataSummary(databases){
  const db=databases.commercial,checks={
    demo_users:"SELECT count(*)::integer AS n FROM team_users WHERE email LIKE '%@viicasa.demo.invalid'",
    demo_leads:"SELECT count(*)::integer AS n FROM crm_leads WHERE source='Demo seed'",
    demo_quotes:'SELECT count(*)::integer AS n FROM service_quotes WHERE demo_key IS NOT NULL',
    demo_units:'SELECT count(*)::integer AS n FROM stay_units WHERE demo_key IS NOT NULL',
    simulated_payments:"SELECT count(*)::integer AS n FROM service_invoice_payments WHERE provider='demo'",
    simulated_channel_events:"SELECT count(*)::integer AS n FROM channel_events WHERE source='admin_demo'",
    simulated_stay_events:"SELECT count(*)::integer AS n FROM stay_event_inbox WHERE authenticated_source='admin_demo'",
  },result={};for(const [name,sql] of Object.entries(checks))result[name]=(await one(db,sql)).n;
  result.platform_examples=(await databases.platform.query("SELECT count(*)::integer AS n FROM demo_documents WHERE collection IN ('products','properties') AND (body->>'is_demo'='true' OR body->>'demo_key' IS NOT NULL OR body->>'slug' LIKE 'sample-%')")).rows[0].n;
  return result;
}
const installations=new WeakMap();
export async function installRuntimeProfile(databases,profile){
  const install=()=>installProfile(databases,profile),db=databases.commercial;
  if(db.exclusiveJob){const result=await db.exclusiveJob(73182023,install);if(result?.skipped)throw Error('Another profile installation is active. Retry after it completes.');return result;}
  const before=installations.get(db)||Promise.resolve(),pending=before.catch(()=>{}).then(install);installations.set(db,pending);try{return await pending;}finally{if(installations.get(db)===pending)installations.delete(db);}
}
async function installProfile(databases,profile){
  const saved=(await one(databases.commercial,"SELECT value FROM phase2_settings WHERE key='runtime_profile'"))?.value;
  const platform=await databases.store.get('system','runtime_profile');
  if(saved&&saved.mode!==profile.mode||platform&&platform.mode!==profile.mode)throw Error('Use independent empty databases for this profile; no existing data will be erased or relabelled.');
  if(saved?.instance_id&&platform?.instance_id&&saved.instance_id!==platform.instance_id)throw Error('Commercial and platform databases belong to different installation pairs.');
  if(profile.mode==='staging'&&!saved){const occupied=(await databases.commercial.query("SELECT 1 FROM team_users UNION SELECT 1 FROM customer_accounts UNION SELECT 1 FROM crm_leads UNION SELECT 1 FROM service_contracts UNION SELECT 1 FROM commercial_sales LIMIT 1")).rows.length;if(occupied)throw Error('Existing business data cannot be adopted automatically as staging. Use fresh databases.');}
  if(profile.mode==='staging'&&!platform&&(await databases.platform.query('SELECT count(*)::integer AS n FROM demo_documents')).rows[0].n>0)throw Error('Existing platform data cannot be adopted automatically as staging.');
  if(profile.mode==='staging'&&Object.values(await demoDataSummary(databases)).some(n=>n>0))throw Error('Demo data found. Create a fresh staging pair; automatic cleanup is not allowed.');
  const instance_id=saved?.instance_id||platform?.instance_id||randomUUID();
  await databases.commercial.query("INSERT INTO phase2_settings(key,value) VALUES('runtime_profile',$1) ON CONFLICT(key) DO NOTHING",[JSON.stringify({mode:profile.mode,instance_id,created_at:new Date().toISOString()})]);
  if(!platform)await databases.store.set('system','runtime_profile',{mode:profile.mode,instance_id,created_at:new Date().toISOString()});
}
export async function initialiseAdministrator(db,{name,email,password,confirmed}){
  if(confirmed!==true||typeof name!=='string'||name.trim().length<2||name.length>120||typeof email!=='string'||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.endsWith('.invalid')||typeof password!=='string'||password.length<16||password.length>128||new Set(password).size<8||password.toLowerCase().includes(email.split('@')[0].toLowerCase()))fail(400,'Supply a real administrator email, name and strong private password (16–128 characters).');
  const password_hash=await passwordHash(password);
  return db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(73182021)');
    if((await one(tx,"SELECT value FROM phase2_settings WHERE key='runtime_profile'"))?.value.mode!=='staging')fail(409,'First-administrator setup is restricted to the clean staging profile.');
    if((await one(tx,'SELECT count(*)::integer AS n FROM team_users')).n!==0||await one(tx,"SELECT 1 FROM phase2_settings WHERE key='administrator_initialised'"))fail(409,'Initial administrator already exists. Use authenticated user management; no reset was performed.');
    const id=randomUUID();await tx.query("INSERT INTO team_users(id,email,name,password_hash,role) VALUES($1,$2,$3,$4,'admin')",[id,email.trim().toLowerCase(),name.trim(),password_hash]);
    for(const service of ['home','commercial','shop','concierge'])await tx.query('INSERT INTO commission_rules(service,basis_points,approved) VALUES($1,0,false) ON CONFLICT(service) DO NOTHING',[service]);
    await tx.query("INSERT INTO phase2_settings(key,value) VALUES('administrator_initialised',$1)",[JSON.stringify({id,created_at:new Date().toISOString(),mfa_required:true})]);await audit(tx,id,'security.initial-administrator',id,{mfa_required:true});return{id,mfa_required:true};
  });
}
