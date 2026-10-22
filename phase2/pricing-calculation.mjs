import {fail} from '../viicasa-backend/src/lib.js';
import {quoteService} from './service-menu.mjs';
import {allocateMinor} from './agreement-content.mjs';
import {executionCount,scheduleAmounts} from './weekly-schedule.mjs';

export const emptyPricing=segment=>({segment,revision:0,approved:false,min_visit_minor:null,taxes:null,extras:[],note:'',currency:'CAD'});
export function configuredQuote(input,policy){
  const base=quoteService(input),selected=input.extras||[];
  if(input.pricing_revision!==undefined&&input.pricing_revision!==policy.revision)fail(409,'Pricing configuration changed. Refresh before recalculating.');
  if(new Set(selected.map(x=>x.id)).size!==selected.length)fail(400,'An extra cannot be selected twice.');
  if(selected.some(x=>!Number.isSafeInteger(x.quantity)||x.quantity<1||x.quantity>1000))fail(400,'Invalid extra quantity.');
  if(!policy.approved){
    if(selected.length)fail(409,'Extras require an approved pricing configuration.');
    return{...base,pricing:{status:'not_approved',policy_revision:policy.revision,segment:policy.segment},exclusions:[...base.exclusions,'Additional pricing configuration has not been approved.']};
  }
  if(input.pricing_revision!==policy.revision)fail(409,'Pricing configuration changed. Review the current configuration and recalculate.');
  if(policy.segment==='commercial'&&!input.properties?.length)fail(400,'Configured commercial pricing requires the property schedule.');
  const properties=input.properties.length?input.properties:[{sqft:1}],visitsPerProperty=executionCount(base),count=properties.length*visitsPerProperty;
  if(count>300)fail(400,'Split the service schedule into smaller periods.');
  const {weights,bases:services,discounts}=scheduleAmounts(base,properties,allocateMinor);
  const extras=selected.map(x=>{const e=policy.extras.find(e=>e.id===x.id);if(!e)fail(400,'This extra is not in the approved configuration.');return{...e,quantity:x.quantity};});
  const allocations=extras.map(e=>e.basis==='schedule'?allocateMinor(e.amount_minor*e.quantity,weights):Array(count).fill(e.amount_minor*e.quantity));
  const rows=services.map((gross,i)=>{
    const net=gross-discounts[i],minimum=Math.max(0,(policy.min_visit_minor??0)-net);
    const added=extras.map((e,j)=>({id:e.id,label:e.label,basis:e.basis,quantity:e.quantity,amount_minor:allocations[j][i],taxable:e.taxable}));
    const taxable=net+minimum+added.filter(e=>e.taxable).reduce((n,e)=>n+e.amount_minor,0);
    const taxes=(policy.taxes||[]).map(t=>({...t,amount_minor:Number((BigInt(taxable)*BigInt(t.basis_points)+5000n)/10000n)}));
    return{property_index:Math.floor(i/visitsPerProperty),visit_index:i%visitsPerProperty,...(base.weekly_days?.length?{block_index:Math.floor(i%visitsPerProperty/base.weekly_days.length)}:{}),service_minor:net,discount_minor:discounts[i],minimum_minor:minimum,extras:added,taxes,
      extras_minor:added.reduce((n,e)=>n+e.amount_minor,0),tax_minor:taxes.reduce((n,t)=>n+t.amount_minor,0),
      amount_minor:net+minimum+added.reduce((n,e)=>n+e.amount_minor,0)+taxes.reduce((n,t)=>n+t.amount_minor,0)};
  });
  const totals=pricingTotals(rows);
  if(!Number.isSafeInteger(totals.amount_minor)||totals.amount_minor>99999999)fail(400,'Configured quote exceeds the supported amount.');
  return{...base,total_minor:totals.amount_minor,pricing:{status:'applied',policy_revision:policy.revision,segment:policy.segment,currency:'CAD',
    minimum_defined:policy.min_visit_minor!==null,taxes_defined:policy.taxes!==null,policy_snapshot:policy,rows,totals},
    exclusions:['Only selected extras are included. Grocery purchases and access/storey surcharges are excluded unless explicitly quoted.',
      ...(policy.taxes===null?['Taxes are not configured or included.']:[]),...(policy.min_visit_minor===null?['Minimum visit fee is not configured.']:[])],
    notes:base.notes+' Pricing configuration v'+policy.revision+' is frozen for this quote.'};
}

export function pricingTotals(rows){
  const totals={service_minor:0,discount_minor:0,minimum_minor:0,extras_minor:0,tax_minor:0,amount_minor:0};
  for(const row of rows)for(const k of Object.keys(totals))totals[k]+=Number(row[k]||0);
  return totals;
}

export function pricingSummary(pricing){
  if(!pricing?.totals)return[];
  const t=pricing.totals;
  const sum=(kind)=>{
    const values=new Map();for(const row of pricing.rows||[])for(const item of row[kind]||[]){const key=item.id,old=values.get(key)||{label:item.label,amount:0};old.amount+=item.amount_minor;values.set(key,old);}
    return[...values.values()].map(v=>[v.label,v.amount]);
  };
  const extras=sum('extras'),taxes=sum('taxes');
  return[['Service after discount',t.service_minor],['Minimum adjustment',t.minimum_minor],...(extras.length?extras:[['Selected extras',t.extras_minor]]),...(taxes.length?taxes:[['Configured taxes',t.tax_minor]]),['Total',t.amount_minor]];
}
