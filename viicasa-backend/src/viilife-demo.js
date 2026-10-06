import nodemailer from 'nodemailer';
import {id,hash,fail} from './lib.js';
import {now,key,must,auditDoc} from './firestore-store.js';
import {defaultCleaningSettings,cleaningPrice,cleaningCoverage} from './cleaning.js';
import * as s from './schemas.js';

// Deliberately independent of checkouts, payments, occupancy and the live mail outbox.
export const demoRecipient='gerson@novaweb-agency.com';
const collection='viilife_demo_requests',mailCollection='viilife_demo_mail';
const days=['sun','mon','tue','wed','thu','fri','sat'];
const safe=row=>{const {guest_id,notes,...result}=row;return result;};
const defaults=()=>({...defaultCleaningSettings(),enabled:true,pricing_confirmed:true,revision:0,max_hours:8,large_hours:3,large_days:3});
export async function demoSettings(store){return {...defaults(),...await store.get('viilife_demo_settings','main')};}
const selection=s.object({service:s.choice(['routine','deep']),frequency:s.choice(['weekly','biweekly']),hours:s.int(1,8),deep_type:s.choice(['moveout','seasonal']),measure:s.choice(['sqft','rooms']),size:s.int(1,100000),full_clean:s.bool,full_clean_sqft:s.int(1,100000),extras:{...s.array(s.choice(['setup','decoration','removals']),3),uniqueItems:true}},['service','full_clean','extras']);
const schedule=s.object({days:{...s.array(s.choice(days),7),minItems:1,uniqueItems:true},start_date:s.date,start_hour:s.int(8,18)});
const quoteBody=s.object({selection,schedule,address:s.address});
const requestBody=s.object({...quoteBody.properties,customer:s.customer,locale:s.choice(['es','en']),settings_revision:s.int()});
export function demoQuote(input,settings,today=now().slice(0,10)){
  const start=new Date(input.schedule.start_date+'T00:00:00Z');
  if(!Number.isFinite(+start)||start.toISOString().slice(0,10)!==input.schedule.start_date||input.schedule.start_date<today||+start>Date.parse(today)+366*86400000)fail(400,'Elige una fecha válida dentro del próximo año / Choose a date within the next year');
  if(!Number.isInteger(input.schedule.start_hour)||input.schedule.start_hour<8||input.schedule.start_hour>18)fail(400,'Horario inválido / Invalid time');
  if(input.selection.service==='routine'&&input.schedule.start_hour+input.selection.hours>20)fail(400,'La visita debe terminar antes de las 20:00 / The visit must end by 20:00');
  if(Object.values(input.address).some(v=>!v.trim()))fail(400,'Completa la dirección / Complete the address');
  const price=cleaningPrice(input.selection,settings,input.schedule),coverage=cleaningCoverage(input.address,settings);
  const dates=Array.from({length:7},(_,i)=>new Date(+start+i*86400000)).filter(d=>input.schedule.days.includes(days[d.getUTCDay()])).map(d=>d.toISOString().slice(0,10));
  const large=input.selection.service==='routine'&&(input.selection.hours>settings.large_hours||input.schedule.days.length>settings.large_days);
  return {...price,revision:settings.revision,coverage,dates,large,can_pay:coverage==='inside',demo:true};
}
function message(row,event,audience){
  const q=row.quote,en=row.locale==='en',amount=(q.total_minor/100).toFixed(2)+' '+q.currency;
  const contact=en?'The ViiLife team will be in touch soon to coordinate the details and your preferred schedule.':'El equipo de ViiLife se pondrá en contacto contigo pronto para coordinar los detalles y tu horario preferido.';
  const headline=event==='paid'?(en?`Thank you for your ViiLife demo order. ${contact} No money was charged and no real visit has been booked.`:`Gracias por tu pedido de prueba de ViiLife. ${contact} No se cobró dinero ni se reservó una visita real.`):event==='unpaid'?'Large request still unpaid after one hour. Follow up; do not assume why the customer stopped.':(en?`We have received your ViiLife demonstration request. ${contact} You can complete the simulated payment immediately, without waiting for our call.`:`Recibimos tu solicitud de demostración de ViiLife. ${contact} Puedes completar el pago simulado sin esperar nuestra llamada.`);
  return {subject:`[DEMO VIILIFE] ${audience==='team'?'TEAM · ':''}${q.large?'LARGE REQUEST · ':''}${event==='paid'?'Payment simulated':event==='unpaid'?'Follow-up needed':'Request received'}`,
    body:`VIILIFE — DEMONSTRATION ONLY\n${headline}\n\n${audience==='customer'?'Customer message preview — delivered only to the test mailbox.\n':''}Reference: ${row.id}\nName: ${row.customer.name}\nCustomer email (not a delivery recipient): ${row.customer.email}\nPhone: ${row.customer.phone}\nService: ${row.selection.service}\n${q.billing.scope==='one_cycle'?`${(q.billing.hourly_minor/100).toFixed(2)} ${q.currency}/h × ${q.billing.hours_per_visit} h × ${q.billing.visits} visits\n`:''}Total: ${amount}\nPreferred dates: ${q.dates.join(', ')}\nPreferred start: ${row.schedule.start_hour}:00 (local time at the property)\nAddress: ${row.address.street}, ${row.address.city}, ${row.address.state}, ${row.address.postal_code}, ${row.address.country}\n\n${en?'The ViiLife team will contact you to coordinate your preferred schedule. This demonstration does not reserve a real visit.':'El equipo de ViiLife se pondrá en contacto para coordinar el horario preferido. Esta demostración no reserva una visita real.'}\nNo subscription or automatic renewal. ${q.estimate_pending.length?'Additional services await a separate estimate.':''}`};
}
async function queue(tx,row,event,audience){
  const mailId=key('viilife-demo-mail',`${row.id}:${event}:${audience}`);
  if(await tx.get(mailCollection,mailId))return;
  tx.create(mailCollection,mailId,{...message(row,event,audience),request_id:row.id,recipient:demoRecipient,state:'pending',created_at:now(),updated_at:now()});
}
export async function createDemoRequest(store,guestId,idem,input){
  if(input.customer.name.trim().length<2||input.customer.phone.trim().length<5)fail(400,'Completa nombre y teléfono / Complete name and phone');
  return store.transaction(async tx=>{
    const guest=must(await tx.get('guests',guestId));if(guest.expires_at<=now())fail(401,'Sesión expirada');
    if(guest.email&&guest.email.toLowerCase()!==input.customer.email.toLowerCase())fail(400,'Usa el correo de tu cuenta');
    const fingerprint=hash(JSON.stringify(input)),index=key('viilife-demo',guestId+':'+idem),previous=await tx.get('viilife_demo_idempotency',index);
    if(previous){if(previous.fingerprint!==fingerprint)fail(409,'Idempotency conflict');return safe(must(await tx.get(collection,previous.request_id)));}
    const settings=await demoSettings(tx);if(settings.revision!==input.settings_revision)fail(409,'La tarifa cambió. Revisa el total / Pricing changed. Review the total');
    const quote=demoQuote(input,settings),stamp=now(),row={...input,id:id(),guest_id:guestId,quote,demo:true,status:quote.can_pay?'awaiting_payment':'outside_area',followup_status:quote.large?'new':'not_required',created_at:stamp,updated_at:stamp,expires_at:new Date(Date.now()+86400000).toISOString()};
    tx.create(collection,row.id,row);tx.create('viilife_demo_idempotency',index,{fingerprint,request_id:row.id});
    await queue(tx,row,'requested','customer');if(quote.large)await queue(tx,row,'requested','team');
    return safe(row);
  });
}
export async function completeDemoRequest(store,guestId,requestId){
  return store.transaction(async tx=>{
    const row=must(await tx.get(collection,requestId));if(row.guest_id!==guestId)fail(404,'No encontrado');
    if(row.status==='demo_paid')return safe(row);
    if(row.status!=='awaiting_payment'||row.expires_at<=now())fail(409,'Esta solicitud ya no admite pago de prueba');
    const updated={...row,status:'demo_paid',updated_at:now()};tx.put(collection,row.id,updated);
    await queue(tx,updated,'paid','customer');await queue(tx,updated,'paid','team');return safe(updated);
  });
}
export function demoMailReady(config){const smtp=config.smtp||{};return config.viilifeDemoMail==='smtp'&&!!smtp.host&&!!smtp.auth?.user&&!!smtp.auth?.pass&&[465,587].includes(smtp.port)&&smtp.secure===(smtp.port===465)&&!!config.mailFrom&&!config.mailFrom.includes('example.com');}
export async function maintainViiLifeDemo(store,config,sender){
  if(config.viilifeMode!=='demo')return;
  // Bounded, deterministic scan. No dependency on catching a browser-close event.
  const pending=await store.list(collection,{where:[['status','==','awaiting_payment']],limit:100});
  for(const candidate of pending){if(!candidate.quote.large||candidate.followup_notified_at||Date.parse(candidate.created_at)>Date.now()-3600000)continue;
    await store.transaction(async tx=>{const row=await tx.get(collection,candidate.id);if(row?.status!=='awaiting_payment'||row.followup_notified_at)return;await queue(tx,row,'unpaid','team');tx.put(collection,row.id,{...row,followup_notified_at:now()});});
  }
  if(!demoMailReady(config)&&!sender)return;
  const jobs=await store.list(mailCollection,{where:[['state','==','pending']],limit:10});
  for(const job of jobs){
    const claimed=await store.transaction(async tx=>{
      const row=await tx.get(mailCollection,job.id);if(!row||row.state!=='pending')return null;
      const request=await tx.get(collection,row.request_id);
      if(row.subject.includes('Follow-up needed')&&request?.status!=='awaiting_payment'){tx.put(mailCollection,row.id,{...row,state:'skipped',updated_at:now()});return null;}
      const limit=await tx.get('viilife_demo_limits','mail'),recent=(limit?.sends||[]).filter(t=>t>Date.now()-86400000);
      if(recent.length>=90)return null;
      tx.put('viilife_demo_limits','mail',{sends:[...recent,Date.now()]});tx.put(mailCollection,row.id,{...row,state:'sending',updated_at:now()});return row;
    });
    if(!claimed)continue;
    let state='sent';
    try{
      if(sender)await sender({...claimed,recipient:demoRecipient});
      else{
        const transport=nodemailer.createTransport({...config.smtp,requireTLS:true,connectionTimeout:8000,greetingTimeout:8000,socketTimeout:12000,disableFileAccess:true,disableUrlAccess:true});
        try{const result=await transport.sendMail({from:config.mailFrom,to:demoRecipient,subject:claimed.subject,text:claimed.body,messageId:`<viilife-demo-${claimed.id}@viicasa.com>`});if(!result.accepted?.length)throw Error('SMTP rejected');}finally{transport.close();}
      }
    }catch{state='unknown';}
    // Uncertain SMTP outcomes are not retried: avoid duplicate messages.
    await store.set(mailCollection,claimed.id,{...claimed,recipient:demoRecipient,state,updated_at:now()});
  }
}
export async function registerViiLifeDemo(app,store,config,guard){
  const enabled=async()=>{if(config.viilifeMode!=='demo')fail(404,'Demo deshabilitada');};
  app.get('/v1/viilife-demo/settings',{preHandler:enabled},async()=>{const settings=await demoSettings(store);return {...settings,demo:true,mail_ready:demoMailReady(config)};});
  app.post('/v1/viilife-demo/quote',{preHandler:enabled,schema:{body:quoteBody}},async r=>demoQuote(r.body,await demoSettings(store)));
  app.post('/v1/viilife-demo/requests',{preHandler:[enabled,guard.guest],schema:{body:requestBody,headers:s.keyHeader},config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async(r,reply)=>{reply.code(201);return createDemoRequest(store,r.guest.id,r.headers['idempotency-key'],r.body);});
  app.get('/v1/viilife-demo/requests',{preHandler:[enabled,guard.guest]},async r=>({items:(await store.list(collection,{where:[['guest_id','==',r.guest.id]],limit:100})).map(safe).sort((a,b)=>b.created_at.localeCompare(a.created_at))}));
  app.get('/v1/viilife-demo/requests/:id',{preHandler:[enabled,guard.guest],schema:{params:s.idParams}},async r=>{const row=must(await store.get(collection,r.params.id));if(row.guest_id!==r.guest.id)fail(404,'No encontrado');return safe(row);});
  app.post('/v1/viilife-demo/requests/:id/pay',{preHandler:[enabled,guard.guest],schema:{params:s.idParams,body:s.object({confirm:{const:true}})},config:{rateLimit:{max:10,timeWindow:'1 minute'}}},r=>completeDemoRequest(store,r.guest.id,r.params.id));
  app.get('/v1/admin/viilife-demo',{preHandler:[enabled,guard.admin(['admin','support','viewer'])]},async()=>({settings:await demoSettings(store),recipient:demoRecipient,mail_ready:demoMailReady(config),items:(await store.list(collection,{order:[['created_at','desc']],limit:100})).map(row=>{const {guest_id,...result}=row;return result;}),mail:await store.list(mailCollection,{order:[['created_at','desc']],limit:30})}));
  app.put('/v1/admin/viilife-demo/settings',{preHandler:[enabled,guard.admin(['admin'])],schema:{body:s.object({revision:s.int(),currency:s.choice(['CAD','USD']),hourly_minor:s.int(1,1000000),large_hours:s.int(1,8),large_days:s.int(1,7)})}},r=>store.transaction(async tx=>{const current=await demoSettings(tx);if(current.revision!==r.body.revision)fail(409,'Recarga la configuración');const updated={...current,...r.body,revision:current.revision+1};tx.put('viilife_demo_settings','main',updated);auditDoc(tx,r.user.id,'viilife.demo.settings','main');return updated;}));
  app.patch('/v1/admin/viilife-demo/requests/:id',{preHandler:[enabled,guard.admin(['admin','support'])],schema:{params:s.idParams,body:s.object({followup_status:s.choice(['new','contacted','completed']),notes:s.str(2000,0)})}},r=>store.transaction(async tx=>{const row=must(await tx.get(collection,r.params.id));tx.put(collection,row.id,{...row,...r.body,updated_at:now()});auditDoc(tx,r.user.id,'viilife.demo.followup',row.id);return {ok:true};}));
}
