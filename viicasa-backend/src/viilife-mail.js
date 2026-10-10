// Shared by demo orders and Firestore payment notices. No network or payment calls.
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={routine:'Routine home cleaning',deep:'Deep cleaning',full_clean:'Full-property cleaning',setup:'Home setup',decoration:'Decoration',removals:'Removals'};
const weekdays={mon:'Monday',tue:'Tuesday',wed:'Wednesday',thu:'Thursday',fri:'Friday',sat:'Saturday',sun:'Sunday'};
const date=value=>/^\d{4}-\d{2}-\d{2}/.test(value||'')?new Intl.DateTimeFormat('en-CA',{dateStyle:'long',timeZone:'UTC'}).format(new Date(value)):'Not specified';
const cash=(minor,currency)=>(minor/100).toFixed(2)+' '+currency;

export function renderViiLifeMail({reference,issuedAt,customer,selection,quote,schedule,address,event='requested',demo=false,audience='customer',paidMinor=quote.total_minor}){
  const paid=event==='paid'||event==='review';
  const status={paid:demo?'Payment simulated':'Payment received',review:demo?'Simulated payment under review':'Payment received — under review',requested:'Request received',unpaid:'Follow-up needed',failed:'Payment unsuccessful',expired:'Payment expired',cancelled:'Order cancelled'}[event]||'Order update';
  const title=paid?(demo?'Demonstration receipt':'Payment receipt'):'Service request summary';
  const contact=paid?'The ViiLife team will be in touch soon to coordinate the details and your preferred schedule.':'Please complete payment through Stripe before our team coordinates your visit. No visit has been confirmed.';
  const intro=event==='unpaid'?'This large request has not completed payment. Please contact the customer to offer assistance; do not assume why they stopped.':event==='review'?'Your payment was received, but the order requires review. Please do not pay again.':paid?'Thank you for choosing ViiLife. Your order details are below.':event==='requested'?'Thank you for your request. Your preferred schedule is subject to confirmation.':'Please review the payment status below. This message does not confirm a visit.';
  const demoNote=demo?'DEMONSTRATION ONLY — No money was charged and no real visit has been booked. This is not a tax receipt.':'';
  const b=quote.billing||{},cycle=b.scope==='one_cycle';
  const breakdown=cycle?`${cash(b.hourly_minor,quote.currency)}/h × ${b.hours_per_visit} h × ${b.visits} visits`:'';
  const dates=quote.dates?.length?quote.dates.map(date).join(' · '):(schedule.days||[]).map(d=>weekdays[d]||d).join(' · ');
  const preferredTime=Number.isInteger(schedule.start_hour)?`${String(schedule.start_hour).padStart(2,'0')}:00 — local time at the property`:({morning:'Morning',afternoon:'Afternoon',evening:'Evening'}[schedule.window]||'To be arranged');
  const plan=cycle?`One ${b.cycle==='biweekly'?'two-week':'weekly'} cycle · ${b.visits} visits · ${b.hours_per_visit} hours per visit`:'One visit';
  const location=[address.street,address.city,address.state,address.postal_code,address.country==='CA'?'Canada':address.country].filter(Boolean).join(', ');
  const pending=(quote.estimate_pending||[]).map(code=>names[code]||code);
  const items=quote.lines?.length?quote.lines:[{code:selection.service,amount_minor:quote.total_minor}];
  const details=[['Reference',reference],['Issued',date(issuedAt)],['Status',status],['Customer',customer.name],['Email',customer.email],['Phone',customer.phone],['Service address',location],['Service',names[selection.service]||selection.service],['Plan',plan],['Preferred dates / days',dates],['Preferred arrival',preferredTime]];
  const amountLabel=paid?(demo?'Simulated payment':'Payment received'):'Amount paid';
  const amount=paid?cash(paidMinor,quote.currency):cash(0,quote.currency);
  const notes=[contact,'Preferred dates and arrival times are not a confirmed appointment. No subscription or automatic renewal.',...(pending.length?[`Not included in the total — separate estimate required: ${pending.join(', ')}.`]:[]),'This summary does not provide a tax breakdown.'];
  const footerText='Kelowna, British Columbia, Canada\nhttps://viicasa.com | contact@viicasa.com\nThis email may contain confidential or privileged information intended exclusively for the recipient.\n© 2026 VIICASA. All rights reserved.';
  const body=[`VIICASA | ViiLife — ${title}`,demoNote,audience==='team'?'TEAM COPY':'',demo&&audience==='customer'?'Customer message preview — delivered only to the test mailbox.':'',intro,...details.map(([k,v])=>`${k}: ${v}`),...items.map(i=>`${names[i.code]||i.code}: ${cash(i.amount_minor,quote.currency)}`),breakdown,`Total: ${cash(quote.total_minor,quote.currency)}`,`${amountLabel}: ${amount}`,...notes,footerText].filter(Boolean).join('\n\n');
  const tr=(label,value)=>`<tr><td style="padding:9px 10px 9px 0;color:#777777;vertical-align:top;width:36%;border-bottom:1px solid #eeeeee;">${escape(label)}</td><td style="padding:9px 0;color:#222222;vertical-align:top;border-bottom:1px solid #eeeeee;overflow-wrap:anywhere;word-break:break-word;">${escape(value)}</td></tr>`;
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f4f3f0;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:720px;margin:0 auto;border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;">
<tr><td align="center" style="background-color:#111111;padding:28px 20px 26px;text-align:center;"><img src="https://viicasa.com/images/logo-email.png" alt="VIICASA" width="145" style="display:block;width:145px;max-width:60%;height:auto;margin:0 auto;border:0;"></td></tr>
<tr><td style="padding:32px 24px;background-color:#ffffff;color:#222222;font-size:14px;line-height:22px;">
<p style="margin:0 0 8px;color:#95772c;font-size:11px;letter-spacing:3px;">VIILIFE · HOME CARE${audience==='team'?' · TEAM COPY':''}</p>
<h1 style="margin:0 0 12px;font-size:28px;line-height:34px;font-weight:400;">${escape(title)}</h1>
<p style="margin:0 0 24px;">${escape(intro)}</p>
${demo?`<p style="padding:14px;background-color:#fff5dc;border-left:3px solid #b58d2c;font-size:12px;line-height:19px;">${escape(demoNote)}${audience==='customer'?'<br>Customer preview — delivered only to the test mailbox.':''}</p>`:''}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:13px;line-height:20px;">${details.map(([k,v])=>tr(k,v)).join('')}</table>
<h2 style="margin:28px 0 12px;font-size:17px;font-weight:400;">Order breakdown</h2>
<table width="100%" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;font-size:13px;line-height:20px;"><thead><tr><th scope="col" align="left" style="padding:10px;background-color:#f5f3ee;">Service</th><th scope="col" align="right" style="padding:10px;background-color:#f5f3ee;">Amount</th></tr></thead><tbody>
${items.map(i=>`<tr><td style="padding:12px 10px;border-bottom:1px solid #eeeeee;">${escape(names[i.code]||i.code)}${i.code==='routine'&&breakdown?`<br><span style="font-size:12px;color:#777777;">${escape(breakdown)}</span>`:''}</td><td align="right" style="padding:12px 10px;border-bottom:1px solid #eeeeee;">${escape(cash(i.amount_minor,quote.currency))}</td></tr>`).join('')}
<tr><td style="padding:16px 10px;font-weight:bold;">Order total</td><td align="right" style="padding:16px 10px;font-weight:bold;">${escape(cash(quote.total_minor,quote.currency))}</td></tr>
<tr><td style="padding:16px 10px;background-color:#203d35;color:#ffffff;">${escape(amountLabel)}</td><td align="right" style="padding:16px 10px;background-color:#203d35;color:#ffffff;font-weight:bold;">${escape(amount)}</td></tr></tbody></table>
<h2 style="margin:28px 0 10px;font-size:17px;font-weight:400;">What happens next</h2>${notes.map(n=>`<p style="margin:0 0 12px;color:#666666;font-size:13px;line-height:21px;">${escape(n)}</p>`).join('')}
<p style="margin:24px 0 0;">With care,<br><strong>The ViiLife team</strong></p></td></tr>
<tr><td align="center" style="background-color:#111111;padding:28px 20px 5px;color:#ffffff;font-size:14px;line-height:21px;">Kelowna, British Columbia, Canada</td></tr>
<tr><td align="center" style="background-color:#111111;padding:0 20px 20px;font-size:14px;line-height:21px;"><a href="https://viicasa.com" style="color:#d2a72d;text-decoration:none;">viicasa.com</a><span style="color:#777777;padding:0 12px;">|</span><a href="mailto:contact@viicasa.com" style="color:#d2a72d;text-decoration:none;">contact@viicasa.com</a></td></tr>
<tr><td align="center" style="background-color:#111111;padding:4px 20px 30px;font-size:14px;line-height:22px;"><a href="https://www.instagram.com/viiconcierge?stkn=MXUzdnhrZjBrdDY2Zg%3D%3D&amp;utm_source=qr" style="color:#ffffff;text-decoration:none;">Instagram</a><span style="color:#666666;padding:0 10px;">•</span><a href="https://www.facebook.com/profile.php?id=61594619251265&amp;mibextid=wwXIfr&amp;rdid=qku4QPZqftw4Ezff&amp;share_url=https%3A%2F%2Fwww.facebook.com%2Fshare%2F1ETHmdB3gS%2F%3Fmibextid%3DwwXIfr" style="color:#ffffff;text-decoration:none;">Facebook</a><span style="color:#666666;padding:0 10px;">•</span><span style="color:#ffffff;">LinkedIn</span></td></tr>
<tr><td style="background-color:#111111;padding:0 44px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;"><tr><td style="height:1px;background-color:#333333;font-size:1px;line-height:1px;">&nbsp;</td></tr></table></td></tr>
<tr><td align="center" style="background-color:#111111;padding:26px 30px 0;color:#777777;font-size:10px;line-height:16px;">This email may contain confidential or privileged information intended exclusively for the recipient.</td></tr>
<tr><td align="center" style="background-color:#111111;padding:18px 20px 25px;color:#777777;font-size:10px;line-height:16px;">© 2026 VIICASA. All rights reserved.</td></tr></table></body></html>`;
  const subject=`${demo?'[DEMO VIILIFE]':'ViiLife'} ${audience==='team'?'TEAM · ':''}${quote.large?'LARGE REQUEST · ':''}${event==='unpaid'?'Follow-up needed':title+' · '+status}`;
  return {subject,body,html};
}
