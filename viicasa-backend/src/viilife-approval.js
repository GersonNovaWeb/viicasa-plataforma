import {fail} from './lib.js';
import {now,afterMinutes,must,auditDoc} from './firestore-store.js';
import {enqueue} from './firestore-commerce.js';
import {renderViiLifeMail} from './viilife-mail.js';

export async function approvalNotice(tx,checkout,event,config){
  const audiences=event==='approval_requested'?['customer','team']:['customer'];
  for(const audience of audiences){
    const actionUrl=new URL(audience==='team'?'/admin':'/cuenta#viilife-orders',config.siteUrl).href;
    const mail=renderViiLifeMail({reference:checkout.id,issuedAt:now(),customer:{name:checkout.customer_name,email:checkout.customer_email,phone:checkout.customer_phone},...checkout.detail,event,audience,actionUrl});
    await enqueue(tx,`viilife-approval:${checkout.id}:${event}:${audience}`,audience==='team'?config.adminEmail:checkout.customer_email,mail.subject,mail.body,mail.html);
  }
}

// Approval never charges a card, changes prices, or marks an order as paid.
export async function reviewViiLifeRequest(store,config,requestId,actor,input){
  return store.transaction(async tx=>{
    const row=must(await tx.get('cleaning_requests',requestId));
    if(input.action==='contact'){
      const contacted=input.contacted===true;
      tx.put('cleaning_requests',row.id,{...row,contacted,contacted_at:contacted?now():null,contacted_by:actor,notes:input.notes??row.notes??''});
      auditDoc(tx,actor,'cleaning.contact',row.id,{contacted});return {ok:true};
    }
    const c=must(row.checkout_id&&await tx.get('checkouts',row.checkout_id),'No hay solicitud de pago');
    const payment=await tx.get('payments',c.id);
    if(payment?.status==='paid'||['confirmed','payment_review'].includes(c.status))fail(409,'El pedido ya tiene un pago. No se puede aprobar ni cancelar desde este control.');
    if(input.action==='approve'&&c.approval?.status==='approved'&&c.status==='pending')return {ok:true,status:c.status};
    if(input.action==='cancel'&&c.status==='cancelled')return {ok:true,status:c.status};
    // Existing Checkout sessions must not remain payable after a local cancellation.
    if(payment)fail(409,'Ya existe un intento de pago en Stripe. Revisa su estado antes de cancelar o aprobar.');
    if(!['awaiting_approval','pending'].includes(c.status))fail(409,'Este pedido ya no admite cambios de pago.');
    if(input.action==='approve'){
      if(c.status!=='awaiting_approval'||c.approval?.status!=='pending')fail(409,'Este pedido no requiere aprobación.');
      if((c.detail.quote.dates||[]).some(date=>date<now().slice(0,10)))fail(409,'Las fechas solicitadas ya pasaron. Solicita un nuevo pedido con fechas vigentes.');
      const updated={...c,status:'pending',expires_at:afterMinutes(24*60),approval:{...c.approval,status:'approved',reviewed_at:now(),reviewed_by:actor}};
      tx.put('checkouts',c.id,updated);tx.put('cleaning_requests',row.id,{...row,status:'awaiting_payment'});
      await approvalNotice(tx,updated,'payment_ready',config);
      auditDoc(tx,actor,'cleaning.payment_approved',row.id);return {ok:true,status:updated.status};
    }
    if(input.action!=='cancel')fail(400,'Acción inválida');
    const updated={...c,status:'cancelled',approval:{...c.approval,status:'cancelled',reviewed_at:now(),reviewed_by:actor}};
    tx.put('checkouts',c.id,updated);tx.put('cleaning_requests',row.id,{...row,status:'cancelled'});
    await approvalNotice(tx,updated,'request_cancelled',config);
    auditDoc(tx,actor,'cleaning.payment_cancelled',row.id);return {ok:true,status:updated.status};
  });
}
