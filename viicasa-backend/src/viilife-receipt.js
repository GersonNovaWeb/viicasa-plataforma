import PDFDocument from 'pdfkit';
import {fileURLToPath} from 'node:url';

const logo=fileURLToPath(new URL('../assets/logo-email.png',import.meta.url));
const names={routine:'Routine home cleaning',deep:'Deep cleaning',full_clean:'Full-property cleaning',setup:'Home setup',decoration:'Decoration',removals:'Removals'};
const days={mon:'Monday',tue:'Tuesday',wed:'Wednesday',thu:'Thursday',fri:'Friday',sat:'Saturday',sun:'Sunday'};
const clean=v=>String(v??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/[\u2010-\u2015]/g,'-');
const date=v=>new Intl.DateTimeFormat('en-CA',{dateStyle:'long',timeZone:'UTC'}).format(new Date(v));

// Store a small immutable snapshot, not a PDF binary or a public download URL.
// Only the server's settled-payment notice creates this object.
export function receiptSnapshot(input){
  return JSON.parse(JSON.stringify({version:1,reference:input.reference,issuedAt:input.issuedAt,
    customer:input.customer,selection:input.selection,quote:input.quote,schedule:input.schedule,
    address:input.address,event:input.event,paymentTest:input.paymentTest===true,paidMinor:input.paidMinor}));
}

