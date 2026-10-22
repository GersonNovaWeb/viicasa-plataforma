import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {servicePdf} from './service-pdf.mjs';
import {agreementTerms,snapshotHash,plannedVisits} from './agreement-content.mjs';
import {quoteService} from './service-menu.mjs';
import {configuredQuote,emptyPricing,pricingTotals} from './pricing-calculation.mjs';
const weeklyPreview=process.argv.includes('--weekly');
const pricingPreview=process.argv.includes('--pricing')||weeklyPreview;
const financialPreview=process.argv.includes('--financial');
const properties=[{address:'100 Example Street, Kelowna, BC',sqft:1000},{address:'200 Demonstration Avenue, Kelowna, BC',sqft:2000}];
// Fictional QA configuration only. Never writes to the active pricing policy.
const policy={...emptyPricing('commercial'),approved:true,revision:1,min_visit_minor:4000,taxes:[{id:'sample',label:'Sample demo tax',basis_points:500}],extras:[{id:'supplies',label:'Demonstration supplies',basis:'visit',amount_minor:300,taxable:true},{id:'travel',label:'Demonstration travel',basis:'schedule',amount_minor:1001,taxable:false}],note:'Fictional PDF rendering fixture only'};
const selection={service_id:pricingPreview?'commercial-fixed-weekly':'commercial-team',rate_minor:pricingPreview?10000:7500,quantity:pricingPreview?1:2,visits:pricingPreview?2:4,frequency:'weekly',term:'annual',properties,...(weeklyPreview?{weekly_days:[1,3,5]}:{})};
const quote=pricingPreview?configuredQuote({...selection,pricing_revision:1,extras:[{id:'supplies',quantity:2},{id:'travel',quantity:1}]},policy):quoteService(selection),details={first_service_date:'2027-02-01',arrival_window:'09:00-12:00',billing_contact:'Avery Reed',properties:properties.map(p=>({...p,type:'office'}))};
const snapshot={segment:'commercial',customer:{name:'Avery Reed',email:'avery@example.invalid',phone:'+1 250 555 0123'},scope:'Scheduled care for two demonstration office properties.',quote,details,terms:agreementTerms('commercial'),seller_name:'VII Demo Representative',visits:plannedVisits(quote,details)};
const contract={id:'a0000000-0000-4000-8000-000000000001',status:'accepted',snapshot,snapshot_hash:snapshotHash(snapshot),acceptance:{signed_name:'Avery Reed',email:'avery@example.invalid',accepted_at:'2027-01-20T12:00:00Z',access_method:'standing',photo_marketing_optout:true,evidence_hash:'0'.repeat(64)}};
const invoice={id:'a0000000-0000-4000-8000-000000000002',number:'VII-DEMO-2027-02-PREVIEW',customer_email:'avery@example.invalid',status:'paid',issued_at:'2027-02-28T12:00:00Z',due_date:'2027-03-15',paid_at:'2027-03-01T12:00:00Z',total_minor:quote.total_minor,discount_minor:quote.intro_discount_minor,snapshot:{customer:snapshot.customer,payment_terms:'Net 15',exclusions:quote.exclusions,lines:snapshot.visits.map(v=>({date:v.service_date,address:v.address,service:quote.service,amount_minor:v.amount_minor}))}};
if(pricingPreview)invoice.snapshot.pricing={policy_revision:1,rows:snapshot.visits.map(v=>v.pricing),totals:pricingTotals(snapshot.visits.map(v=>v.pricing))};
if(financialPreview){const original=invoice.total_minor;invoice.finance={original_minor:original,credits_minor:6000,refunds_minor:10000,net_total_minor:original-6000,paid_minor:original-6000,net_received_minor:original-16000,due_minor:0};invoice.original_total_minor=original;invoice.total_minor=original-6000;}
const directory=fileURLToPath(new URL('../tmp/pdfs/',import.meta.url));await mkdir(directory,{recursive:true});
const prefix=weeklyPreview?'weekly-':financialPreview?'financial-':pricingPreview?'pricing-':'';
if(!financialPreview)await writeFile(directory+prefix+'agreement-preview.pdf',await servicePdf('contract',contract));await writeFile(directory+prefix+'receipt-preview.pdf',await servicePdf('invoice',invoice));console.log((financialPreview?'One':'Two')+' private fictional PDF previews generated in tmp/pdfs.');
