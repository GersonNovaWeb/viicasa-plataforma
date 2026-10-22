import * as s from '../viicasa-backend/src/schemas.js';
import {fail} from '../viicasa-backend/src/lib.js';
import {audit} from './api.mjs';

// Environment names below are VII's interface, not claims about provider APIs.
export const connectionRequirements={
  lodgify:{variables:['PHASE2_LODGIFY_API_KEY'],capabilities:['reservations','availability','stay_notifications']},
  airbnb:{variables:['PHASE2_AIRBNB_ACCESS_TOKEN'],capabilities:['authorised_channel_sync']},
  shopify:{variables:['PHASE2_SHOPIFY_STORE','PHASE2_SHOPIFY_LOCATION_ID','PHASE2_SHOPIFY_ACCESS_TOKEN','PHASE2_SHOPIFY_WEBHOOK_SECRET','PHASE2_SHOPIFY_STOREFRONT_TOKEN'],capabilities:['catalogue','inventory','external_checkout']},
  meta:{variables:['PHASE2_META_PIXEL_ID','PHASE2_META_ACCESS_TOKEN','PHASE2_META_GRAPH_VERSION','PHASE2_META_TEST_EVENT_CODE'],capabilities:['consented_conversion_events']},
  ga4:{variables:['PHASE2_GA4_MEASUREMENT_ID','PHASE2_GA4_API_SECRET'],capabilities:['consented_analytics']},
  gtm:{variables:['PHASE2_GTM_CONTAINER_ID'],capabilities:['consented_tag_management']},
  google:{variables:['PHASE2_GOOGLE_CLIENT_ID','PHASE2_GOOGLE_CLIENT_SECRET'],capabilities:['customer_identity']},
  apple:{variables:['PHASE2_APPLE_SERVICE_ID','PHASE2_APPLE_TEAM_ID','PHASE2_APPLE_KEY_ID','PHASE2_APPLE_PRIVATE_KEY'],capabilities:['customer_identity']},
};
export const approvalKeys=['prices','taxes','commissions','agreements','payment_schedule','cancellation_policy','recurring_payments','refunds','privacy','production_database','backups','deployment'];
export async function registerReadiness(app,{db,adminGuard,config,connectionEnvironment,databaseDriver='pglite',identityStatus={},providerStatus={}}){
  const route=(method,url,body,handler)=>app.route({method,url:'/api/commercial'+url,...(body?{schema:{body}}:{}),preHandler:adminGuard,handler});
  route('GET','/setup',null,async()=>{
    const saved=(await db.query("SELECT * FROM phase2_settings WHERE key LIKE 'approval:%' OR key LIKE 'connection:%'")).rows;
    const approvals=approvalKeys.map(id=>({id,...(saved.find(r=>r.key==='approval:'+id)?.value||{approved:false,note:'',revision:0})}));
    const connections=Object.entries(connectionRequirements).map(([provider,requirements])=>{
      const value=saved.find(r=>r.key==='connection:'+provider)?.value||{account_reference:'',mappings:[],revision:0};
      const variables=requirements.variables.map(name=>({name,present:Boolean(connectionEnvironment[name])}));
      const adapter=identityStatus[provider]||providerStatus[provider];return{provider,variables,capabilities:requirements.capabilities,configuration:value,status:adapter?(adapter.enabled?'configured_not_verified':'disabled'):variables.every(v=>v.present)?'configuration_only':'requires_access',adapter_implemented:Boolean(adapter),enabled:adapter?.enabled||false,disabled_reason:adapter?.reason||null,verified:false};
    });
    return{mode:config.runtimeMode||'demo',approved_for_production:false,currency:'CAD',database:{driver:databaseDriver,remote:databaseDriver==='postgres',validated_for_production:false},mail:{mode:config.mailMode,configured:config.mailMode==='smtp'},payments:{provider:config.paymentProvider,mode:'test',webhook_configured:Boolean(config.stripeWebhookSecret)},approvals,connections};
  });
  route('PUT','/setup/approvals/:id',s.object({approved:s.bool,note:s.str(3000,3),revision:s.int(0)}),async r=>{
    if(!approvalKeys.includes(r.params.id))fail(404,'Approval not found.');return save(r,'approval:'+r.params.id,{approved:r.body.approved,note:r.body.note});
  });
  route('PUT','/setup/connections/:provider',s.object({account_reference:s.str(160,0),mappings:s.array(s.object({external_id:s.str(160,1),local_id:s.str(160,1),kind:s.choice(['property','product','variant','event'])}),100),revision:s.int(0)}),async r=>{
    if(!connectionRequirements[r.params.provider])fail(404,'Provider not supported.');
    if(new Set(r.body.mappings.map(m=>m.kind+':'+m.external_id)).size!==r.body.mappings.length)fail(400,'External mappings must be unique per type.');
    return save(r,'connection:'+r.params.provider,{account_reference:r.body.account_reference,mappings:r.body.mappings});
  });
  async function save(r,key,value){return db.transaction(async tx=>{
    // Ensure first-time saves lock the same row too; stale versions never overwrite.
    await tx.query('INSERT INTO phase2_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING',[key,JSON.stringify({revision:0})]);
    const old=(await tx.query('SELECT value FROM phase2_settings WHERE key=$1 FOR UPDATE',[key])).rows[0].value;
    if(old.revision!==r.body.revision)fail(409,'Configuration changed. Refresh before saving.');
    const current={...value,revision:old.revision+1,reviewed_by:r.teamUser.id,reviewed_at:new Date().toISOString()};
    await tx.query('UPDATE phase2_settings SET value=$2,updated_at=now() WHERE key=$1',[key,JSON.stringify(current)]);await audit(tx,r.teamUser.id,'setup.review',key,{revision:current.revision});return current;
  });}
}