export async function renderViiLifeReceipt(data){
  const commerce=data.version===2&&['order','booking'].includes(data.kind);
  if((data.version!==1&&!commerce)||!['paid','review'].includes(data.event))throw Error('Invalid receipt state');
  const brand=commerce?(data.kind==='booking'?'ViiConcierge':'ViiShop'):'ViiLife';
  const {quote,customer,address={},schedule={}}=data;
  if(!/^[A-Z]{3}$/.test(quote.currency)||![quote.total_minor,data.paidMinor].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('Invalid receipt amount');
  const cash=n=>`${(n/100).toLocaleString('en-CA',{minimumFractionDigits:2,maximumFractionDigits:2})} ${quote.currency}`;
  const pdf=new PDFDocument({size:'LETTER',margin:44,bufferPages:true,info:{Title:`${brand} payment receipt`,Author:'VIICASA',CreationDate:new Date(data.issuedAt)}});
  const chunks=[];
  const output=new Promise((resolve,reject)=>{pdf.on('data',chunk=>chunks.push(chunk));pdf.on('end',()=>resolve(Buffer.concat(chunks)));pdf.on('error',reject);});
  const W=524, left=44, green='#203d35', gold='#ab8b50', ink='#233a33';let y=0;
  const text=(value,x,top,width,size=10,color=ink,font='Helvetica')=>{pdf.font(font).fontSize(size).fillColor(color).text(clean(value),x,top,{width,lineGap:3});};
  const height=(value,width,size=10,font='Helvetica')=>pdf.font(font).fontSize(size).heightOfString(clean(value),{width,lineGap:3});
  const header=()=>{
    pdf.rect(0,0,612,104).fill('#111111');
    pdf.image(logo,left,20,{fit:[104,64],align:'center',valign:'center'});
    text('VIICASA',380,30,188,23,'#ffffff','Times-Roman');
    text('THE ART OF BEING HOME',380,64,188,7,gold);
    pdf.rect(left,103,W,2).fill(gold);y=128;
  };
  const ensure=h=>{if(y+h>690){pdf.addPage();header();text(`${brand.toUpperCase()} / RECEIPT CONTINUED`,left,y,W,9,gold);y+=27;}};
  const paragraph=(value,{size=9,color='#64716b',gap=10}={})=>{const h=height(value,W,size);ensure(h+gap);text(value,left,y,W,size,color);y+=h+gap;};
  const field=(label,value)=>{
    const h=Math.max(commerce?18:20,height(value,379,9)+(commerce?5:10));ensure(h);
    text(label.toUpperCase(),left,y,130,7,gold,'Helvetica-Bold');text(value,189,y,379,9);y+=h;
  };
  const section=label=>{ensure(40);y+=10;text(label.toUpperCase(),left,y,W,8,gold,'Helvetica-Bold');y+=20;};
  header();
  text(commerce?`${brand} payment receipt`:'Payment receipt',left,y,W,commerce?25:29,ink,'Times-Roman');y+=40;
  if(data.paymentTest){paragraph(`STRIPE TEST PAYMENT - No real money was charged. This is not a tax receipt or confirmation of a real ${commerce?'delivery or stay':'service visit'}.`,{size:9,color:'#956419',gap:16});}
  field('Order reference',data.reference);
  field('Issued (UTC)',date(data.issuedAt));
  field('Payment status',data.event==='review'?'Payment received - order under review. Please do not pay again.':data.paymentTest?'Test payment completed':'Payment received');
  section('Customer & service');
  field('Customer',`${customer.name} | ${customer.email}`);
  field('Contact',customer.phone);
  if(commerce){for(const [label,value]of data.fields)field(label,value);}
  else{
    field('Service address',[address.street,address.city,address.state,address.postal_code,address.country].filter(Boolean).join(', '));
    const preferred=quote.dates?.length?quote.dates.map(date).join(' / '):(schedule.days||[]).map(d=>days[d]||d).join(', ');
    field('Preferred dates',preferred||'To be arranged');
    field('Preferred arrival',Number.isInteger(schedule.start_hour)?`${String(schedule.start_hour).padStart(2,'0')}:00 - local time at the property`:schedule.window||'To be arranged');
  }
  section(commerce?'Order breakdown':'Service breakdown');
  ensure(65);pdf.rect(left,y,W,24).fill('#f1f0e9');text('DESCRIPTION',left+10,y+8,360,8,ink,'Helvetica-Bold');text('AMOUNT',440,y+8,118,8,ink,'Helvetica-Bold');y+=31;
  const lines=quote.lines?.length?quote.lines:[{code:data.selection.service,amount_minor:quote.total_minor}];
  for(const line of lines){
    if(!Number.isSafeInteger(line.amount_minor)||line.amount_minor<0)throw Error('Invalid receipt line');
    const b=quote.billing||{};
    const detail=line.code==='routine'&&b.scope==='one_cycle'?`\n${cash(b.hourly_minor)} / h x ${b.hours_per_visit} h x ${b.visits} visits`:'';
    const label=(commerce?line.code:(names[line.code]||line.code))+detail,h=Math.max(30,height(label,365,9)+14);
    ensure(h);text(label,left+10,y,365,9);text(cash(line.amount_minor),440,y,118,9);y+=h;pdf.moveTo(left,y-7).lineTo(568,y-7).strokeColor('#dddcd3').stroke();
  }
  ensure(90);y+=8;text('Order total',left+10,y,365,10,ink,'Helvetica-Bold');text(cash(quote.total_minor),440,y,118,10,ink,'Helvetica-Bold');y+=28;
  pdf.rect(left,y,W,40).fill(green);text(data.paymentTest?'TEST PAYMENT AMOUNT':'PAYMENT RECEIVED',left+12,y+14,365,9,'#ffffff','Helvetica-Bold');text(cash(data.paidMinor),440,y+13,118,12,'#ffffff','Helvetica-Bold');y+=51;
  if(commerce&&data.kind==='booking')field('Remaining balance',cash(data.balanceMinor));
  const next=commerce?data.nextStep:data.event==='review'?'Your payment was received and your order needs review. Please do not pay again. Our team will contact you.':'The ViiLife team will be in touch soon to coordinate your service. Preferred dates and arrival times are subject to confirmation.';
  const extras=quote.estimate_pending?.length?'Not included - separate estimate required: '+quote.estimate_pending.map(c=>names[c]||c).join(', '):'';
  const disclaimer=commerce?'This receipt records the payment shown above, not a tax breakdown or a refund. Refer to the terms accepted with your order.':'One service cycle or visit only. No subscription or automatic renewal. This payment summary does not provide a tax breakdown.';
  // Measure the entire short closing block instead of leaving a lone disclaimer.
  ensure(30+height(next,W,9)+10+(extras?height(extras,W,9)+10:0)+height(disclaimer,W,8)+10);
  section('What happens next');
  paragraph(next);if(extras)paragraph(extras);paragraph(disclaimer,{size:8});
  const range=pdf.bufferedPageRange();
  for(let p=range.start;p<range.start+range.count;p++){
    pdf.switchToPage(p);pdf.page.margins.bottom=0;
    pdf.rect(0,723,612,69).fill('#111111');
    text('VIICASA  |  Kelowna, British Columbia, Canada',left,737,W,9,'#ffffff');
    text('viicasa.com  |  contact@viicasa.com',left,756,420,8,gold);
    text(`${p+1} / ${range.count}`,520,756,48,8,'#ffffff');
  }
  pdf.end();return output;
}

export async function receiptAttachment(data){
  const reference=String(data.reference).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80)||'order';
  const brand=data.version===2?(data.kind==='booking'?'ViiConcierge':'ViiShop'):'ViiLife';
  return {filename:`VIICASA-${brand}-Receipt-${reference}.pdf`,content:await renderViiLifeReceipt(data),contentType:'application/pdf',contentDisposition:'attachment'};
}
