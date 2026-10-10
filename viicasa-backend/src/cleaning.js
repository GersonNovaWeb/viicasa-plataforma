import {id,hash,fail,money} from './lib.js';
import {now,afterMinutes,key,must,auditDoc} from './firestore-store.js';
import {enqueue,safeCheckout} from './firestore-commerce.js';
import * as s from './schemas.js';
import {approvalNotice,reviewViiLifeRequest} from './viilife-approval.js';

export const focusRooms=['bedroom','bathroom','living','dining','kitchen','entrance','office','studio','hallway','patio'];
export const visitExtras=['setup','decoration','removals'];
const customerRequest=row=>{const {guest_id,notes,...safe}=row;return safe;};
const unique=(values,min=0,max=30)=>({...s.array(s.choice(values),max),uniqueItems:true,minItems:min});
export const cleaningSelection=s.object({
  service:s.choice(['routine','deep']),frequency:s.choice(['weekly','biweekly']),hours:s.int(1,3),
  deep_type:s.choice(['moveout','seasonal']),measure:s.choice(['sqft','rooms']),size:s.int(1,100000),
  full_clean:s.bool,full_clean_sqft:s.int(1,100000),extras:unique(visitExtras),
},['service','extras','full_clean']);
const cleaningSchedule=s.object({days:unique(['mon','tue','wed','thu','fri','sat','sun'],1,7),window:s.choice(['morning','afternoon','evening'])});
export const cleaningQuoteBody=s.object({selection:cleaningSelection,address:s.address,schedule:cleaningSchedule});
export const cleaningRequestBody=s.object({selection:cleaningSelection,address:s.address,customer:s.customer,
  schedule:cleaningSchedule,
  focus:unique(focusRooms,1,10),locale:s.choice(['es','en']),marketing:s.bool,settings_revision:s.int(),pricing_version:{type:'integer',const:2}});
const prefix={type:'string',pattern:'^[A-Z0-9]{3,10}$'};
export const cleaningSettingsBody=s.object({revision:s.int(),enabled:s.bool,pricing_confirmed:s.bool,currency:s.choice(['CAD','USD']),
  country:{type:'string',pattern:'^[A-Z]{2}$'},coverage_mode:s.choice(['country','postal']),postal_prefixes:{...s.array(prefix,300),uniqueItems:true},
  hourly_minor:s.int(1,1000000),deep_base_minor:s.int(1,10000000),deep_sqft_included:s.int(1,100000),deep_sqft_extra_minor:s.int(1,100000),
  deep_rooms_included:s.int(1,100),deep_room_extra_minor:s.int(1,1000000),full_base_minor:s.int(1,10000000),full_sqft_included:s.int(1,100000),full_sqft_extra_minor:s.int(1,100000),
  terms_es:s.str(3000),terms_en:s.str(3000)});
export function defaultCleaningSettings(){return {revision:0,enabled:false,pricing_confirmed:false,currency:'CAD',country:'CA',coverage_mode:'country',postal_prefixes:[],
  hourly_minor:9999,deep_base_minor:35000,deep_sqft_included:700,deep_sqft_extra_minor:25,deep_rooms_included:3,deep_room_extra_minor:7500,
  full_base_minor:100000,full_sqft_included:500,full_sqft_extra_minor:100,
  terms_es:'Horario solicitado sujeto a confirmación. Limpieza rutinaria: una visita por día seleccionado en un ciclo semanal o quincenal, sin duplicar días en la quincena. Limpieza profunda: una visita. Sin renovación automática. Los extras de visita se cotizan aparte. Condiciones e impuestos pendientes de aprobación.',
  terms_en:'Requested schedule is subject to confirmation. Routine cleaning: one visit per selected day in one weekly or two-week cycle, without doubling days in the two-week cycle. Deep cleaning: one visit. No automatic renewal. In-person extras are quoted separately. Terms and taxes pending approval.'};}
