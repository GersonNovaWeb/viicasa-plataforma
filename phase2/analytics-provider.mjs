import {createHash} from 'node:crypto';
import {fail} from '../viicasa-backend/src/lib.js';
import * as s from '../viicasa-backend/src/schemas.js';
import {providerJson} from './provider-http.mjs';
import {measurementState,consentCookie} from './measurement.mjs';
import {audit} from './api.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const sha=value=>createHash('sha256').update(value).digest('hex');
export function analyticsGateway(env,{fetcher=fetch,origin='https://demo.example.invalid'}={}){
  const ga4=env.PHASE2_GA4_ENABLED==='true',meta=env.PHASE2_META_ENABLED==='true',gtm=env.PHASE2_GTM_ENABLED==='true';
  if(gtm&&(ga4||meta))throw Error('Choose browser GTM or direct server analytics to avoid duplicate sources.');
  if(ga4&&(!/^G-[A-Z0-9]+$/.test(env.PHASE2_GA4_MEASUREMENT_ID||'')||!env.PHASE2_GA4_API_SECRET))throw Error('GA4 requires its ID and server-only API secret.');
  if(meta&&(!/^\d{5,30}$/.test(env.PHASE2_META_PIXEL_ID||'')||!/^v\d{1,2}\.\d+$/.test(env.PHASE2_META_GRAPH_VERSION||'')||!env.PHASE2_META_ACCESS_TOKEN||!env.PHASE2_META_TEST_EVENT_CODE))throw Error('Meta requires an approved API version, pixel, token and Test Events code in this copy.');
  if(gtm&&(!/^GTM-[A-Z0-9]+$/.test(env.PHASE2_GTM_CONTAINER_ID||'')||env.PHASE2_GTM_CONTAINER_APPROVED!=='true'))throw Error('GTM needs an audited container and explicit approval.');
  return{providers:[...(ga4?['ga4']:[]),...(meta?['meta']:[])],gtm:gtm?env.PHASE2_GTM_CONTAINER_ID:null,
    send:async(provider,e)=>{const digest=sha(e.consent_id),value=e.params.amount_minor===undefined?undefined:e.params.amount_minor/100;
      if(provider==='ga4'&&ga4){const params={section:e.section,event_id:e.id,...(value===undefined?{}:{value,currency:'CAD',transaction_id:e.name==='purchase'?e.event_key:undefined})};const body={client_id:(parseInt(digest.slice(0,8),16)||1)+'.'+(parseInt(digest.slice(8,16),16)||1),timestamp_micros:String(new Date(e.created_at).getTime()*1000),consent:{ad_user_data:'DENIED',ad_personalization:'DENIED'},events:[{name:e.name,params}]},query=new URLSearchParams({measurement_id:env.PHASE2_GA4_MEASUREMENT_ID,api_secret:env.PHASE2_GA4_API_SECRET});
        const validation=await providerJson('https://www.google-analytics.com/debug/mp/collect?'+query,{fetcher,method:'POST',body});if(validation.validationMessages?.length)fail(409,'GA4 rejected the event contract.');
        let response;try{response=await fetcher('https://www.google-analytics.com/mp/collect?'+query,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});}catch{fail(503,'Analytics delivery is unconfirmed.');}if(!response.ok)fail(502,'GA4 rejected delivery.');return{accepted:true,independently_verified:false};}
      if(provider==='meta'&&meta){const names={page_view:'PageView',generate_lead:'Lead',begin_checkout:'InitiateCheckout',purchase:'Purchase'},paths={home:'/',viilife:'/viilife',viishop:'/shop',viiconcierge:'/viiconcierge'};
        const response=await providerJson(`https://graph.facebook.com/${env.PHASE2_META_GRAPH_VERSION}/${env.PHASE2_META_PIXEL_ID}/events`,{fetcher,method:'POST',headers:{authorization:'Bearer '+env.PHASE2_META_ACCESS_TOKEN},body:{test_event_code:env.PHASE2_META_TEST_EVENT_CODE,data:[{event_name:names[e.name],event_time:Math.floor(new Date(e.created_at).getTime()/1000),event_id:e.id,action_source:'website',event_source_url:new URL(paths[e.section]||'/',origin).href,user_data:{external_id:[digest]},custom_data:{section:e.section,...(value===undefined?{}:{value,currency:'CAD'})}}]}});if(response.events_received!==1)fail(502,'Meta did not accept this event.');return{accepted:true,test_events:true,independently_verified:false};}
      fail(409,'Analytics provider is disabled.');}
  };
}
export function registerExternalAnalytics(app,{db,adminGuard,gateway}){
  const settings=async()=>({revision:0,approved:false,note:'',...(await one(db,"SELECT value FROM phase2_settings WHERE key='external_analytics'"))?.value});
  app.get('/api/commercial/analytics/settings',{preHandler:adminGuard},async(r,reply)=>{reply.header('Cache-Control','private, no-store');return settings();});
  app.put('/api/commercial/analytics/settings',{preHandler:adminGuard,schema:{body:s.object({revision:s.int(0),approved:s.bool,note:s.str(2000,3)})}},r=>db.transaction(async tx=>{
    await tx.query("INSERT INTO phase2_settings(key,value) VALUES('external_analytics','{\"revision\":0,\"approved\":false}') ON CONFLICT DO NOTHING");const old=(await one(tx,"SELECT value FROM phase2_settings WHERE key='external_analytics' FOR UPDATE")).value;if(old.revision!==r.body.revision)fail(409,'External analytics approval changed.');if(r.body.approved&&!(await measurementState(tx)).policy_approved)fail(409,'Approve the privacy notice before approving external data sharing.');if(r.body.note.trim().length<3)fail(400,'Enter the separate data-sharing approval reference.');const value={...r.body,note:r.body.note.trim(),revision:old.revision+1};await tx.query("UPDATE phase2_settings SET value=$1 WHERE key='external_analytics'",[JSON.stringify(value)]);await audit(tx,r.teamUser.id,'analytics.sharing-policy','external_analytics',value);return{ok:true};
  }));
  app.get('/api/commercial/analytics/delivery',{preHandler:adminGuard},async(r,reply)=>{reply.header('Cache-Control','private, no-store');return{providers:gateway.providers,gtm:gateway.gtm,rows:(await db.query('SELECT provider,status,count(*)::integer AS count FROM analytics_deliveries GROUP BY provider,status')).rows,independently_verified:false};});
  app.post('/api/commercial/analytics/process',{preHandler:adminGuard,schema:{body:s.object({confirmed:{const:true}})}},async r=>{await audit(db,r.teamUser.id,'analytics.process','external',{providers:gateway.providers});return process();});
  app.get('/api/analytics/bootstrap',async(r,reply)=>{reply.header('Cache-Control','private, no-store');const state=await measurementState(db),consent=await consentCookie(db,r,state);return{gtm:state.external_enabled&&state.policy_approved&&state.settings.journal_enabled&&consent?.statistics&&consent?.marketing?gateway.gtm:null,external_available:gateway.providers.length>0||Boolean(gateway.gtm)};});
  async function process(){let accepted=0;if(!gateway.providers.length)return{disabled:true,accepted};
    for(const provider of gateway.providers){const state=await measurementState(db);if(!state.external_enabled||!state.policy_approved||!state.settings.journal_enabled)continue;
      const events=(await db.query(`SELECT e.* FROM measurement_events e JOIN measurement_consents c ON c.id=e.consent_id
        WHERE c.statistics AND c.revoked_at IS NULL AND c.expires_at>now() AND c.policy_version=$1 AND e.section<>'account'
        AND ($2='ga4' OR c.marketing) AND NOT EXISTS(SELECT 1 FROM analytics_deliveries d WHERE d.event_id=e.id AND d.provider=$2)
        ORDER BY e.created_at LIMIT 20`,[state.policy_version,provider])).rows;
      for(const e of events){const claimed=await db.transaction(async tx=>{const current=await measurementState(tx),c=await one(tx,'SELECT * FROM measurement_consents WHERE id=$1 FOR UPDATE',[e.consent_id]);if(!current.external_enabled||!current.policy_approved||!current.settings.journal_enabled||!c||!c.statistics||provider==='meta'&&!c.marketing||c.revoked_at||new Date(c.expires_at)<=new Date()||c.policy_version!==current.policy_version)return false;
        if(Date.now()-new Date(e.created_at).getTime()>48*3600000){await tx.query("INSERT INTO analytics_deliveries(event_id,provider,status) VALUES($1,$2,'expired') ON CONFLICT DO NOTHING",[e.id,provider]);return false;}
        const inserted=await tx.query("INSERT INTO analytics_deliveries(event_id,provider,status) VALUES($1,$2,'sending') ON CONFLICT DO NOTHING RETURNING event_id",[e.id,provider]);return inserted.rows.length>0;});if(!claimed)continue;
        try{const result=await gateway.send(provider,e);await db.query("UPDATE analytics_deliveries SET status='accepted',result=$3,updated_at=now() WHERE event_id=$1 AND provider=$2",[e.id,provider,JSON.stringify(result)]);accepted++;}catch(error){await db.query("UPDATE analytics_deliveries SET status=$3,result=$4,updated_at=now() WHERE event_id=$1 AND provider=$2",[e.id,provider,error.statusCode===409?'failed':'unknown',JSON.stringify({error:'Delivery not confirmed. No automatic resend will be made.'})]);}
      }
    }return{accepted,independently_verified:false};
  }
  return{process};
}
