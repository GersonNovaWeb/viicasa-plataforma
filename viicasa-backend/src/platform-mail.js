// Transactional messages only. No marketing subscriptions or remote requests.
export const escapeMail=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cash=(n,currency)=>`${(n/100).toLocaleString('en-CA',{minimumFractionDigits:2,maximumFractionDigits:2})} ${currency}`;
const english=value=>String(value??'').split(/\n\[EN\]\n/).at(-1);
const address=value=>value?[value.street,value.city,value.state,value.postal_code,value.country].filter(Boolean).join(', '):'';
export const purchaseEvent=status=>({'confirmado':'paid','pago recibido en revisión':'review','pago rechazado':'failed','pago vencido':'expired','cancelada':'cancelled'}[status]||'requested');
export function accountMailUrl(siteUrl){
  const url=new URL('/cuenta',siteUrl);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw Error('Invalid mail site URL');
  return url.href;
}
function brandedMail({subject,title,kicker,paragraphs,details=[],lines=[],currency,summary=[],actionUrl,actionLabel='View my account',testNote}){
  const e=escapeMail;
  const tr=(label,value)=>`<tr><td style="padding:10px 8px;border-bottom:1px solid #e8e6df;color:#737a75;vertical-align:top;width:35%">${e(label)}</td><td style="padding:10px 8px;border-bottom:1px solid #e8e6df;overflow-wrap:anywhere">${e(value)}</td></tr>`;
  const text=[kicker,title,testNote,...paragraphs,...details.map(([k,v])=>`${k}: ${v}`),...lines.map(l=>`${l.code}: ${cash(l.amount_minor,currency)}`),...summary.map(([k,v])=>`${k}: ${v}`),actionUrl?`${actionLabel}: ${actionUrl}`:'','Kelowna, British Columbia, Canada','https://viicasa.com | contact@viicasa.com'].filter(Boolean).join('\n\n');
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f4f3f0;font-family:Arial,Helvetica,sans-serif;color:#233a33">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:720px;margin:0 auto;border-collapse:collapse;background:#fff"><tr><td align="center" style="background:#111111;padding:28px"><img src="https://viicasa.com/images/logo-email.png" width="145" alt="VIICASA" style="display:block;width:145px;height:auto;border:0"></td></tr>
<tr><td style="padding:32px 24px;font-size:14px;line-height:22px"><p style="color:#95772c;letter-spacing:3px;font-size:11px">${e(kicker)}</p><h1 style="font-size:28px;line-height:34px;font-weight:400">${e(title)}</h1>
${testNote?`<p style="padding:14px;background:#fff5dc;border-left:3px solid #ab8b50">${e(testNote)}</p>`:''}${paragraphs.map(p=>`<p>${e(p)}</p>`).join('')}
${details.length?`<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:13px;line-height:20px">${details.map(([k,v])=>tr(k,v)).join('')}</table>`:''}
${lines.length?`<h2 style="font-size:18px;font-weight:400;margin-top:28px">Order breakdown</h2><table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:13px;line-height:20px"><tr><th align="left" style="padding:10px;background:#f1f0e9">Description</th><th align="right" style="padding:10px;background:#f1f0e9">Amount</th></tr>${lines.map(l=>`<tr><td style="padding:12px 10px;border-bottom:1px solid #e8e6df;overflow-wrap:anywhere">${e(l.code)}</td><td align="right" style="padding:12px 10px;border-bottom:1px solid #e8e6df;white-space:nowrap">${e(cash(l.amount_minor,currency))}</td></tr>`).join('')}</table>`:''}
${summary.length?`<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:18px;border-collapse:collapse">${summary.map(([k,v])=>tr(k,v)).join('')}</table>`:''}
${actionUrl?`<p style="margin:28px 0"><a href="${e(actionUrl)}" style="display:inline-block;background:#203d35;color:#fff;padding:16px 24px;text-decoration:none">${e(actionLabel)}</a></p>`:''}<p>With care,<br><strong>The VIICASA team</strong></p></td></tr>
<tr><td align="center" style="background:#111111;padding:28px 20px;color:#fff;font-size:13px;line-height:22px">Kelowna, British Columbia, Canada<br><a href="https://viicasa.com" style="color:#d2a72d;text-decoration:none">viicasa.com</a> &nbsp; | &nbsp; <a href="mailto:contact@viicasa.com" style="color:#d2a72d;text-decoration:none">contact@viicasa.com</a><p><a href="https://www.instagram.com/viiconcierge" style="color:#fff">Instagram</a> &nbsp; | &nbsp; <a href="https://www.facebook.com/profile.php?id=61594619251265" style="color:#fff">Facebook</a> &nbsp; | &nbsp; LinkedIn</p><p style="color:#888;font-size:10px;line-height:16px">This email may contain confidential or privileged information intended exclusively for the recipient.<br>© ${new Date().getUTCFullYear()} VIICASA. All rights reserved.</p></td></tr></table></body></html>`;
  return {subject,body:text,html};
}

export function renderWelcomeMail(customer,siteUrl){
  return brandedMail({subject:'Welcome to VIICASA',title:'Welcome home.',kicker:'VIICASA / YOUR ACCOUNT',
    paragraphs:[`Hi ${customer.name||'there'},`,'Welcome to VIICASA. Your account is ready, and we are glad you are here.',
      'Discover ViiShop for thoughtful pieces for your home, ViiConcierge for your next stay, and ViiLife for professional home care.',
      'Sign in to view your orders, reservations and ViiLife services in one place. This welcome message does not confirm a purchase or a reservation.',
      'If you have any questions, contact us at contact@viicasa.com.'],actionUrl:accountMailUrl(siteUrl)});
}

export function purchaseMailData(c,event,config){
  if(!['order','booking'].includes(c.kind))throw Error('Unsupported purchase kind');
  const d=c.detail,booking=c.kind==='booking',brand=booking?'ViiConcierge':'ViiShop',paid=['paid','review'].includes(event);
  const test=config.paymentProvider==='demo'||config.stripeKey?.startsWith('sk_test_')===true;
  const details=[['Reference',c.id],['Customer',c.customer_name],['Email',c.customer_email],['Phone',c.customer_phone]];
  let lines,next;
  if(booking){
    details.push(['Property',english(d.property_name)],['Check-in',d.check_in],['Check-out',d.check_out],['Guests',String(d.guests)],['Payment option',d.pay==='deposit'?'Deposit':'Full payment']);
    lines=[{code:`${d.nights} nights x ${cash(d.nightly_minor,c.currency)}`,amount_minor:d.nights*d.nightly_minor},{code:'Cleaning fee',amount_minor:d.cleaning_minor}];
    next='Please review your reservation in your account. Contact the ViiConcierge team for arrival details and any remaining balance.';
  }else{
    details.push(['Delivery',d.delivery==='shipping'?'Shipping':'Pickup']);
    if(d.delivery==='shipping')details.push(['Delivery address',address(d.shipping_address)]);
    else if(d.pickup_instructions)details.push(['Pickup instructions',english(d.pickup_instructions)]);
    lines=(d.items||[]).map(i=>({code:`${english(i.name)} | Qty ${i.quantity} x ${cash(i.unit_minor,c.currency)} | SKU ${i.sku}`,amount_minor:i.unit_minor*i.quantity}));
    if(d.delivery==='shipping')lines.push({code:'Shipping',amount_minor:d.shipping_minor});
    next=d.delivery==='shipping'?'We will prepare your order. This receipt does not mean your items have shipped.':'We will prepare your order for pickup. Please wait for pickup coordination before collecting it.';
  }
  if(event==='review')next='Your payment was received, but your order requires review. Please do not pay again. Our team will contact you.';
  const status={paid:'Payment received',review:'Payment received - under review',failed:'Payment unsuccessful',expired:'Payment expired',cancelled:'Order cancelled',requested:'Order update'}[event];
  const paidMinor=paid?c.due_minor:0;
  const summary=[['Order total',cash(c.total_minor,c.currency)],[test?'Test payment amount':'Payment received',cash(paidMinor,c.currency)]];
  if(booking&&paid)summary.push(['Remaining balance',cash(Math.max(0,c.total_minor-paidMinor),c.currency)]);
  const paragraphs=paid?[`Thank you for choosing ${brand}.`,next,config.paymentProvider==='demo'?'This is an isolated demonstration. No payment receipt is issued.':'Your PDF payment receipt is attached. This summary does not provide a tax breakdown.']:[`Here is an update on your ${brand} order.`,event==='cancelled'?'The unpaid order was cancelled. This message does not confirm a refund.':'This message does not confirm payment. Open your account to review the current order status.'];
  return {brand,event,paid,test,details,lines,next,status,summary,paragraphs,paidMinor,currency:c.currency};
}
export function renderPurchaseMail(c,event,config,audience='customer'){
  const m=purchaseMailData(c,event,config);
  return brandedMail({subject:`${m.test?'[STRIPE TEST] ':''}${m.brand}${audience==='team'?' / TEAM':''} - ${m.status}`,title:m.paid?'Payment receipt':m.status,kicker:`${m.brand.toUpperCase()}${audience==='team'?' / TEAM COPY':''}`,
    paragraphs:audience==='team'?[`A ${m.brand} order has been updated. Review the order in your administrator dashboard.`,m.paid?m.next:'This update does not confirm a successful payment. Do not fulfil an unpaid order.']:m.paragraphs,
    details:[['Status',m.status],...m.details],lines:m.lines,currency:m.currency,summary:m.summary,
    testNote:m.test?'TEST TRANSACTION - No real money was charged. This is not a tax receipt or confirmation of a real delivery or stay.':null,
    actionUrl:audience==='team'?new URL('/admin',accountMailUrl(config.siteUrl)).href:accountMailUrl(config.siteUrl),actionLabel:audience==='team'?'Review order':'View my orders'});
}
export function commerceReceiptSnapshot(c,event,config){
  const m=purchaseMailData(c,event,config);
  if(!m.paid)throw Error('Unpaid order cannot have a payment receipt');
  return {version:2,kind:c.kind,reference:c.id,issuedAt:new Date().toISOString(),event,paymentTest:m.test,paidMinor:m.paidMinor,
    customer:{name:c.customer_name,email:c.customer_email,phone:c.customer_phone},
    quote:{currency:c.currency,total_minor:c.total_minor,lines:m.lines},
    fields:c.kind==='booking'?[['Property',english(c.detail.property_name)],['Stay',`${c.detail.check_in} to ${c.detail.check_out}`],['Guests / payment',`${c.detail.guests} guests / ${c.detail.pay==='deposit'?'Deposit':'Full payment'}`]]:m.details.slice(4),nextStep:m.next,
    ...(c.kind==='booking'?{balanceMinor:Math.max(0,c.total_minor-m.paidMinor)}:{})};
}
