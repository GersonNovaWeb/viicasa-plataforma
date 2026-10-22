import {fail} from '../viicasa-backend/src/lib.js';
import * as s from '../viicasa-backend/src/schemas.js';
import {audit} from './api.mjs';
import {serviceMenu} from './service-menu.mjs';
import {emptyPricing,configuredQuote} from './pricing-calculation.mjs';

const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const nullable=schema=>({anyOf:[schema,{type:'null'}]});
const id={type:'string',maxLength:60,pattern:'^[a-z][a-z0-9-]*$'};
export const quoteExtras=s.array(s.object({id,quantity:s.int(1,1000)}),20);
export async function pricingPolicy(db,segment){return(await one(db,'SELECT value FROM phase2_settings WHERE key=$1',['pricing:'+segment]))?.value||emptyPricing(segment);}
export async function priceConfiguredQuote(db,input){
  await db.query('SELECT pg_advisory_xact_lock(73182009)');
  const service=serviceMenu.find(s=>s.id===input.service_id);if(!service)fail(400,'Unknown service.');
  return configuredQuote(input,await pricingPolicy(db,service.segment));
}
export async function verifyQuotePricing(db,quote){
  if(!quote.result.pricing)return; // Existing demo quotes retain their original conditions.
  await db.query('SELECT pg_advisory_xact_lock(73182009)');
  const p=await pricingPolicy(db,quote.result.pricing.segment);
  if(p.revision!==quote.result.pricing.policy_revision)fail(409,'Pricing changed. Edit and recalculate this draft before approval.');
}
export function registerPricing(app,{db,userGuard,adminGuard}){
  app.get('/api/commercial/pricing',{preHandler:userGuard},async()=>({items:await Promise.all(['home','commercial'].map(x=>pricingPolicy(db,x)))}));
  const body=s.object({revision:s.int(0),approved:s.bool,min_visit_minor:nullable(s.int(0,99999999)),
    taxes:nullable(s.array(s.object({id,label:s.str(120,2),basis_points:s.int(0,10000)}),5)),
    extras:s.array(s.object({id,label:s.str(120,2),basis:s.choice(['visit','schedule']),amount_minor:s.int(0,9999999),taxable:s.bool}),20),note:s.str(3000,3)});
  app.put('/api/commercial/pricing/:segment',{schema:{body},preHandler:adminGuard},r=>db.transaction(async tx=>{
    const segment=r.params.segment;if(!['home','commercial'].includes(segment))fail(404,'Pricing segment not found.');
    if(new Set(r.body.extras.map(e=>e.id)).size!==r.body.extras.length||new Set((r.body.taxes||[]).map(t=>t.id)).size!==(r.body.taxes||[]).length)fail(400,'Pricing identifiers must be unique.');
    if((r.body.taxes||[]).reduce((n,t)=>n+t.basis_points,0)>10000)fail(400,'Combined demo tax rates cannot exceed 100%.');
    await tx.query('SELECT pg_advisory_xact_lock(73182009)');
    const old=await pricingPolicy(tx,segment);if(old.revision!==r.body.revision)fail(409,'Pricing configuration changed. Refresh before saving.');
    const value={...r.body,segment,revision:old.revision+1,currency:'CAD',reviewed_by:r.teamUser.id,reviewed_at:new Date().toISOString()};
    await tx.query('INSERT INTO phase2_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()',['pricing:'+segment,JSON.stringify(value)]);
    await tx.query('INSERT INTO pricing_policy_versions(segment,revision,value,actor_id) VALUES($1,$2,$3,$4)',[segment,value.revision,JSON.stringify(value),r.teamUser.id]);
    await audit(tx,r.teamUser.id,'pricing.configure',segment,{revision:value.revision,approved:value.approved});return value;
  }));
}
