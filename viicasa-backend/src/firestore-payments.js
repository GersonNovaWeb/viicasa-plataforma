import nodemailer from 'nodemailer';
import {id,fail} from './lib.js';
import {now,afterMinutes,key,must,auditDoc} from './firestore-store.js';
import {updateOccupancy,release,notice} from './firestore-commerce.js';
import {publicPayment} from './payments.js';

export async function startPayment(store,config,gateway,guestId,checkoutId){
  if(config.paymentProvider==='disabled')fail(503,'La pasarela de pagos aún no está configurada');
  const {payment,checkout}=await store.transaction(async tx=>{
    const c=must(await tx.get('checkouts',checkoutId),'Operación no encontrada');
    if(c.guest_id!==guestId)fail(404,'Operación no encontrada');
    if(c.status!=='pending'||c.expires_at<=now())fail(409,'La operación ya no admite pagos');
    let p=await tx.get('payments',c.id);
    if(p){
      if(p.provider!==config.paymentProvider)fail(409,'Esta operación pertenece a otra pasarela');
      if(p.expires_at<=now())fail(409,'El intento de pago venció; crea una nueva operación');
      if(p.status==='failed'&&p.provider==='demo'){p={...p,status:'open'};tx.put('payments',p.id,p);}
      return{payment:p,checkout:c};
    }
    const paymentExpiry=gateway.provider==='stripe'?afterMinutes(35):c.expires_at;
    const holdExpiry=gateway.provider==='stripe'?afterMinutes(37):c.expires_at;
    if(!await updateOccupancy(tx,c,'pending',holdExpiry))fail(409,'Las fechas de esta reserva ya no están retenidas');
    // Recheck wall-clock time after occupancy reads; a retried transaction must not revive an expired hold.
    if(c.expires_at<=now())fail(409,'La retención venció');
    p={id:c.id,checkout_id:c.id,provider:gateway.provider,status:'creating',amount_minor:c.due_minor,currency:c.currency,
      expires_at:paymentExpiry,created_at:now(),reference:null,checkout_url:null};
    tx.put('checkouts',c.id,{...c,expires_at:holdExpiry});tx.create('payments',p.id,p);
    return{payment:p,checkout:c};
  });
  if(payment.reference)return publicPayment(payment);
  let session;
  try{session=await gateway.create(payment,checkout);}catch(error){
    if(error.statusCode)throw error;fail(502,'No se pudo iniciar el pago; reintenta sobre esta misma operación');
  }
  return store.transaction(async tx=>{
    const p=must(await tx.get('payments',payment.id)),referenceKey=key('payment-reference',`${p.provider}:${session.reference}`);
    const previous=await tx.get('payment_references',referenceKey);
    if(previous && previous.payment_id!==p.id)fail(409,'Referencia de pago en conflicto');
    const updated={...p,reference:session.reference,checkout_url:session.url,status:p.status==='creating'?'open':p.status};
    tx.put('payments',p.id,updated);tx.put('payment_references',referenceKey,{payment_id:p.id});return publicPayment(updated);
  });
}
export async function settlePayment(store,config,event){
  return store.transaction(async tx=>{
    const reference=await tx.get('payment_references',key('payment-reference',`${event.provider}:${event.reference}`));
    if(!reference)fail(503,'Pago aún no identificado; reintentar webhook');
    const p=must(await tx.get('payments',reference.payment_id)),c=must(await tx.get('checkouts',p.checkout_id));
    const eventKey=key('payment-event',`${event.provider}:${event.id}`),previous=await tx.get('payment_events',eventKey);
    if(previous){
      if(previous.payment_id!==p.id||previous.outcome!==event.outcome)fail(409,'Evento de pago inconsistente');
      return{received:true,duplicate:true};
    }
    if(event.amount!==p.amount_minor||event.currency.toUpperCase()!==p.currency)fail(409,'El importe o la moneda no coinciden con el pago');
    if(!['paid','failed','expired'].includes(event.outcome))fail(400,'Estado de pago inválido');
    tx.create('payment_events',eventKey,{provider:event.provider,event_id:event.id,payment_id:p.id,outcome:event.outcome,created_at:now()});
    if(p.status==='paid')return{received:true,ignored:true};
    if(event.outcome==='paid'){
      tx.put('payments',p.id,{...p,status:'paid'});
      const canConfirm=c.status==='pending'&&c.expires_at>now()&&await updateOccupancy(tx,c,'confirmed');
      if(canConfirm && c.expires_at>now()){
        tx.put('checkouts',c.id,{...c,status:'confirmed'});await notice(tx,c,'confirmado',config);
      }else{
        await release(tx,c,'expired');tx.put('checkouts',c.id,{...c,status:'payment_review'});
        await notice(tx,c,'pago recibido en revisión',config);
      }
    }else if(event.outcome==='expired'){
      tx.put('payments',p.id,{...p,status:'expired'});await release(tx,c,'expired');await notice(tx,c,'pago vencido',config);
    }else{
      tx.put('payments',p.id,{...p,status:'failed'});await notice(tx,c,'pago rechazado',config);
    }
    auditDoc(tx,null,`payment.${event.outcome}`,p.id,{provider:event.provider,event_id:event.id});return{received:true};
  });
}
export async function stripeWebhook(store,config,gateway,raw,signature){
  const event=gateway.verify(raw,signature),session=event.data.object;
  const outcome={'checkout.session.completed':'paid','checkout.session.async_payment_succeeded':'paid',
    'checkout.session.expired':'expired','checkout.session.async_payment_failed':'failed'}[event.type];
  if(!outcome || (outcome==='paid'&&session.payment_status!=='paid'))return{received:true,ignored:true};
  return settlePayment(store,config,{provider:'stripe',id:event.id,reference:session.id,outcome,amount:session.amount_total,currency:session.currency||''});
}
export async function deliverMail(store,config,transport){
  if(config.mailMode!=='smtp')return{mode:'outbox',sent:0};
  const mailer=transport||nodemailer.createTransport({...config.smtp,connectionTimeout:10000,socketTimeout:30000});
  let sent=0,failed=0;
  try{
    // next_attempt doubles as a lease deadline while processing; no whole-collection scans.
    const candidates=await store.list('mail_outbox',{where:[['status','in',['pending','processing']],['next_attempt','<=',now()]],order:[['next_attempt','asc']],limit:50});
    for(const candidate of candidates){
      const message=await store.transaction(async tx=>{
        const row=await tx.get('mail_outbox',candidate.id);
        if(!row||!['pending','processing'].includes(row.status)||row.next_attempt>now())return null;
        if(row.attempts>=10){tx.put('mail_outbox',row.id,{...row,status:'failed'});return null;}
        const updated={...row,status:'processing',attempts:row.attempts+1,next_attempt:afterMinutes(2),lease_token:id()};
        tx.put('mail_outbox',row.id,updated);return updated;
      });if(!message)continue;
      let success=false;
      try{await mailer.sendMail({from:config.mailFrom,to:message.recipient,subject:message.subject,text:message.body,messageId:`<${message.id}@viicasa.mail>`});success=true;}catch{}
      await store.transaction(async tx=>{
        const current=await tx.get('mail_outbox',message.id);if(!current||current.lease_token!==message.lease_token)return;
        tx.put('mail_outbox',message.id,{...current,status:success?'sent':current.attempts>=10?'failed':'pending',
          sent_at:success?now():null,last_error:success?null:'SMTP delivery failed',lease_token:null,
          next_attempt:success?current.next_attempt:afterMinutes(Math.min(60,2**current.attempts))});
      });if(success)sent++;else failed++;
    }
  }finally{if(!transport&&mailer.close)mailer.close();}
  return{mode:'smtp',sent,failed};
}
