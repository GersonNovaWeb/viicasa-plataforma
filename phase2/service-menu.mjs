import {fail} from '../viicasa-backend/src/lib.js';
import {weeklyDays} from './weekly-schedule.mjs';

// Internal reference only. Values reproduce client-supplied price cards, not
// approved retail prices. The demo uses CAD pending confirmation of the currency.
export const serviceMenu=[
  ['home-deep','home','Deep clean','project',30000,70000,false],
  ['home-move','home','Move-in / move-out clean','project',35000,85000,false],
  ['home-carpet','home','Carpet & upholstery','room',7500,25000,false],
  ['home-staging','home','Welcome staging','project',15000,40000,false],
  ['home-closet','home','Closet revamp','project',12000,35000,false],
  ['home-grocery','home','Grocery & pantry stocking','project',4000,9000,false],
  ['home-standard','home','Standard recurring clean','visit',11000,22000,false],
  ['home-check','home','House check','visit',3500,6500,false],
  ['home-laundry','home','Laundering','load',2500,6000,false],
  ['home-pet','home','Pet check','visit',2000,3500,false],
  ['home-maintenance','home','Property maintenance','hour',6000,10000,true],
  ['home-window','home','Window cleaning','pane',600,1000,true],
  ['home-pressure','home','Pressure washing','project',15000,40000,true],
  ['home-snow','home','Snow removal / de-icing','call',5000,12000,true],
  ['commercial-team','commercial','Two-person janitorial team','hour',6500,9500,false],
  // Negotiated by the team per complete weekly package, not a reference tariff.
  ['commercial-fixed-weekly','commercial','Negotiated weekly package','weekly_package',1,99999999,false],
  ['commercial-janitorial','commercial','Recurring janitorial','sqft_visit',5,12,false],
  ['commercial-deep','commercial','Deep clean','project',35000,80000,false],
  ['commercial-turnover','commercial','Unit turnover clean','project',35000,85000,false],
  ['commercial-construction','commercial','Post-construction clean-up','sqft',25,55,false],
  ['commercial-carpet','commercial','Carpet & upholstery','sqft',25,40,false],
  ['commercial-floor','commercial','Floor care (strip, seal & wax)','sqft',60,90,false],
  ['commercial-laundry','commercial','Laundering','load',2500,6000,false],
  ['commercial-maintenance','commercial','Property maintenance','hour',6000,10000,true],
  ['commercial-window','commercial','Window cleaning','pane',400,800,true],
  ['commercial-pressure','commercial','Pressure washing','project',15000,45000,true],
  ['commercial-snow','commercial','Snow removal / de-icing','call',8000,20000,true],
].map(([id,segment,name,basis,low_minor,high_minor,subcontracted])=>({id,segment,name,basis,low_minor,high_minor,subcontracted,currency:'CAD',team_size:2,internal:true}));

export function quoteService(input){
  const service=serviceMenu.find(s=>s.id===input.service_id);if(!service)fail(400,'Unknown service.');
  const integer=(v,min,max,label)=>{if(!Number.isSafeInteger(v)||v<min||v>max)fail(400,'Invalid '+label);return v;};
  const rate=integer(input.rate_minor,service.low_minor,service.high_minor,'reference rate');
  const visits=integer(input.visits,1,100,'visits'),quantity=integer(input.quantity,1,1000000,'quantity');
  if(service.basis==='visit'&&quantity!==1)fail(400,'Per-visit services use one service unit per visit.');
  if(service.basis==='project'&&(quantity!==1||visits!==1))fail(400,'Project fees describe one fixed-scope job.');
  const frequency=input.frequency||'once',term=input.term||'month_to_month';
  if(!['once','daily','weekly','biweekly','monthly'].includes(frequency)||!['month_to_month','annual'].includes(term))fail(400,'Invalid frequency or term.');
  if(service.basis==='weekly_package'&&(quantity!==1||frequency!=='weekly'||!input.properties?.length))fail(400,'A weekly package requires one negotiated package, weekly frequency and a property schedule.');
  const days=weeklyDays(input.weekly_days,service.basis);
  if(service.segment==='home'&&(frequency==='daily'||term==='annual'))fail(400,'Home recurring services are month-to-month.');
  const recurring=['home-standard','home-check','home-laundry','home-pet','commercial-team','commercial-janitorial','commercial-laundry','commercial-fixed-weekly'].includes(service.id);
  if(!recurring&&(frequency!=='once'||term==='annual'))fail(400,'This service is one-time or as-needed.');
  const properties=input.properties||[];
  if(properties.length>30||properties.some(p=>typeof p.address!=='string'||p.address.trim().length<3||p.address.length>300||!Number.isInteger(p.sqft)||p.sqft<1||p.sqft>1000000))fail(400,'Invalid property schedule.');
  if(properties.length*visits*(days.length||1)>300)fail(400,'Split the package into at most 300 execution visits.');
  if(['sqft','sqft_visit'].includes(service.basis)&&properties.length&&quantity!==properties.reduce((n,p)=>n+p.sqft,0))fail(400,'Square footage must match the property schedule.');
  const subtotal=rate*quantity*visits;if(!Number.isSafeInteger(subtotal)||subtotal>99999999)fail(400,'Estimate exceeds supported amount.');
  const eligible=service.segment==='commercial'&&recurring&&term==='annual'&&['daily','weekly'].includes(frequency);
  const discount=eligible?Number((BigInt(subtotal)*3000n+5000n)/10000n):0;
  return {service_id:service.id,service:service.name,currency:'CAD',basis:service.basis,rate_minor:rate,quantity,visits,subtotal_minor:subtotal,intro_discount_minor:discount,total_minor:subtotal-discount,
    frequency,term,team_size:2,subcontracted:service.subcontracted,estimate:true,properties,...(days.length?{weekly_days:days,execution_visits:visits*days.length*properties.length,weekly_block_definition:'Seven calendar days from the first selected service date.'}:{}),
    discount_months:eligible?3:0,payment_terms:service.segment==='commercial'?'Monthly consolidated invoice; Net 15.':'One-time/as-needed: due on completion. Recurring: pre-authorised payment per visit.',
    cancellation_notice_hours:24,recurring_notice_days:service.segment==='home'?14:null,
    exclusions:['Taxes and travel/supply fees are not yet configured.','Grocery items and additional storey/access surcharges are excluded.'],
    notes:eligible?'First three months only. Early termination requires repayment of the discount actually received.':'Internal estimate; scope and final price need approval.'};
}
export function cancellationRepayment(discountActuallyReceived){
  if(!Array.isArray(discountActuallyReceived)||discountActuallyReceived.some(n=>!Number.isSafeInteger(n)||n<0))fail(400,'Invalid discount ledger.');
  return discountActuallyReceived.reduce((sum,n)=>sum+n,0);
}
