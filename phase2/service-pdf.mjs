import PDFDocument from 'pdfkit';
import {fileURLToPath} from 'node:url';
import {pricingSummary} from './pricing-calculation.mjs';
import {financeSummary} from './financial-core.mjs';

const text=v=>String(v??'').replace(/[\u2010-\u2015]/g,'-').replace(/\u00d7/g,'x').replace(/\u00b2/g,'2').replace(/\u2192/g,'to');
const cash=n=>(Number(n)/100).toFixed(2)+' CAD';
const date=v=>v?new Date(v).toISOString().slice(0,10):'-';
// Runs inside Node on the server; no browser, remote image, or executable needed.
export async function servicePdf(kind,record){
  if(!['contract','invoice'].includes(kind))throw Error('Unsupported document type');
  const doc=new PDFDocument({size:'A4',margin:48,bufferPages:true,info:{Title:kind==='contract'?'VII service agreement':'VII service invoice',Author:'VII',Subject:'Phase 2 demonstration - not a tax invoice'}});
  const chunks=[],ready=new Promise((resolve,reject)=>{doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  const width=doc.page.width-96,bottom=doc.page.height-85;
  const logo=fileURLToPath(new URL('../viicasa-backend/assets/logo-email.png',import.meta.url));
  const header=()=>{doc.rect(0,0,doc.page.width,90).fill('#111111');doc.image(logo,43,20,{fit:[62,48]});doc.fillColor('#ffffff').font('Times-Roman').fontSize(30).text('VII',118,24,{width:width-70});doc.font('Helvetica').fontSize(8).text('THE ART OF BEING HOME  |  VIILIFE',119,61,{width:width-70});doc.y=112;doc.fillColor('#243d34');};
  // Draw running headers after body layout so flowing text cannot erase them.
  doc.y=112;doc.fillColor('#243d34');doc.on('pageAdded',()=>{doc.y=112;doc.fillColor('#243d34');});
  const space=h=>{if(doc.y+h>bottom)doc.addPage();};
  const paragraph=(value,{bold=false,size=10,color='#243d34',gap=8}={})=>{const valueText=text(value),opts={width,lineGap:3};doc.font(bold?'Helvetica-Bold':'Helvetica').fontSize(size);const h=doc.heightOfString(valueText,opts);space(Math.min(h+gap,bottom-112));const page=doc.page,top=doc.y;doc.font(bold?'Helvetica-Bold':'Helvetica').fontSize(size).fillColor(color).text(valueText,48,top,opts);doc.y=(doc.page===page?Math.max(doc.y,top+h):doc.y)+gap;doc.x=48;};
  const title=value=>{space(45);paragraph(value,{bold:true,size:17,gap:12});};
  const section=value=>{space(60);paragraph(value,{bold:true,size:12,gap:9});};
  const row=(label,value,{compact=false}={})=>{const cols=[145,width-157],size=compact?9:10,padding=compact?10:18;doc.font('Helvetica').fontSize(size);const h=Math.max(doc.heightOfString(text(label),{width:cols[0]}),doc.heightOfString(text(value),{width:cols[1]}))+padding;space(h);const top=doc.y;doc.font('Helvetica-Bold').fontSize(size).fillColor('#243d34').text(text(label),48,top+4,{width:cols[0]});doc.font('Helvetica').text(text(value),205,top+4,{width:cols[1]});doc.moveTo(48,top+h-3).lineTo(doc.page.width-48,top+h-3).strokeColor('#dedfd7').lineWidth(.5).stroke();doc.y=top+h;};
  paragraph('PHASE 2 REVIEW - DEMONSTRATION ONLY',{bold:true,size:8,color:'#96704c'});
  const s=record.snapshot;
  const visitUnit=s.quote?.weekly_days?.length?'weekly blocks':'visits';
  if(kind==='contract'){
    title((s.segment==='commercial'?'Commercial':'Home')+' Services Agreement');
    paragraph(s.terms.version+' | Reference '+record.id.slice(0,8));
    paragraph('For review only. No certified electronic signature or automatic charge is represented by this document.',{size:9,color:'#777c72'});
    section('Client and service');row('Provider',s.terms.provider);row('Client',s.customer.name+'\n'+s.customer.email+'\n'+s.customer.phone);row('Service / scope',s.quote.service+'\n'+s.scope);row('Period amount',cash(s.quote.total_minor)+'\n'+s.quote.quantity+' units x '+s.quote.visits+' '+visitUnit+' x '+cash(s.quote.rate_minor)+'\nIntroductory discount: '+cash(s.quote.intro_discount_minor));row('Schedule',s.details.first_service_date+' | '+s.details.arrival_window+' | '+s.quote.frequency);row('Representative',s.seller_name);
    if(s.quote.weekly_days?.length)paragraph(s.quote.visits+' weekly blocks; '+s.visits.length+' execution visits. '+s.quote.weekly_block_definition,{size:9});
    if(s.quote.pricing?.totals){section('Pricing breakdown');for(const [label,amount]of pricingSummary(s.quote.pricing))row(label,cash(amount));paragraph('Pricing configuration v'+s.quote.pricing.policy_revision+'. Configured amounts only; not a tax invoice.',{size:9});}
    section('Properties');for(const p of s.details.properties)row(p.type+' / '+p.sqft+' sqft',p.address);
    section('Service schedule');for(const v of s.visits)row(v.service_date,v.address+'\n'+v.arrival_window+' | '+cash(v.amount_minor));
    section('Access and subcontractors');paragraph(s.terms.team);paragraph(s.terms.access);paragraph(s.terms.subcontractors);
    section('Terms');for(const [heading,body]of s.terms.clauses){space(65);paragraph(heading,{bold:true});paragraph(body);}
    section('Pricing notes');for(const note of s.quote.exclusions)paragraph(note,{size:9});
    section('Recorded acceptance');const a=record.acceptance;if(a){row('Accepted by',a.signed_name+'\n'+a.email);row('Recorded at',a.accepted_at);row('Access',a.access_method);row('Marketing photos',a.photo_marketing_optout?'Opted out':'Allowed under the agreement');paragraph((a.auth_method==='private_email_link'?'Private email link':'Verified email account')+', typed name and authenticated consent. Not a certified digital signature.',{size:9});paragraph('Acceptance evidence: '+a.evidence_hash,{size:8});}else paragraph('Awaiting client review and acceptance.');
    paragraph('Document fingerprint: '+record.snapshot_hash,{size:8});
  }else{
    title(record.status==='paid'?'Payment receipt':'Service invoice');paragraph(record.number,{bold:true,size:12});paragraph('Demonstration document. Not a tax invoice. '+(record.status==='paid'?'Payment recorded in the test environment.':'No payment is confirmed by this document.'),{size:9,color:'#777c72'});
    row('Client',s.customer.name+'\n'+record.customer_email);row('Issued / due',date(record.issued_at)+' / '+date(record.due_date)+'\n'+s.payment_terms);row('Status',record.status);if(record.paid_at)row('Payment recorded',new Date(record.paid_at).toISOString());
    section('Services provided');for(const l of s.lines)row(l.date+' | '+cash(l.amount_minor),l.service+'\n'+l.address,{compact:true});
    if(s.pricing?.totals){section('Pricing breakdown');for(const [label,amount]of pricingSummary(s.pricing))row(label,cash(amount),{compact:true});paragraph('Pricing configuration v'+s.pricing.policy_revision+'. Configured amounts only; not a tax invoice.',{size:9});}
    else section((record.finance?.credits_minor?'Adjusted invoice amount: ':'Total: ')+cash(record.total_minor));
    const financial=financeSummary(record.finance);if(financial.length){space(245);section('Financial history - demonstration');for(const [label,amount]of financial)row(label,cash(amount),{compact:true});paragraph('No real refund or bank transfer is confirmed by this demonstration history.',{size:9});}
    paragraph('Introductory discount already included: '+cash(record.discount_minor));for(const note of s.exclusions)paragraph(note,{size:9});
  }
  const range=doc.bufferedPageRange();for(let n=range.start;n<range.start+range.count;n++){doc.switchToPage(n);header();const floor=doc.page.height-55,margin=doc.page.margins.bottom;doc.page.margins.bottom=0;doc.moveTo(48,floor-10).lineTo(doc.page.width-48,floor-10).strokeColor('#dedfd7').stroke();doc.fillColor('#777c72').font('Helvetica').fontSize(8).text('VII | Kelowna, British Columbia | info@viicasa.com',48,floor,{width:width-55,lineBreak:false});doc.text((n+1)+' / '+range.count,doc.page.width-90,floor,{width:42,align:'right',lineBreak:false});doc.page.margins.bottom=margin;}
  doc.end();return ready;
}
export const pdfAttachment=(kind,record)=>({kind,filename:(kind==='contract'?'VII-agreement-'+record.id.slice(0,8):'VII-'+record.number)+(record.status==='paid'?'-receipt':'')+'.pdf',record});
export async function renderedAttachments(descriptors=[]){
  if(!Array.isArray(descriptors)||descriptors.length>2)throw Error('Invalid document attachments');
  return Promise.all(descriptors.map(async d=>({filename:d.filename.replace(/[^a-zA-Z0-9._-]/g,'-'),content:await servicePdf(d.kind,d.record),contentType:'application/pdf'})));
}
