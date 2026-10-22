import {hash,fail} from '../viicasa-backend/src/lib.js';
import {expandedWeeklyDates,scheduleAmounts} from './weekly-schedule.mjs';
export const canonical=v=>JSON.stringify(normalise(v));
function normalise(v){if(Array.isArray(v))return v.map(normalise);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,normalise(v[k])]));return v;}
export const snapshotHash=snapshot=>hash(canonical(snapshot));
const common=[
  ['Cancellation & No-Access',"Minimum 24 hours' notice to cancel or reschedule; a late cancellation or no-access on arrival is billed at the full scheduled rate."],
  ['Damage','Provider reports any damage or breakage in writing within 24 hours of discovery; liability is limited to repair or replacement at fair market value.'],
  ['Satisfaction','Client may request a re-clean of any missed item within 24 hours of service completion at no additional charge.'],
  ['Photo Documentation','Provider may take before/after photos for quality assurance and marketing use. Client may opt out of marketing use.'],
];
export function agreementTerms(segment){
  const commercial=segment==='commercial';return{
    version:commercial?'Commercial Services Agreement · 13.09.26':'Home Services Agreement · 12.09.26',
    provider:'VIP CONCIERGE LIMITED',team:'All cleaning services are performed by a two-person team. No single-cleaner rate is offered.',
    access:'Access at Arrival: client or an authorised occupant admits the provider. Standing Access: client provides a key, code or lockbox in advance; notify the provider in writing within 24 hours of any change to codes or locks.',
    subcontractors:"Client authorises VIP Concierge Limited to engage subcontractors where required. Subcontracted work is the exception, not the norm. Standards are available by emailing info@viicasa.com.",
    clauses:[
      ['Supplies',commercial?'Client supplies cleaning products and consumables unless the consumables/supply fee is elected.':'Client supplies cleaning products and equipment unless the supply fee is elected.'],
      ...common.slice(0,2),
      ['Insurance',commercial?'Provider maintains $2,000,000 Commercial General Liability insurance and current WorkSafeBC coverage for all workers on site, directly or through an authorised subcontractor. A Certificate of Insurance naming client as Additional Insured is available upon written request.':'Provider maintains Commercial General Liability insurance and current WorkSafeBC coverage for all workers on site, directly or through an authorised subcontractor.'],
      common[2],
      ['Term',commercial?'Recurring service is month-to-month unless a 12-month term is elected. With weekly or more frequent service, the first three months receive 30% off the elected rate. Early cancellation makes the actual introductory discount received due and payable. One-time and as-needed service ends on completion.':"Recurring service is month-to-month; cancellation requires 14 days' written notice. One-time and as-needed service ends on completion."],
      common[3],
      ['Payment',commercial?'One consolidated invoice covering all listed properties, issued monthly. Payment is due Net 15 from invoice date.':'Payment is due upon completion for one-time and as-needed service, or by pre-authorised payment on file for recurring service.'],
    ],
  };
}
export function allocateMinor(total,weights){
  if(!Number.isSafeInteger(total)||total<0||!weights.length||weights.some(w=>!Number.isSafeInteger(w)||w<1))fail(400,'Invalid price allocation.');
  const sum=weights.reduce((a,b)=>a+BigInt(b),0n),parts=weights.map((w,i)=>({i,value:Number(BigInt(total)*BigInt(w)/sum),rest:BigInt(total)*BigInt(w)%sum}));
  let remaining=total-parts.reduce((n,p)=>n+p.value,0);for(const p of [...parts].sort((a,b)=>a.rest>b.rest?-1:a.rest<b.rest?1:a.i-b.i)){if(!remaining)break;p.value++;remaining--;}
  return parts.map(p=>p.value);
}
export function plannedVisits(quote,details){
  const date=details.first_service_date;if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)fail(400,'Invalid first service date.');
  const days=['sun','mon','tue','wed','thu','fri','sat'];
  const dates=[];let day=new Date(date+'T12:00:00Z');
  if(quote.frequency==='once'&&quote.visits!==1)fail(400,'One-time service requires one visit.');
  for(let i=0;i<quote.visits;i++){
    const base=new Date(day);if(quote.frequency==='monthly'){base.setUTCDate(1);base.setUTCMonth(base.getUTCMonth()+i);const max=new Date(Date.UTC(base.getUTCFullYear(),base.getUTCMonth()+1,0)).getUTCDate();base.setUTCDate(Math.min(new Date(date).getUTCDate(),max));}
    else base.setUTCDate(base.getUTCDate()+i*(quote.frequency==='daily'?1:quote.frequency==='biweekly'?14:7));
    dates.push(base.toISOString().slice(0,10));
  }
  if(quote.discount_months&&dates.some(d=>d>=new Date(Date.UTC(day.getUTCFullYear(),day.getUTCMonth()+3,day.getUTCDate())).toISOString().slice(0,10)))fail(400,'Split periods beyond the introductory three months into another quote.');
  const expanded=expandedWeeklyDates(quote,date);if(expanded){dates.splice(0,dates.length,...expanded.map(d=>d.service_date));}
  if(quote.discount_months&&dates.some(d=>d>=new Date(Date.UTC(day.getUTCFullYear(),day.getUTCMonth()+3,day.getUTCDate())).toISOString().slice(0,10)))fail(400,'Split expanded weekly packages beyond the introductory three months.');
  const totalRows=details.properties.length*dates.length;
  const {bases,discounts}=scheduleAmounts(quote,details.properties,allocateMinor);
  if(totalRows>300)fail(400,'Split the service schedule into smaller periods.');
  const priced=quote.pricing?.rows;
  if(priced&&(priced.length!==totalRows||priced.reduce((n,p)=>n+p.amount_minor,0)!==quote.total_minor))fail(409,'The property schedule does not match the priced quote. Recalculate the quote first.');
  return details.properties.flatMap((p,index)=>dates.map((service_date,n)=>{
    const i=index*dates.length+n,billing=priced?.[i];if(billing&&(billing.property_index!==index||billing.visit_index!==n))fail(409,'Invalid priced visit allocation.');
    return{property_index:index,address:p.address,service_date,arrival_window:details.arrival_window,amount_minor:billing?billing.amount_minor:bases[i]-discounts[i],discount_minor:discounts[i],...(expanded?{block_index:expanded[n].block_index}:{}),...(billing?{pricing:billing}:{})};
  }));
}
