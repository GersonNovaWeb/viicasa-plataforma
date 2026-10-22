import {demoDataSummary} from './runtime-profile.mjs';
import {launchReadiness} from './launch-readiness.mjs';
export async function inspectRelease(databases,runtime){
  const report=await launchReadiness(databases.commercial,runtime),examples=await demoDataSummary(databases),profile=(await databases.commercial.query("SELECT value FROM phase2_settings WHERE key='runtime_profile'")).rows[0]?.value?.mode||'demo';
  const administrators=(await databases.commercial.query("SELECT id,totp_secret IS NOT NULL AS mfa_configured FROM team_users WHERE role='admin' AND active AND NOT deleted AND email NOT LIKE '%@viicasa.demo.invalid'")).rows;
  const blockers=[...(profile==='staging'?[]:['clean_staging_profile_required']),...Object.entries(examples).filter(([,n])=>n>0).map(([name])=>'demo_data:'+name),...(administrators.some(a=>a.mfa_configured)?[]:['administrator_mfa_required']),...report.items.filter(i=>i.effective_state!=='passed').map(i=>'validation:'+i.id),...report.missing_recorded_approvals.map(id=>'approval:'+id)];
  return{profile,production_enabled:false,activation_supported:false,review_complete:blockers.length===0,fingerprint:report.fingerprint,examples,blockers,source_revision:report.source_revision,independently_verified:false,requires_separate_authorised_promotion:true};
}
export function registerReleaseInspection(app,{databases,adminGuard,runtime}){
  app.get('/api/commercial/release/inspection',{preHandler:adminGuard},async(r,reply)=>{reply.header('Cache-Control','private, no-store');return inspectRelease(databases,runtime);});
}