export const getCleaningSettings=async store=>{
  const saved=await store.get('cleaning_settings','main');if(!saved)return defaultCleaningSettings();
  // Upgrade only our old defaults; never replace administrator-written terms.
  const defaults=defaultCleaningSettings(),row={...saved};
  if(row.terms_es==='Horario solicitado sujeto a confirmación. Pago por una visita; no es una suscripción. Los extras de visita se cotizan aparte. Condiciones e impuestos pendientes de aprobación.')row.terms_es=defaults.terms_es;
  if(row.terms_en==='Requested schedule is subject to confirmation. Payment covers one visit, not a subscription. In-person extras are quoted separately. Terms and taxes pending approval.')row.terms_en=defaults.terms_en;
  return row;
};
export async function saveCleaningSettings(store,input,actor){return store.transaction(async tx=>{
  const old=await getCleaningSettings(tx);if(old.revision!==input.revision)fail(409,'La configuración cambió. Recarga antes de guardar.');
  if(input.enabled&&(!input.pricing_confirmed||(input.coverage_mode==='postal'&&!input.postal_prefixes.length)))fail(400,'Confirma precios, moneda y cobertura antes de habilitar cobros.');
  const row={...input,revision:old.revision+1};tx.put('cleaning_settings','main',row);auditDoc(tx,actor,'cleaning.settings', 'main');return row;
});}
export function cleaningPrice(selection,settings,schedule){
  const line=(code,amount)=>({code,amount_minor:money(amount)}),lines=[];
  let billing={scope:'one_visit',visits:1};
  if(selection.service==='routine'){
    if(!['weekly','biweekly'].includes(selection.frequency)||!Number.isInteger(selection.hours)||selection.hours<1||selection.hours>(settings.max_hours||3))fail(400,'Selecciona frecuencia y duración.');
    if(selection.deep_type||selection.measure||selection.size!==undefined||selection.full_clean||selection.extras.length||selection.full_clean_sqft!==undefined)fail(400,'Los extras solo corresponden a limpieza de mudanza.');
    const days=schedule?.days;
    if(!Array.isArray(days)||!days.length||days.length>7||new Set(days).size!==days.length||days.some(d=>!['mon','tue','wed','thu','fri','sat','sun'].includes(d)))fail(400,'Selecciona días de visita válidos, sin duplicados.');
    billing={scope:'one_cycle',cycle:selection.frequency,visits:days.length,hours_per_visit:selection.hours,hourly_minor:settings.hourly_minor,total_hours:selection.hours*days.length};
    lines.push(line('routine',billing.total_hours*settings.hourly_minor));
  }else{
    if(!['moveout','seasonal'].includes(selection.deep_type)||!['sqft','rooms'].includes(selection.measure)||!Number.isInteger(selection.size)||selection.size<1||selection.size>100000||selection.frequency||selection.hours!==undefined)fail(400,'Selecciona el tipo y una medida válida.');
    if(selection.measure==='rooms'&&selection.size>100)fail(400,'Máximo 100 habitaciones.');
    const included=selection.measure==='sqft'?settings.deep_sqft_included:settings.deep_rooms_included;
    const rate=selection.measure==='sqft'?settings.deep_sqft_extra_minor:settings.deep_room_extra_minor;
    lines.push(line('deep',settings.deep_base_minor+Math.max(0,selection.size-included)*rate));
    if(selection.deep_type!=='moveout'&&(selection.full_clean||selection.extras.length||selection.full_clean_sqft!==undefined))fail(400,'Los extras solo corresponden a limpieza de mudanza.');
    if(selection.full_clean){
      const area=selection.full_clean_sqft;if(!Number.isInteger(area)||area<1||area>100000)fail(400,'Indica el área de limpieza completa.');
      lines.push(line('full_clean',settings.full_base_minor+Math.max(0,area-settings.full_sqft_included)*settings.full_sqft_extra_minor));
    }else if(selection.full_clean_sqft!==undefined)fail(400,'El área extra requiere limpieza completa.');
  }
  return {lines,total_minor:money(lines.reduce((sum,l)=>sum+l.amount_minor,0)),currency:settings.currency,estimate_pending:selection.extras,billing,pricing_version:2};
}
export function cleaningCoverage(address,settings){
  const postal=address.postal_code.replace(/[ -]/g,'').toUpperCase();
  if(!/^[A-Z0-9]{3,10}$/.test(postal))fail(400,'Código postal inválido.');
  if(address.country.toUpperCase()==='CA'&&!/^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/.test(postal))fail(400,'Código postal canadiense inválido.');
  if(settings.coverage_mode==='country')return address.country.toUpperCase()===settings.country?'inside':'outside';
  if(!settings.postal_prefixes.length)return 'unconfigured';
  return address.country.toUpperCase()===settings.country&&settings.postal_prefixes.some(p=>postal.startsWith(p))?'inside':'outside';
}
export async function quoteCleaning(store,input){
  if(Object.values(input.address).some(value=>!value.trim())||!input.address.street.trim()||!input.address.city.trim())fail(400,'Completa la dirección.');
  const settings=await getCleaningSettings(store),price=cleaningPrice(input.selection,settings,input.schedule),coverage=cleaningCoverage(input.address,settings);
  return {...price,coverage,revision:settings.revision,can_pay:coverage==='inside'&&settings.enabled&&settings.pricing_confirmed,pricing_confirmed:settings.pricing_confirmed,terms:{es:settings.terms_es,en:settings.terms_en}};
}
export async function createCleaningRequest(store,config,guestId,idempotencyKey,input,quoteRequest=quoteCleaning){
  if(config.viilifeMode==='demo')fail(409,'ViiLife está en demostración; no admite operaciones reales.');
  if(input.pricing_version!==2)fail(409,'El cálculo cambió. Recarga y revisa el total antes de pagar.');
  if(input.customer.name.trim().length<2||input.customer.phone.trim().length<5)fail(400,'Completa nombre y teléfono.');
  return store.transaction(async tx=>{
    const guest=must(await tx.get('guests',guestId));if(guest.expires_at<=now())fail(401,'Sesión expirada');
    // Reuse the verified social account. Never create a login from an unverified typed email.
    if(config.production&&!(guest.firebase_uid||guest.google_uid))fail(401,'Inicia sesión para registrar tu solicitud de limpieza.');
    if(guest.email&&guest.email.toLowerCase()!==input.customer.email.toLowerCase())fail(400,'Usa el correo de tu cuenta.');
    const requestHash=hash(JSON.stringify(input)),index=key('cleaning-request',`${guestId}:${idempotencyKey}`),existing=await tx.get('cleaning_idempotency',index);
    if(existing){if(existing.request_hash!==requestHash)fail(409,'La clave de solicitud ya se usó con otros datos.');return {request:customerRequest(must(await tx.get('cleaning_requests',existing.request_id))),checkout:existing.checkout_id?safeCheckout(must(await tx.get('checkouts',existing.checkout_id))):null};}
    const quote=await quoteRequest(tx,input),settings=await getCleaningSettings(tx),quick=quoteRequest!==quoteCleaning;
    if(input.settings_revision!==settings.revision)fail(409,'Las tarifas o cobertura cambiaron. Revisa la cotización de nuevo.');
    if(config.viilifeMode==='live'&&settings.currency!=='CAD')fail(409,'Configura las tarifas de ViiLife en CAD antes de continuar.');
    if(quote.coverage==='inside'&&!quote.can_pay)fail(503,'El servicio todavía no admite pagos.');
    const products=quote.coverage==='outside'?await tx.list('products',{where:[['published','==',true],['archived','==',false]],limit:3}):[];
    const timestamp=now(),rid=id(),checkoutId=quote.can_pay?id():null;
    const needsApproval=Boolean(quick&&checkoutId&&quote.large);
    const detail={...input,quote,terms:input.locale==='en'?settings.terms_en:settings.terms_es,payment_scope:quote.billing.scope,schedule_status:'requested',followup_status:input.selection.extras.length?'estimate_pending':'not_required'};
    const request={id:rid,guest_id:guestId,...detail,...(quick?{flow:'quick',followup_status:quote.large?'new':detail.followup_status}:{}),status:checkoutId?'awaiting_payment':quote.coverage==='outside'?'outside_area':'coverage_review',checkout_id:checkoutId,created_at:timestamp};
    let checkout=null;
    if(checkoutId){
      checkout={id:checkoutId,guest_id:guestId,request_hash:requestHash,idempotency_key:idempotencyKey,kind:'cleaning',status:'pending',customer_name:input.customer.name,
        customer_email:input.customer.email.toLowerCase(),customer_phone:input.customer.phone,total_minor:quote.total_minor,due_minor:quote.total_minor,currency:quote.currency,
        detail:{...detail,cleaning_request_id:rid,property_name:'ViiLife · Home cleaning',consent:true,consent_recorded_at:timestamp},created_at:timestamp,expires_at:afterMinutes(config.holdMinutes)};
      if(needsApproval){
        checkout={...checkout,status:'awaiting_approval',expires_at:null,approval:{status:'pending',requested_at:timestamp}};
        request.status='awaiting_approval';
      }
      tx.create('checkouts',checkoutId,checkout);
    }
    tx.create('cleaning_requests',rid,request);tx.create('cleaning_idempotency',index,{request_id:rid,checkout_id:checkoutId,request_hash:requestHash});
    if(needsApproval)await approvalNotice(tx,checkout,'approval_requested',config);
    // Consent is explicit and editable from the customer's account; no cs_* writes.
    if(!quick)tx.put('cleaning_preferences',guestId,{marketing:input.marketing,email:input.customer.email.toLowerCase(),recorded_at:timestamp});
    // Approval requests have their own notices above. Payment receipts are
    // queued only after Stripe confirms payment through its signed webhook.
    if(!checkoutId){
      const english=input.locale==='en',outside=quote.coverage==='outside';
      if(!quick)await enqueue(tx,`cleaning:${rid}:admin`,config.adminEmail,'ViiLife · '+request.status,JSON.stringify(detail,null,2));
      const body=outside?(english?"We're sorry, this address is outside our service area. Discover ViiShop: ":'Lo sentimos, esta dirección está fuera de nuestra zona de servicio. Descubre ViiShop: '):(english?'We received your request. Coverage needs review; no payment was taken. ':'Recibimos tu solicitud. La cobertura requiere revisión; no se ha cobrado. ');
      const site=config.siteUrl.replace(/\/$/,'');
      const suggestions=products.map(p=>`${p.name}\n${site}/shop/${encodeURIComponent(p.slug)}`).join('\n\n');
      await enqueue(tx,`cleaning:${rid}:customer`,input.customer.email,english?'ViiLife · Your request':'ViiLife · Tu solicitud',body+site+'/shop'+(suggestions?'\n\n'+suggestions:''));
    }
    return {request:customerRequest(request),checkout:checkout?safeCheckout(checkout):null};
  });
}
export async function registerCleaning(app,store,config,guard){
  app.post('/v1/admin/cleaning/requests/:id/review',{preHandler:guard.admin(['admin']),schema:{params:s.idParams,body:s.object({action:s.choice(['contact','approve','cancel']),contacted:s.bool,notes:s.str(2000,0)},['action'])}},r=>reviewViiLifeRequest(store,config,r.params.id,r.user.id,r.body));
  app.get('/v1/cleaning/settings',async()=>getCleaningSettings(store));
  app.post('/v1/cleaning/quote',{schema:{body:cleaningQuoteBody}},r=>quoteCleaning(store,r.body));
  app.post('/v1/cleaning/requests',{preHandler:guard.guest,schema:{body:cleaningRequestBody,headers:s.keyHeader},config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(r,reply)=>{const result=await createCleaningRequest(store,config,r.guest.id,r.headers['idempotency-key'],r.body);reply.code(201);return result;});
  app.get('/v1/cleaning/preferences',{preHandler:guard.guest},async r=>({marketing:(await store.get('cleaning_preferences',r.guest.id))?.marketing===true}));
  app.put('/v1/cleaning/preferences',{preHandler:guard.guest,schema:{body:s.object({marketing:s.bool})}},async r=>store.transaction(async tx=>{const old=await tx.get('cleaning_preferences',r.guest.id);tx.put('cleaning_preferences',r.guest.id,{...old,marketing:r.body.marketing,recorded_at:now()});return {marketing:r.body.marketing};}));
  app.get('/v1/admin/cleaning/settings',{preHandler:guard.admin(['admin'])},()=>getCleaningSettings(store));
  app.put('/v1/admin/cleaning/settings',{preHandler:guard.admin(['admin']),schema:{body:cleaningSettingsBody}},r=>{if(config.viilifeMode==='live'&&r.body.currency!=='CAD')fail(400,'La moneda aprobada para ViiLife es CAD.');return saveCleaningSettings(store,r.body,r.user.id);});
  app.get('/v1/admin/cleaning/requests',{preHandler:guard.admin(['admin','support','viewer']),schema:{querystring:s.object({cursor:s.uuid},[])}},async r=>{
    const rows=await store.list('cleaning_requests',{order:[['__name__','asc']],limit:51,...(r.query.cursor?{cursor:[r.query.cursor]}:{})});
    const items=await Promise.all(rows.slice(0,50).map(async row=>{const {guest_id,...safe}=row;const checkout=row.checkout_id?await store.get('checkouts',row.checkout_id):null;const preferences=await store.get('cleaning_preferences',guest_id);const payment=row.checkout_id?await store.get('payments',row.checkout_id):null;return {...safe,current_marketing:preferences?.marketing===true,payment_status:checkout?.status||null,approval:checkout?.approval||null,payment_started:Boolean(payment),amount_paid:payment?.status==='paid'};}));
    return {items,next_cursor:rows.length>50?items.at(-1).id:null};
  });
  app.patch('/v1/admin/cleaning/requests/:id',{preHandler:guard.admin(['admin','support']),schema:{params:s.idParams,body:s.object({followup_status:s.choice(['estimate_pending','contacted','visit_scheduled','completed']),notes:s.str(2000,0)})}},async r=>store.transaction(async tx=>{
    const row=must(await tx.get('cleaning_requests',r.params.id));
    const checkout=row.checkout_id&&await tx.get('checkouts',row.checkout_id);
    const payment=row.checkout_id&&await tx.get('payments',row.checkout_id);
    if(payment?.status!=='paid'||!['confirmed','payment_review'].includes(checkout?.status))fail(409,'Primero debe confirmarse el pago.');
    tx.put('cleaning_requests',row.id,{...row,...r.body});auditDoc(tx,r.user.id,'cleaning.followup',row.id);return {ok:true};
  }));
}
