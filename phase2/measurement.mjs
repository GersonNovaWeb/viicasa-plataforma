import {randomUUID} from 'node:crypto';
import {hash,token,fail} from '../viicasa-backend/src/lib.js';
import * as s from '../viicasa-backend/src/schemas.js';
import {audit,cookieValue} from './api.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
export const measurementDefaults={journal_enabled:false,retention_days:30,revision:0};
export async function measurementState(db){
  const rows=(await db.query("SELECT key,value FROM phase2_settings WHERE key IN ('measurement','approval:privacy','external_analytics')")).rows;
  const policy=rows.find(r=>r.key==='approval:privacy')?.value||{approved:false,revision:0};
  const external=rows.find(r=>r.key==='external_analytics')?.value||{approved:false,revision:0};
  return{settings:{...measurementDefaults,...rows.find(r=>r.key==='measurement')?.value},policy_approved:policy.approved===true,policy_version:'phase2-privacy-'+(policy.revision||0)+(external.approved?'-external-'+external.revision:''),external_enabled:external.approved===true};
}
async function validConsent(db,id,state){
  if(!state.settings.journal_enabled||!state.policy_approved||!id)return null;
  return one(db,'SELECT id FROM measurement_consents WHERE id=$1 AND statistics AND revoked_at IS NULL AND expires_at>now() AND policy_version=$2',[id,state.policy_version]);
}
export async function consentCookie(db,r,state,{ignoreGpc=false}={}){
  if(!ignoreGpc&&r.headers['sec-gpc']==='1')return null;
  const secret=cookieValue(r,'vc2_privacy');if(!/^[A-Za-z0-9_-]{43}$/.test(secret))return null;
  return one(db,'SELECT * FROM measurement_consents WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now() AND policy_version=$2',[hash(secret),state.policy_version]);
}
export async function recordMeasurement(db,{consentId,key,name,section,source='server',params={}}){
  if(!['page_view','generate_lead','begin_checkout','purchase'].includes(name)||!['home','account','viilife','viishop','viiconcierge'].includes(section)||!['browser','server'].includes(source)||source==='browser'&&name!=='page_view')throw Error('Invalid measurement contract.');
  if(Object.keys(params).some(k=>!['amount_minor','currency'].includes(k))||params.amount_minor!==undefined&&(!Number.isSafeInteger(params.amount_minor)||params.amount_minor<0||params.currency!=='CAD')||params.currency!==undefined&&params.currency!=='CAD')throw Error('Invalid measurement parameters.');
  return db.transaction(async tx=>{
    const state=await measurementState(tx),consent=await validConsent(tx,consentId,state);if(!consent)return{recorded:false};
    // Serialise consent updates/revocation against writes. No contact fields,
    // request URL, IP, device fingerprint or customer account ID are stored here.
    const locked=await one(tx,'SELECT id FROM measurement_consents WHERE id=$1 AND revoked_at IS NULL FOR UPDATE',[consentId]);if(!locked)return{recorded:false};
    const result=await tx.query('INSERT INTO measurement_events(id,event_key,consent_id,name,section,source,params) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_key) DO NOTHING RETURNING id',[randomUUID(),hash(name+':'+key),consentId,name,section,source,JSON.stringify(params)]);
    return{recorded:result.rows.length===1};
  });
}
export async function recordPaidMeasurement(db,{reference,section,amountMinor}){
  const link=await one(db,'SELECT consent_id FROM measurement_links WHERE reference_hash=$1',[hash(reference)]);
  if(!link)return{recorded:false};
  return recordMeasurement(db,{consentId:link.consent_id,key:reference,name:'purchase',section,params:{amount_minor:amountMinor,currency:'CAD'}});
}
export async function recordPlatformPaidMeasurement(db,store,id){
  const checkout=await store.get('checkouts',id),payment=await store.get('payments',id);
  if(checkout?.status!=='confirmed'||payment?.status!=='paid'||payment.currency!=='CAD')return{recorded:false};
  const section={order:'viishop',booking:'viiconcierge',cleaning:'viilife'}[checkout.kind];if(!section)return{recorded:false};
  return recordPaidMeasurement(db,{reference:'platform:'+id,section,amountMinor:Number(payment.amount_minor)});
}
async function bindMeasurementLink(db,{reference,consentId,section}){
  return db.transaction(async tx=>{
    const state=await measurementState(tx);
    const consent=await one(tx,'SELECT id FROM measurement_consents WHERE id=$1 AND statistics AND revoked_at IS NULL AND expires_at>now() AND policy_version=$2 FOR UPDATE',[consentId,state.policy_version]);
    if(!state.settings.journal_enabled||!state.policy_approved||!consent)return;
    await tx.query('INSERT INTO measurement_links(reference_hash,consent_id,section) VALUES($1,$2,$3) ON CONFLICT(reference_hash) DO NOTHING',[hash(reference),consentId,section]);
  });
}
export async function cleanupMeasurement(db){
  const state=await measurementState(db);
  await db.query("DELETE FROM measurement_events WHERE created_at<now()-($1*interval '1 day')",[state.settings.retention_days]);
  await db.query('DELETE FROM measurement_consents WHERE expires_at<=now()');
}
export function registerMeasurement(app,{db,store,origin,adminGuard}){
  const secure=origin.startsWith('https:'),cookie=secret=>`vc2_privacy=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=15552000${secure?'; Secure':''}`;
  app.addHook('onRequest',async r=>{if((r.url.startsWith('/api/privacy/')||r.url.startsWith('/api/measurement/'))&&r.method!=='GET'&&r.headers.origin!==origin)fail(403,'Request origin is not allowed.');});
  const status=async r=>{const state=await measurementState(db),current=await consentCookie(db,r,state,{ignoreGpc:true}),gpc=r.headers['sec-gpc']==='1';return{necessary:true,statistics:!gpc&&Boolean(current?.statistics),marketing:!gpc&&Boolean(current?.marketing),chosen:Boolean(current),requires_gpc_reset:gpc&&Boolean(current?.statistics||current?.marketing),policy_version:state.policy_version,policy_approved:state.policy_approved,journal_enabled:state.settings.journal_enabled,external_enabled:state.external_enabled,gpc};};
  app.get('/api/privacy/preferences',async(r,reply)=>{reply.header('Cache-Control','private, no-store');return status(r);});
  app.put('/api/privacy/preferences',{schema:{body:s.object({statistics:s.bool,marketing:s.bool,policy_version:s.str(100)})},config:{rateLimit:{max:20,timeWindow:'5 minutes'}}},async(r,reply)=>{
    const state=await measurementState(db);if(r.body.policy_version!==state.policy_version)fail(409,'Privacy notice changed. Reload your preferences.');
    const old=cookieValue(r,'vc2_privacy'),secret=token(),id=randomUUID();
    const allowed=state.policy_approved&&r.headers['sec-gpc']!=='1';
    await db.transaction(async tx=>{
      const prior=await one(tx,'SELECT id FROM measurement_consents WHERE token_hash=$1 FOR UPDATE',[hash(old)]);
      if(prior){await tx.query('UPDATE measurement_consents SET revoked_at=now() WHERE id=$1',[prior.id]);await tx.query('DELETE FROM measurement_events WHERE consent_id=$1',[prior.id]);await tx.query('DELETE FROM measurement_links WHERE consent_id=$1',[prior.id]);}
      await tx.query("INSERT INTO measurement_consents(id,token_hash,policy_version,statistics,marketing,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '180 days')",[id,hash(secret),state.policy_version,allowed&&r.body.statistics,allowed&&r.body.marketing]);
    });reply.header('Set-Cookie',cookie(secret)).header('Cache-Control','private, no-store');return{necessary:true,statistics:allowed&&r.body.statistics,marketing:allowed&&r.body.marketing,chosen:true,policy_version:state.policy_version,policy_approved:state.policy_approved,journal_enabled:state.settings.journal_enabled,external_enabled:state.external_enabled,gpc:r.headers['sec-gpc']==='1'};
  });
  app.post('/api/measurement/events',{schema:{body:s.object({event_id:s.uuid,name:{const:'page_view'},section:s.choice(['home','account','viilife','viishop','viiconcierge'])})},config:{rateLimit:{max:40,timeWindow:'1 minute'}}},async(r,reply)=>{
    const state=await measurementState(db),consent=await consentCookie(db,r,state);reply.header('Cache-Control','no-store');return recordMeasurement(db,{consentId:consent?.id,key:r.body.event_id,name:'page_view',section:r.body.section,source:'browser'});
  });
  app.get('/api/commercial/measurement',{preHandler:adminGuard},async(r,reply)=>{
    reply.header('Cache-Control','private, no-store');const state=await measurementState(db);
    return{...state,summary:(await db.query('SELECT name,section,count(*)::integer AS count FROM measurement_events GROUP BY name,section ORDER BY name,section')).rows,events:(await db.query('SELECT id,name,section,source,params,created_at FROM measurement_events ORDER BY created_at DESC LIMIT 100')).rows};
  });
  app.put('/api/commercial/measurement/settings',{preHandler:adminGuard,schema:{body:s.object({journal_enabled:s.bool,retention_days:s.int(1,90),revision:s.int(0)})}},async r=>db.transaction(async tx=>{
    await tx.query("INSERT INTO phase2_settings(key,value) VALUES('measurement',$1) ON CONFLICT(key) DO NOTHING",[JSON.stringify(measurementDefaults)]);
    const old=(await tx.query("SELECT value FROM phase2_settings WHERE key='measurement' FOR UPDATE")).rows[0].value,state=await measurementState(tx);
    if(old.revision!==r.body.revision)fail(409,'Settings changed. Reload before saving.');if(r.body.journal_enabled&&!state.policy_approved)fail(409,'Record approval of the privacy notice before enabling measurement.');
    const saved={...r.body,revision:old.revision+1};await tx.query("UPDATE phase2_settings SET value=$1,updated_at=now() WHERE key='measurement'",[JSON.stringify(saved)]);await audit(tx,r.teamUser.id,'measurement.settings','local-journal',saved);return saved;
  }));
  // Attribution only from successful server responses. Never instrument passwords,
  // admin screens, free-text fields, page query strings or payment-return URLs.
  app.addHook('onSend',async(r,reply,payload)=>{
    if(r.method!=='POST'||reply.statusCode<200||reply.statusCode>=300)return payload;
    const path=r.url.split('?')[0];
    const form=path==='/api/client/requests'||path==='/api/inquiries';
    const invoice=/^\/api\/client\/invoices\/([a-f0-9-]{36})\/payment$/.exec(path);
    const channel=path==='/api/client/shop-channel/checkouts';
    const platform=path==='/api/orders'||path==='/api/bookings';
    const channelPaid=/^\/api\/commercial\/shop-channel\/checkouts\/([a-f0-9-]{36})\/simulate-paid$/.exec(path);
    const platformPaid=/^\/api\/admin\/payments\/([a-f0-9-]{36})\/simulate$/.exec(path);
    if(!form&&!invoice&&!channel&&!channelPaid&&!platform&&!platformPaid)return payload;
    try{
      if(channelPaid){const paid=await one(db,"SELECT total_minor FROM channel_checkouts WHERE id=$1 AND status='paid'",[channelPaid[1]]);if(paid)await recordPaidMeasurement(db,{reference:'channel:'+channelPaid[1],section:'viishop',amountMinor:Number(paid.total_minor)});return payload;}
      if(platformPaid){await recordPlatformPaidMeasurement(db,store,platformPaid[1]);return payload;}
      const state=await measurementState(db),consent=await consentCookie(db,r,state);if(!await validConsent(db,consent?.id,state))return payload;
      const data=JSON.parse(String(payload));if(form&&data.id)await recordMeasurement(db,{consentId:consent.id,key:'request:'+data.id,name:'generate_lead',section:path==='/api/client/requests'?'viilife':'viiconcierge'});
      const reference=invoice?'invoice:'+invoice[1]:(channel||platform)&&data.id?(platform?'platform:':'channel:')+data.id:null;
      const section=invoice?'viilife':path==='/api/bookings'?'viiconcierge':'viishop';
      if(reference){await bindMeasurementLink(db,{reference,consentId:consent.id,section});await recordMeasurement(db,{consentId:consent.id,key:reference,name:'begin_checkout',section});}
    }catch{/* Analytics must not block a completed enquiry or payment operation. */}
    return payload;
  });
}
