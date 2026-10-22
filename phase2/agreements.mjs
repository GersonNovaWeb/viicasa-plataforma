import {randomUUID} from 'node:crypto';
import {fail} from '../viicasa-backend/src/lib.js';
import * as s from '../viicasa-backend/src/schemas.js';
import {audit} from './api.mjs';
import {agreementTerms,snapshotHash,plannedVisits} from './agreement-content.mjs';
import {queueCommercialMail,serviceMail} from './mail.mjs';
import {contractBody,invoiceBody,documentHtml} from './service-documents.mjs';
import {servicePdf,pdfAttachment} from './service-pdf.mjs';
import {recordPaidMeasurement} from './measurement.mjs';
import {pricingTotals} from './pricing-calculation.mjs';
import {invoiceFinance,invoiceWithFinance} from './financial-core.mjs';
import {invoiceCalendar} from './service-time.mjs';
import {guestCustomerSchema,buyerRef,buyerId} from './guest-checkout.mjs';

const one=async(db,sql,args)=>(await db.query(sql,args)).rows[0];
const iso=value=>new Date(value).toISOString().slice(0,10);
const cash=n=>(Number(n)/100).toFixed(2)+' CAD';
const numInvoice=i=>({...i,total_minor:Number(i.total_minor),discount_minor:Number(i.discount_minor),due_date:iso(i.due_date)});
export async function registerAgreements(app,{db,origin,teamGuard,adminGuard,customerGuard,config,gateway,guestAccess}){
  const team='/api/commercial',client='/api/client',contractGuard=guestAccess.documentGuard('contract'),invoiceGuard=guestAccess.documentGuard('invoice');
  const route=(method,url,body,guard,handler)=>app.route({method,url,...(body?{schema:{body}}:{}),preHandler:guard,handler});
  const ownedLead=async(tx,id,user)=>{const lead=await one(tx,'SELECT * FROM crm_leads WHERE id=$1',[id]);if(!lead||user.role!=='admin'&&lead.owner_id!==user.id)fail(404,'Record not found.');return lead;};
  const ownedContract=async(tx,id,user)=>{const c=await one(tx,'SELECT * FROM service_contracts WHERE id=$1 FOR UPDATE',[id]);if(!c)fail(404,'Agreement not found.');await ownedLead(tx,c.lead_id,user);return c;};
  const customerContract=async(tx,id,u,lock=false)=>{const c=await one(tx,'SELECT * FROM service_contracts WHERE id=$1 AND customer_email=$2'+(lock?' FOR UPDATE':''),[id,u.email]);if(!c||c.status==='draft')fail(404,'Agreement not found.');return c;};
  const event=async(tx,c,actor,kind,action,detail={})=>tx.query('INSERT INTO contract_events(id,contract_id,actor_id,actor_kind,action,detail) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),c.id,actor,kind,action,JSON.stringify(detail)]);
  route('POST',client+'/requests',s.object({service:s.choice(['home','commercial']),phone:s.str(30,5),company:s.str(160,0),address:s.str(300,3),sqft:s.int(1,1000000),message:s.str(3000,0),consent:{const:true},idempotency_key:s.uuid,customer:guestCustomerSchema},['service','phone','company','address','sqft','message','consent','idempotency_key']),guestAccess.buyerGuard,async r=>db.transaction(async tx=>{
    const {idempotency_key,customer,...details}=r.body,request_hash=snapshotHash({...details,...(r.customer.guest?{customer:{name:r.customer.name,email:r.customer.email}}:{})});
    await tx.query('SELECT id FROM '+(r.customer.guest?'guest_buyers':'customer_accounts')+' WHERE id=$1 FOR UPDATE',[r.customer.id]);
    const previous=await one(tx,'SELECT * FROM client_service_requests WHERE buyer_ref=$1 AND idempotency_key=$2',[buyerRef(r.customer),idempotency_key]);
    if(previous){if(previous.request_hash!==request_hash)fail(409,'This request key was used for different details.');return{id:previous.id};}
    const admin=await one(tx,"SELECT id FROM team_users WHERE role='admin' AND active AND NOT deleted ORDER BY created_at LIMIT 1",[]);if(!admin)fail(503,'Service enquiries are temporarily unavailable.');
    const id=randomUUID(),leadId=randomUUID();
    await tx.query("INSERT INTO crm_leads(id,owner_id,name,email,phone,company,service,stage,priority,source,notes) VALUES($1,$2,$3,$4,$5,$6,$7,'new','normal','Customer portal',$8)",[leadId,admin.id,r.customer.name,r.customer.email,details.phone,details.company,details.service,`${details.address} · ${details.sqft} sqft\n${details.message}`]);
    await tx.query('INSERT INTO client_service_requests(id,customer_id,buyer_ref,lead_id,idempotency_key,request_hash,details) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,buyerId(r.customer),buyerRef(r.customer),leadId,idempotency_key,request_hash,JSON.stringify(details)]);
    await queueCommercialMail(tx,'request:'+id+':customer',r.customer.email,serviceMail({subject:'Your ViiLife enquiry has been received',title:'We will be in touch',paragraphs:[`Hello ${r.customer.name},`,'The ViiLife team will contact you to discuss your property and prepare your service proposal. No payment has been taken.'],actionUrl:await guestAccess.sqlLink(tx,'enquiry',id,r.customer),actionLabel:r.customer.guest?'View my service request':'Open my VII account'}));
    await queueCommercialMail(tx,'request:'+id+':team',config.adminEmail,serviceMail({subject:'New ViiLife enquiry · team notice',title:'A new service enquiry',paragraphs:['Review and assign the new enquiry in your CRM.'],details:[['Customer',r.customer.name],['Email',r.customer.email],['Service',details.service]],actionUrl:new URL('/equipo',origin).href}));
    await tx.query('INSERT INTO team_notifications(id,user_id,body) VALUES($1,$2,$3)',[randomUUID(),admin.id,'A new client requested a ViiLife '+details.service+' service proposal.']);return{id};
  }));
  route('GET',client+'/requests',null,customerGuard,async r=>({items:(await db.query('SELECT q.id,q.details,q.created_at,l.stage FROM client_service_requests q JOIN crm_leads l ON l.id=q.lead_id WHERE q.customer_id=$1 ORDER BY q.created_at DESC',[r.customer.id])).rows}));
  const contractInput=s.object({quote_id:s.uuid,scope:s.str(3000,3),first_service_date:s.date,arrival_window:s.str(120,3),billing_contact:s.str(160,0),properties:{...s.array(s.object({address:s.str(300,3),type:s.choice(['house','condo','apartment','office','restaurant','multi_unit']),sqft:s.int(1,1000000)}),30),minItems:1}});
  route('GET',team+'/contracts',null,teamGuard,async r=>({items:(await db.query('SELECT c.*,l.name AS client_name FROM service_contracts c JOIN crm_leads l ON l.id=c.lead_id WHERE ($1::boolean OR l.owner_id=$2) ORDER BY c.created_at DESC',[r.teamUser.role==='admin',r.teamUser.id])).rows}));
  route('POST',team+'/contracts',contractInput,teamGuard,async r=>db.transaction(async tx=>{
    const q=await one(tx,'SELECT * FROM service_quotes WHERE id=$1 FOR UPDATE',[r.body.quote_id]);if(!q)fail(404,'Quote not found.');const lead=await ownedLead(tx,q.lead_id,r.teamUser);
    if(q.status!=='approved'||!['home','commercial'].includes(lead.service))fail(409,'Approve a home/commercial quote first.');
    if(lead.service==='home'&&r.body.properties.length!==1)fail(400,'Home agreements describe one property.');
    if(['sqft','sqft_visit'].includes(q.result.basis)&&r.body.properties.reduce((n,p)=>n+p.sqft,0)!==q.result.quantity)fail(409,'The agreement area must match the approved quote.');
    if(q.selection.properties.length&&(q.selection.properties.length!==r.body.properties.length||q.selection.properties.some((p,i)=>p.address!==r.body.properties[i].address||p.sqft!==r.body.properties[i].sqft)))fail(409,'The property schedule must match the approved quote.');
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Vancouver',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    if(r.body.first_service_date<today)fail(400,'Choose a future service date.');
    const seller=await one(tx,'SELECT name FROM team_users WHERE id=$1',[lead.owner_id]);
    const details={first_service_date:r.body.first_service_date,arrival_window:r.body.arrival_window,billing_contact:r.body.billing_contact,properties:r.body.properties};
    const visits=plannedVisits(q.result,details);if(visits.some(v=>v.amount_minor<=0))fail(400,'The quote is too small for the selected schedule.');
    const snapshot={segment:lead.service,customer:{name:lead.name,email:lead.email,phone:lead.phone,company:lead.company},seller_name:seller.name,scope:r.body.scope,details,quote:q.result,quote_revision:q.revision,terms:agreementTerms(lead.service),visits};
    const id=randomUUID();await tx.query('INSERT INTO service_contracts(id,quote_id,lead_id,seller_id,customer_email,snapshot,snapshot_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,q.id,lead.id,lead.owner_id,lead.email.toLowerCase(),JSON.stringify(snapshot),snapshotHash(snapshot)]);
    await audit(tx,r.teamUser.id,'contract.create',id);return{id,status:'draft',snapshot};
  }));
  route('GET',team+'/contracts/:id',null,teamGuard,r=>db.transaction(tx=>ownedContract(tx,r.params.id,r.teamUser)));
  route('GET',team+'/contracts/:id/print',null,teamGuard,async(r,reply)=>{const c=await db.transaction(tx=>ownedContract(tx,r.params.id,r.teamUser));return reply.type('text/html').send(documentHtml('Service agreement',contractBody(c)));});
  const download=async(reply,kind,record)=>reply.type('application/pdf').header('Cache-Control','private, no-store').header('Content-Disposition',`attachment; filename="${pdfAttachment(kind,record).filename}"`).send(await servicePdf(kind,record));
  route('GET',team+'/contracts/:id/pdf',null,teamGuard,async(r,reply)=>download(reply,'contract',await db.transaction(tx=>ownedContract(tx,r.params.id,r.teamUser))));
  route('POST',team+'/contracts/:id/send',s.object({}),teamGuard,async r=>db.transaction(async tx=>{
    const c=await ownedContract(tx,r.params.id,r.teamUser);if(c.status==='sent')return{ok:true};if(c.status!=='draft')fail(409,'This agreement cannot be sent again.');
    await tx.query("UPDATE service_contracts SET status='sent',sent_at=now() WHERE id=$1",[c.id]);
    await queueCommercialMail(tx,'contract:'+c.id+':sent',c.customer_email,{...serviceMail({subject:'Your ViiLife agreement is ready',title:'Your service agreement',paragraphs:[`Hello ${c.snapshot.customer.name},`,'Your service agreement is ready for review. Use the private link in this email to review the schedule, price and terms. No account is required. No payment is taken when you accept it.'],details:[['Service',c.snapshot.quote.service],['Amount for this schedule',cash(c.snapshot.quote.total_minor)]],actionUrl:await guestAccess.documentLink(tx,'contract',c),actionLabel:'Review my agreement'}),attachments:[pdfAttachment('contract',{...c,status:'sent'})]});
    await event(tx,c,r.teamUser.id,'team','sent');await audit(tx,r.teamUser.id,'contract.send',c.id);return{ok:true};
  }));
  route('POST',team+'/contracts/:id/cancel',s.object({reason:s.str(1000,3)}),adminGuard,async r=>db.transaction(async tx=>{
    const c=await ownedContract(tx,r.params.id,r.teamUser);if(c.status==='accepted')fail(409,'An accepted agreement requires the service cancellation workflow.');if(c.status==='cancelled')return{ok:true};
    await tx.query("UPDATE service_contracts SET status='cancelled' WHERE id=$1",[c.id]);await event(tx,c,r.teamUser.id,'team','cancelled',{reason:r.body.reason});return{ok:true};
  }));
  route('GET',client+'/contracts',null,customerGuard,async r=>({items:(await db.query("SELECT * FROM service_contracts WHERE customer_email=$1 AND status<>'draft' ORDER BY created_at DESC",[r.customer.email])).rows}));
  route('GET',client+'/contracts/:id',null,contractGuard,r=>customerContract(db,r.params.id,r.customer));
  route('GET',client+'/contracts/:id/print',null,contractGuard,async(r,reply)=>reply.type('text/html').send(documentHtml('Service agreement',contractBody(await customerContract(db,r.params.id,r.customer)))));
  route('GET',client+'/contracts/:id/pdf',null,contractGuard,async(r,reply)=>download(reply,'contract',await customerContract(db,r.params.id,r.customer)));
  route('POST',client+'/contracts/:id/accept',s.object({snapshot_hash:{type:'string',pattern:'^[a-f0-9]{64}$'},signed_name:s.str(120,2),consent:{const:true},subcontractors:{const:true},access_method:s.choice(['arrival','standing']),photo_marketing_optout:s.bool}),contractGuard,async r=>db.transaction(async tx=>{
    r.body.signed_name=r.body.signed_name.trim();if(r.body.signed_name.length<2)fail(400,'Enter your full name.');
    const c=await customerContract(tx,r.params.id,r.customer,true);
    if(c.snapshot_hash!==r.body.snapshot_hash||snapshotHash(c.snapshot)!==c.snapshot_hash)fail(409,'Agreement changed. Review the current document.');
    if(c.status==='accepted'){if(c.accepted_by!==r.customer.id||['signed_name','access_method','photo_marketing_optout'].some(k=>c.acceptance[k]!==r.body[k]))fail(409,'Acceptance cannot be changed.');return{ok:true};}
    if(c.status!=='sent')fail(409,'This agreement is no longer open for acceptance.');
    const acceptance={signed_name:r.body.signed_name,email:r.customer.email,accepted_at:new Date().toISOString(),access_method:r.body.access_method,photo_marketing_optout:r.body.photo_marketing_optout,subcontractors:true,consent:true,auth_method:r.customer.guest?'private_email_link':'verified_email_account',snapshot_hash:c.snapshot_hash};
    acceptance.evidence_hash=snapshotHash({snapshot:c.snapshot,acceptance});
    await tx.query("UPDATE service_contracts SET status='accepted',accepted_by=$2,acceptance=$3,accepted_at=now() WHERE id=$1",[c.id,r.customer.id,JSON.stringify(acceptance)]);
    for(const v of c.snapshot.visits)await tx.query('INSERT INTO service_visits(id,contract_id,property_index,service_date,arrival_window,address,amount_minor,discount_minor,pricing) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),c.id,v.property_index,v.service_date,v.arrival_window,v.address,v.amount_minor,v.discount_minor,JSON.stringify(v.pricing||{})]);
    await event(tx,c,r.customer.actor_id||r.customer.id,'customer','accepted',acceptance);
    const customerMail=serviceMail({subject:'Your ViiLife agreement has been accepted',title:'Agreement accepted',paragraphs:[`Thank you, ${r.body.signed_name}.`,'Your acceptance and service schedule have been saved. The ViiLife team will contact you to coordinate access and confirm the visit details.'],actionUrl:await guestAccess.documentLink(tx,'contract',c),actionLabel:'Review my agreement'});
    await queueCommercialMail(tx,'contract:'+c.id+':accepted:customer',c.customer_email,{...customerMail,attachments:[pdfAttachment('contract',{...c,status:'accepted',acceptance})]});
    await queueCommercialMail(tx,'contract:'+c.id+':accepted:team',config.adminEmail,serviceMail({subject:'ViiLife agreement accepted · team notice',title:'Client acceptance received',paragraphs:[`${c.snapshot.customer.name} accepted the service agreement. Contact the client to coordinate the scheduled visits.`],details:[['Customer email',c.customer_email],['Agreement',c.id]],actionUrl:new URL('/equipo',origin).href,actionLabel:'Open team workspace'}));
    await tx.query('INSERT INTO team_notifications(id,user_id,body) VALUES($1,$2,$3)',[randomUUID(),c.seller_id,'A client accepted their service agreement. Coordinate the visits.']);return{ok:true};
  }));
  route('POST',client+'/contracts/:id/decline',s.object({reason:s.str(1000,0)}),contractGuard,async r=>db.transaction(async tx=>{
    const c=await customerContract(tx,r.params.id,r.customer,true);if(c.status==='declined')return{ok:true};if(c.status!=='sent')fail(409,'Agreement cannot be declined at this stage.');
    await tx.query("UPDATE service_contracts SET status='declined' WHERE id=$1",[c.id]);await event(tx,c,r.customer.actor_id||r.customer.id,'customer','declined',r.body);await tx.query('INSERT INTO team_notifications(id,user_id,body) VALUES($1,$2,$3)',[randomUUID(),c.seller_id,'A client requested a different agreement. Review the prospect.']);return{ok:true};
  }));
  route('GET',team+'/visits',null,teamGuard,async r=>({items:(await db.query('SELECT v.*,l.name AS client_name FROM service_visits v JOIN service_contracts c ON c.id=v.contract_id JOIN crm_leads l ON l.id=c.lead_id WHERE ($1::boolean OR l.owner_id=$2) ORDER BY v.service_date,v.id',[r.teamUser.role==='admin',r.teamUser.id])).rows.map(v=>({...v,service_date:iso(v.service_date),amount_minor:Number(v.amount_minor),discount_minor:Number(v.discount_minor)}))}));
  route('POST',team+'/visits/:id/status',s.object({status:s.choice(['completed','missed','cancelled'])}),adminGuard,async r=>db.transaction(async tx=>{
    const v=await one(tx,'SELECT * FROM service_visits WHERE id=$1 FOR UPDATE',[r.params.id]);if(!v)fail(404,'Visit not found.');
    const c=await ownedContract(tx,v.contract_id,r.teamUser);
    if(c.status!=='accepted'){
      const plan=await one(tx,'SELECT effective_date FROM service_termination_plans WHERE contract_id=$1',[c.id]);
      if(!c.acceptance||!plan||iso(v.service_date)>=iso(plan.effective_date))fail(409,'Agreement is not active for this visit.');
    }
    if(v.status===r.body.status)return{ok:true};if(v.status!=='scheduled'||v.invoice_id)fail(409,'This visit has already been settled.');
    await tx.query('UPDATE service_visits SET status=$2,completed_at=now() WHERE id=$1',[v.id,r.body.status]);await audit(tx,r.teamUser.id,'visit.'+r.body.status,v.id);return{ok:true};
  }));
  route('GET',client+'/visits',null,customerGuard,async r=>({items:(await db.query('SELECT v.* FROM service_visits v JOIN service_contracts c ON c.id=v.contract_id WHERE c.customer_email=$1 ORDER BY v.service_date',[r.customer.email])).rows.map(v=>({...v,service_date:iso(v.service_date),amount_minor:Number(v.amount_minor)}))}));
  route('POST',team+'/invoices',s.object({contract_id:s.uuid,period:{type:'string',pattern:'^\\d{4}-(0[1-9]|1[0-2])$'},visit_id:s.uuid},['contract_id','period']),adminGuard,async r=>db.transaction(async tx=>{
    const c=await ownedContract(tx,r.body.contract_id,r.teamUser);if(c.status!=='accepted'&&!(c.status==='cancelled'&&c.acceptance))fail(409,'Accept the agreement before billing.');
    const commercial=c.snapshot.segment==='commercial';
    if(!commercial&&!r.body.visit_id||commercial&&r.body.visit_id)fail(400,'Home invoices are per visit; commercial invoices consolidate the period.');
    if(commercial&&(await tx.query("SELECT 1 FROM service_visits WHERE contract_id=$1 AND status='scheduled' AND to_char(service_date,'YYYY-MM')=$2 LIMIT 1",[c.id,r.body.period])).rows.length)fail(409,'Complete or cancel scheduled visits before consolidating this month.');
    const visits=(await tx.query("SELECT * FROM service_visits WHERE contract_id=$1 AND status IN ('completed','missed') AND invoice_id IS NULL AND to_char(service_date,'YYYY-MM')=$2 AND ($3::uuid IS NULL OR id=$3::uuid) ORDER BY service_date FOR UPDATE",[c.id,r.body.period,r.body.visit_id||null])).rows;
    if(!visits.length)fail(409,'There are no uninvoiced billable visits in this period.');
    const total=visits.reduce((n,v)=>n+Number(v.amount_minor),0),discount=visits.reduce((n,v)=>n+Number(v.discount_minor),0),id=randomUUID();
    const calendar=invoiceCalendar(c.snapshot.segment);
    const snapshot={customer:c.snapshot.customer,payment_terms:c.snapshot.segment==='commercial'?'Net 15':'Due on completion',exclusions:c.snapshot.quote.exclusions,lines:visits.map(v=>({visit_id:v.id,date:iso(v.service_date),address:v.address,service:c.snapshot.quote.service,amount_minor:Number(v.amount_minor),discount_minor:Number(v.discount_minor),...(v.pricing?.amount_minor!==undefined?{pricing:v.pricing}:{})}))};
    if(c.snapshot.quote.pricing?.status==='applied'){
      if(visits.some(v=>{
        const original=c.snapshot.quote.pricing.rows.find(row=>row.property_index===v.property_index&&row.visit_index===v.pricing?.visit_index);
        return !original||snapshotHash(original)!==snapshotHash(v.pricing)||Number(v.pricing.amount_minor)!==Number(v.amount_minor)||Number(v.pricing.discount_minor)!==Number(v.discount_minor);
      }))fail(409,'Priced visit details need review before invoicing.');
      snapshot.pricing={policy_revision:c.snapshot.quote.pricing.policy_revision,rows:visits.map(v=>v.pricing),totals:pricingTotals(visits.map(v=>v.pricing))};
    }
    const number='VII-DEMO-'+r.body.period+'-'+id.slice(0,8).toUpperCase();
    await tx.query('INSERT INTO service_invoices(id,contract_id,number,customer_email,total_minor,discount_minor,period,snapshot,due_date,segment) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,c.id,number,c.customer_email,total,discount,r.body.period,JSON.stringify(snapshot),calendar.due_date,c.snapshot.segment]);
    for(const v of visits)await tx.query('UPDATE service_visits SET invoice_id=$2 WHERE id=$1',[v.id,id]);
    const invoice=await one(tx,'SELECT * FROM service_invoices WHERE id=$1',[id]);
    await queueCommercialMail(tx,'invoice:'+id+':issued',c.customer_email,{...serviceMail({subject:'Your ViiLife service invoice',title:'Your service invoice is ready',paragraphs:[`Hello ${c.snapshot.customer.name},`,'Your service invoice is available using the private link below. No account is required.'],details:[['Invoice',number],['Amount',cash(total)],['Due date',calendar.due_date]],actionUrl:await guestAccess.documentLink(tx,'invoice',invoice),actionLabel:'View my invoice'}),attachments:[pdfAttachment('invoice',invoice)]});
    await audit(tx,r.teamUser.id,'invoice.issue',id,{calendar});return{id,number,total_minor:total,due_date:calendar.due_date};
  }));
  const teamInvoice=async(tx,id,u)=>{const i=await one(tx,'SELECT * FROM service_invoices WHERE id=$1',[id]);if(!i)fail(404,'Invoice not found.');await ownedContract(tx,i.contract_id,u);return invoiceWithFinance(tx,i);};
  const clientInvoice=async(tx,id,u)=>{const i=await one(tx,'SELECT * FROM service_invoices WHERE id=$1 AND customer_email=$2',[id,u.email]);if(!i)fail(404,'Invoice not found.');return invoiceWithFinance(tx,i);};
  route('GET',team+'/invoices',null,teamGuard,async r=>({items:await Promise.all((await db.query('SELECT i.* FROM service_invoices i JOIN service_contracts c ON c.id=i.contract_id JOIN crm_leads l ON l.id=c.lead_id WHERE ($1::boolean OR l.owner_id=$2) ORDER BY i.issued_at DESC',[r.teamUser.role==='admin',r.teamUser.id])).rows.map(async i=>numInvoice(await invoiceWithFinance(db,i))))}));
  route('GET',client+'/invoices',null,customerGuard,async r=>({items:await Promise.all((await db.query('SELECT * FROM service_invoices WHERE customer_email=$1 ORDER BY issued_at DESC',[r.customer.email])).rows.map(async i=>numInvoice(await invoiceWithFinance(db,i))))}));
  route('GET',team+'/invoices/:id/print',null,teamGuard,async(r,reply)=>{const i=await db.transaction(tx=>teamInvoice(tx,r.params.id,r.teamUser));return reply.type('text/html').send(documentHtml(i.number,invoiceBody(i)));});
  route('GET',client+'/invoices/:id/print',null,invoiceGuard,async(r,reply)=>reply.type('text/html').send(documentHtml('Service invoice',invoiceBody(await clientInvoice(db,r.params.id,r.customer)))));
  route('GET',team+'/invoices/:id/pdf',null,teamGuard,async(r,reply)=>download(reply,'invoice',await db.transaction(tx=>teamInvoice(tx,r.params.id,r.teamUser))));
  route('GET',client+'/invoices/:id/pdf',null,invoiceGuard,async(r,reply)=>download(reply,'invoice',await clientInvoice(db,r.params.id,r.customer)));
  route('POST',client+'/invoices/:id/payment',s.object({}),invoiceGuard,async r=>{
    const result=await db.transaction(async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(73182008)');
      const i=await one(tx,'SELECT * FROM service_invoices WHERE id=$1 AND customer_email=$2 FOR UPDATE',[r.params.id,r.customer.email]);if(!i)fail(404,'Invoice not found.');if(i.status!=='issued')fail(409,'Invoice no longer accepts payments.');
      if(await one(tx,"SELECT id FROM stripe_collection_operations WHERE invoice_id=$1 AND status NOT IN ('failed','paid','cancelled')",[i.id]))fail(409,'Resolve the submitted automatic payment before starting a separate checkout.');
      const finance=await invoiceFinance(tx,i);if(finance.reserved_credit_minor)fail(409,'An approved credit is awaiting processing. Contact the team before paying.');if(finance.due_minor<=0)fail(409,'This invoice has no outstanding balance.');
      const existing=await one(tx,"SELECT * FROM service_invoice_payments WHERE invoice_id=$1 AND provider=$2 AND status IN ('creating','open') AND expires_at>now() ORDER BY created_at DESC LIMIT 1",[i.id,gateway.provider]);
      if(existing)return{payment:existing,invoice:i};
      const payment={id:randomUUID(),invoice_id:i.id,provider:gateway.provider,amount_minor:finance.due_minor,currency:'CAD',expires_at:new Date(Date.now()+35*60000).toISOString()};
      await tx.query("INSERT INTO service_invoice_payments(id,invoice_id,provider,status,amount_minor,currency,expires_at) VALUES($1,$2,$3,'creating',$4,'CAD',$5)",[payment.id,i.id,payment.provider,payment.amount_minor,payment.expires_at]);return{payment,invoice:i};
    });
    if(result.payment.reference)return{provider:gateway.provider,checkout_url:result.payment.checkout_url};
    let session;try{session=await gateway.create(result.payment,{...result.invoice,...(r.customer.guest?{guest_checkout:true}:{})});}catch{fail(502,'Unable to prepare payment. Retry the same invoice.');}
    await db.query("UPDATE service_invoice_payments SET reference=$2,checkout_url=$3,status=CASE WHEN status='creating' THEN 'open' ELSE status END WHERE id=$1",[result.payment.id,session.reference,session.url]);return{provider:gateway.provider,checkout_url:session.url};
  });
  route('POST',team+'/invoices/:id/simulate-payment',s.object({}),adminGuard,async r=>{
    if(gateway.provider!=='demo')fail(409,'Use the Stripe test checkout and webhook.');
    await db.transaction(tx=>teamInvoice(tx,r.params.id,r.teamUser));
    const p=await one(db,"SELECT * FROM service_invoice_payments WHERE invoice_id=$1 AND (status='paid' OR (status='open' AND expires_at>now())) ORDER BY created_at DESC LIMIT 1",[r.params.id]);if(!p)fail(409,'The customer must prepare a current payment first.');
    return settleInvoicePayment(db,config,origin,{id:'demo:'+p.id,reference:p.reference,outcome:'paid',amount:Number(p.amount_minor),currency:p.currency});
  });
  return{settleInvoice:event=>settleInvoicePayment(db,config,origin,event)};
}

export async function settleInvoicePayment(db,config,origin,event){
  const result=await db.transaction(tx=>settleInvoiceInTransaction(tx,config,origin,event));
  if(event.outcome==='paid')try{
    const row=await one(db,"SELECT i.id,p.amount_minor FROM service_invoice_payments p JOIN service_invoices i ON i.id=p.invoice_id WHERE p.reference=$1 AND p.status='paid' AND i.status='paid' AND i.invoice_kind='service'",[event.reference]);
    if(row)await recordPaidMeasurement(db,{reference:'invoice:'+row.id,section:'viilife',amountMinor:Number(row.amount_minor)});
  }catch{/* Optional analytics cannot invalidate a committed payment. */}
  return result;
}

// Reuse the same settlement atomically with local recurring attempt/audit records.
export async function settleInvoiceInTransaction(tx,config,origin,event){
    await tx.query('SELECT pg_advisory_xact_lock(73182008)');
    const p=await one(tx,'SELECT * FROM service_invoice_payments WHERE reference=$1 FOR UPDATE',[event.reference]);if(!p)fail(503,'Payment is not yet identified. Retry the webhook.');
    if(!['paid','failed','expired'].includes(event.outcome)||event.amount!==Number(p.amount_minor)||event.currency.toUpperCase()!==p.currency)fail(409,'Payment does not match this invoice.');
    const previous=await one(tx,'SELECT * FROM service_payment_events WHERE event_id=$1',[event.id]);if(previous){if(previous.payment_id!==p.id||previous.outcome!==event.outcome)fail(409,'Conflicting payment event.');return{received:true,duplicate:true};}
    await tx.query('INSERT INTO service_payment_events(event_id,payment_id,outcome) VALUES($1,$2,$3)',[event.id,p.id,event.outcome]);
    if(p.status==='paid')return{received:true};
    await tx.query('UPDATE service_invoice_payments SET status=$2,payment_intent_reference=COALESCE($3,payment_intent_reference) WHERE id=$1',[p.id,event.outcome==='paid'?'paid':event.outcome,event.intent_reference||null]);
    if(event.outcome!=='paid')return{received:true};
    const i=await one(tx,'SELECT * FROM service_invoices WHERE id=$1 FOR UPDATE',[p.invoice_id]),c=await one(tx,'SELECT * FROM service_contracts WHERE id=$1',[i.contract_id]);
    const finance=await invoiceFinance(tx,i);
    if(i.status!=='issued'||finance.net_total_minor!==Number(p.amount_minor)){
      await tx.query("UPDATE service_invoices SET status='payment_review' WHERE id=$1",[i.id]);
      await queueCommercialMail(tx,'invoice:'+i.id+':extra-payment:'+p.id,config.adminEmail,serviceMail({subject:'Invoice payment needs review',title:'Payment review required',paragraphs:['A payment was received against an invoice that was no longer awaiting payment. Review the payment before making adjustments.'],details:[['Invoice',i.number]],actionUrl:new URL('/equipo',origin).href}));return{received:true,review:true};
    }
    await tx.query("UPDATE service_invoices SET status='paid',paid_at=now() WHERE id=$1",[i.id]);
    await tx.query("UPDATE commercial_mail SET status='cancelled' WHERE status IN ('pending','failed') AND dedupe LIKE $1",['invoice-reminder:'+i.id+':%']);
    const amount=Number(p.amount_minor);
    if(i.invoice_kind!=='closing'){
      const rule=await one(tx,'SELECT * FROM commission_rules WHERE service=$1',[c.snapshot.segment]),commission=Math.floor((amount*rule.basis_points+5000)/10000);
      await tx.query("INSERT INTO commercial_sales(id,lead_id,seller_id,reference,amount_minor,currency,status,basis_points,commission_minor,commission_status,service_invoice_id) VALUES($1,$2,$3,$4,$5,'CAD','paid',$6,$7,'pending',$8) ON CONFLICT(reference) DO NOTHING",[randomUUID(),c.lead_id,c.seller_id,i.number,amount,rule.basis_points,commission,i.id]);
      const recordedSale=await one(tx,'SELECT service_invoice_id FROM commercial_sales WHERE reference=$1',[i.number]);
      if(recordedSale?.service_invoice_id!==i.id)await audit(tx,null,'commission.invoice_link_review',i.id,{reference:i.number});
    }
    const paidInvoice=await invoiceWithFinance(tx,await one(tx,'SELECT * FROM service_invoices WHERE id=$1',[i.id]));
    await queueCommercialMail(tx,'invoice:'+i.id+':paid:customer',i.customer_email,{...serviceMail({subject:'Your ViiLife payment confirmation',title:'Payment recorded',paragraphs:[`Thank you, ${i.snapshot.customer.name}.`,'Your payment has been recorded in the Phase 2 test environment. View your invoice using the private link below. No account is required.'],details:[['Invoice',i.number],['Amount',cash(amount)]],actionUrl:config.guestDocumentLink?await config.guestDocumentLink(tx,'invoice',i):new URL('/cliente?invoice='+i.id,origin).href,actionLabel:'View my invoice'}),attachments:[pdfAttachment('invoice',paidInvoice)]});
    await queueCommercialMail(tx,'invoice:'+i.id+':paid:team',config.adminEmail,serviceMail({subject:'ViiLife payment recorded · team notice',title:'Service invoice paid',paragraphs:['A service invoice was paid.'],details:[['Customer',i.customer_email],['Invoice',i.number],['Amount',cash(amount)]],actionUrl:new URL('/equipo',origin).href}));
    await audit(tx,null,'invoice.paid',i.id);return{received:true};
}
