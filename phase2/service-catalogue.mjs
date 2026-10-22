import {randomUUID} from 'node:crypto';
import {fail} from '../viicasa-backend/src/lib.js';
import * as s from '../viicasa-backend/src/schemas.js';
import {audit} from './api.mjs';
import {snapshotHash} from './agreement-content.mjs';
import {queueCommercialMail,serviceMail} from './mail.mjs';
import {catalogueFamilies,catalogueServices,cataloguePackages} from './service-catalogue-data.mjs';
import {guestCustomerSchema,buyerRef,buyerId} from './guest-checkout.mjs';

const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const slug={...s.slug,maxLength:80},languages=(schema)=>s.object({es:schema,en:schema});
const channels=s.array(s.choice(['viilife','viiconcierge']),2),modes=s.array(s.choice(['once','recurring','quote']),3);
const nullable=schema=>({anyOf:[schema,{type:'null'}]});
export const catalogueFields={
  family:s.choice(catalogueFamilies.map(f=>f.id)),name:languages(s.str(160,2)),concierge_name:languages(s.str(160,2)),
  description:languages(s.str(4000,0)),includes:languages(s.array(s.str(300),12)),channels,modes,
  pricing:s.object({kind:s.choice(['fixed','quote']),amount_minor:nullable(s.int(1,99999999)),basis:s.choice(['service','hour','visit','load','item']),currency:{const:'CAD'}}),
  images:s.array(s.str(2000),10),published:s.bool,archived:s.bool,sort_order:s.int(0,10000)
};
const view=row=>({...row.content,id:row.id,revision:row.revision});
export function validateCatalogue(input,id){
  const base=catalogueServices.find(x=>x.id===id);
  if(!input.channels.length||new Set(input.channels).size!==input.channels.length||!input.modes.length||new Set(input.modes).size!==input.modes.length)fail(400,'Choose unique channels and booking options.');
  if(base&&(input.channels.some(c=>!base.channels.includes(c))||input.modes.some(m=>!base.modes.includes(m))))fail(400,'This option is not offered for this service in the approved catalogue.');
  if(Object.values(input.name).some(x=>!x.trim())||Object.values(input.concierge_name).some(x=>!x.trim()))fail(400,'Service names cannot be blank.');
  const p=input.pricing;
  if(p.kind==='fixed'&&(p.amount_minor===null||input.modes.every(x=>x==='quote'))||p.kind==='quote'&&p.amount_minor!==null)fail(400,'Set a positive CAD price or leave the amount empty for a quotation.');
  if(new Set(input.images).size!==input.images.length)fail(400,'Do not repeat gallery images.');
  for(const image of input.images){
    if(/^\/v1\/media\/[a-f0-9]{8}-[a-f0-9-]{27}$/.test(image)||/^\/assets\/[a-zA-Z0-9._-]+$/.test(image))continue;
    let u;try{u=new URL(image);}catch{fail(400,'Use an uploaded image or a public HTTPS image URL.');}
    if(u.protocol!=='https:'||u.username||u.password||/[\s\\<>"']/.test(image))fail(400,'Use an uploaded image or a public HTTPS image URL.');
  }
  if(input.archived&&input.published)fail(400,'An archived service cannot be published.');
  if(input.published&&(!input.images.length||Object.values(input.description).some(x=>!x.trim())))fail(400,'Add a cover image and descriptions in English and Spanish before publishing.');
}
export function estimateCatalogue(service,{mode,quantity}){
  if(!service.modes.includes(mode))fail(400,'This booking option is not available.');
  if(!Number.isSafeInteger(quantity)||quantity<1||quantity>1000)fail(400,'Invalid service quantity.');
  const amount=mode==='quote'||service.pricing.kind==='quote'?null:service.pricing.amount_minor*quantity;
  if(amount!==null&&(!Number.isSafeInteger(amount)||amount>99999999))fail(400,'Request exceeds the supported estimate.');
  return{currency:'CAD',unit_minor:amount===null?null:service.pricing.amount_minor,quantity,basis:service.pricing.basis,total_minor:amount,estimate:true,automatic_subscription:false};
}
export async function registerServiceCatalogue(app,{db,store,adminGuard,customerGuard,config,origin,guestAccess}){
  await db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(73182022)');
    for(const {id,...content} of catalogueServices)await tx.query('INSERT INTO service_catalogue(id,content) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',[id,JSON.stringify(content)]);
  });
  const list=async()=> (await db.query('SELECT * FROM service_catalogue ORDER BY (content->>\'sort_order\')::integer,id')).rows.map(view);
  const get=async(tx,id,lock=false)=>{const row=await one(tx,'SELECT * FROM service_catalogue WHERE id=$1'+(lock?' FOR UPDATE':''),[id]);if(!row)fail(404,'Service not found.');return view(row);};
  const publicItem=async(tx,id)=>{const item=await get(tx,id);if(!item.published||item.archived)fail(404,'Service not found.');return item;};
  const params={type:'object',properties:{id:slug},required:['id'],additionalProperties:false};
  app.get('/api/commercial/service-catalogue',{preHandler:adminGuard},async()=>({items:await list(),families:catalogueFamilies,packages:cataloguePackages,definitions:catalogueServices.map(({id,modes,channels})=>({id,modes,channels})),currency:'CAD'}));
  const save=async r=>db.transaction(async tx=>{
    const creating=r.method==='POST',id=creating?r.body.id:r.params.id,{revision,...fields}=r.body;
    delete fields.id;validateCatalogue(fields,id);
    for(const image of fields.images)if(image.startsWith('/v1/media/')&&!await store.get('media',image.split('/').at(-1)))fail(400,'An uploaded image no longer exists.');
    if(creating){if(await one(tx,'SELECT id FROM service_catalogue WHERE id=$1',[id]))fail(409,'That service identifier already exists.');await tx.query('INSERT INTO service_catalogue(id,content) VALUES($1,$2)',[id,JSON.stringify(fields)]);}
    else{const old=await get(tx,id,true);if(old.revision!==revision)fail(409,'This service changed. Refresh before saving.');await tx.query('UPDATE service_catalogue SET content=$2,revision=revision+1,updated_at=now() WHERE id=$1',[id,JSON.stringify(fields)]);}
    await audit(tx,r.teamUser.id,creating?'catalogue.create':'catalogue.update',id,{revision:creating?1:revision+1,published:fields.published,archived:fields.archived,pricing:fields.pricing});return get(tx,id);
  });
  app.post('/api/commercial/service-catalogue',{schema:{body:s.object({id:slug,...catalogueFields})},preHandler:adminGuard},save);
  app.put('/api/commercial/service-catalogue/:id',{schema:{params,body:s.object({revision:s.int(1),...catalogueFields})},preHandler:adminGuard},save);
  app.get('/api/service-catalogue',{schema:{querystring:s.object({channel:s.choice(['viilife','viiconcierge'])},[])}},async r=>{
    const channel=r.query.channel,items=(await list()).filter(x=>x.published&&!x.archived&&(!channel||x.channels.includes(channel)));
    const visibleIds=new Set(items.map(x=>x.id));
    // Do not advertise a bundle with a missing base or a single surviving item.
    const packages=cataloguePackages.filter(p=>(!channel||p.channels.includes(channel))&&visibleIds.has(p.services[0])).map(p=>({...p,services:p.services.filter(id=>visibleIds.has(id))})).filter(p=>p.services.length>1);
    return{items,families:catalogueFamilies,packages,currency:'CAD'};
  });
  app.get('/api/service-catalogue/:id',{schema:{params}},async r=>publicItem(db,r.params.id));
  const requestBody=s.object({service_id:slug,revision:s.int(1),channel:s.choice(['viilife','viiconcierge']),mode:s.choice(['once','recurring','quote']),quantity:s.int(1,1000),phone:s.str(30,5),address:s.str(300,3),message:s.str(3000,0),consent:{const:true},idempotency_key:s.uuid,customer:guestCustomerSchema},['service_id','revision','channel','mode','quantity','phone','address','message','consent','idempotency_key']);
  app.post('/api/client/service-catalogue/requests',{schema:{body:requestBody},preHandler:guestAccess.buyerGuard,config:{rateLimit:{max:15,timeWindow:'5 minutes'}}},r=>db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(73182022)');
    const {idempotency_key,customer,...input}=r.body,request_hash=snapshotHash({...input,...(r.customer.guest?{customer:{name:r.customer.name,email:r.customer.email}}:{})}),prior=await one(tx,'SELECT * FROM client_service_requests WHERE buyer_ref=$1 AND idempotency_key=$2',[buyerRef(r.customer),idempotency_key]);
    if(prior){if(prior.request_hash!==request_hash)fail(409,'This request key was already used for different details.');return{id:prior.id,estimate:prior.details.estimate};}
    const service=await publicItem(tx,input.service_id);
    if(service.revision!==input.revision)fail(409,'The service changed. Reload and review the current details.');
    if(!service.channels.includes(input.channel))fail(400,'This service is not offered in that channel.');
    const estimate=estimateCatalogue(service,input),name=input.channel==='viiconcierge'?service.concierge_name:service.name;
    const admin=await one(tx,"SELECT id FROM team_users WHERE role='admin' AND active AND NOT deleted ORDER BY created_at,id LIMIT 1");if(!admin)fail(503,'Service requests are temporarily unavailable.');
    const id=randomUUID(),leadId=randomUUID(),details={...input,service:input.channel==='viiconcierge'?'concierge':'home',catalogue:{...service},estimate};
    await tx.query("INSERT INTO crm_leads(id,owner_id,name,email,phone,company,service,stage,priority,source,notes) VALUES($1,$2,$3,$4,$5,'',$6,'new','normal','Service catalogue',$7)",[leadId,admin.id,r.customer.name,r.customer.email,input.phone,details.service,`${name.en}\n${input.address}\n${input.mode} · ${input.quantity} ${service.pricing.basis}\n${estimate.total_minor===null?'Quotation requested':(estimate.total_minor/100).toFixed(2)+' CAD · estimate, not a payment'}\n${input.message}`]);
    await tx.query('INSERT INTO client_service_requests(id,customer_id,buyer_ref,lead_id,idempotency_key,request_hash,details) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,buyerId(r.customer),buyerRef(r.customer),leadId,idempotency_key,request_hash,JSON.stringify(details)]);
    const actionUrl=await guestAccess.sqlLink(tx,'enquiry',id,r.customer);
    await queueCommercialMail(tx,'catalogue:'+id+':customer',r.customer.email,serviceMail({subject:`Your ${input.channel==='viiconcierge'?'ViiConcierge':'ViiLife'} service request`,title:'We have received your request',paragraphs:[`Hello ${r.customer.name},`,`The VII team will contact you about ${name.en}. No payment has been taken. A recurring request does not create an automatic subscription.`],details:[['Service',name.en],['Reference',id]],actionUrl,actionLabel:r.customer.guest?'View my service request':'Open my VII account'}));
    await queueCommercialMail(tx,'catalogue:'+id+':team',config.adminEmail,serviceMail({subject:'New service catalogue request',title:'A new service enquiry',paragraphs:['Review the enquiry and contact the customer from the CRM.'],details:[['Customer',r.customer.name],['Email',r.customer.email],['Phone',input.phone],['Service',name.en]],actionUrl:new URL('/admin',origin).href}));
    await tx.query('INSERT INTO team_notifications(id,user_id,body) VALUES($1,$2,$3)',[randomUUID(),admin.id,'New service catalogue request: '+name.en]);
    return{id,estimate};
  }));
}
