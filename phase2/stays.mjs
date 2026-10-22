import {randomUUID} from 'node:crypto';
import {fail} from '../viicasa-backend/src/lib.js';
import * as s from '../viicasa-backend/src/schemas.js';
import {audit} from './api.mjs';
import {snapshotHash} from './agreement-content.mjs';
import {brandedMail} from '../viicasa-backend/src/platform-mail.js';
import {queueCommercialMail} from './mail.mjs';
import {dateOnly,validStayDate,localStayTime,stayLocalDay,timezoneFormatter} from './stay-time.mjs';

const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const unitSchema=s.object({name:s.str(160,2),address:s.str(300,3),timezone:s.str(80,3),capacity:s.int(1,100),checkin_time:s.str(5,5),checkout_time:s.str(5,5),arrival_message:s.str(3000,0),departure_message:s.str(3000,0),active:s.bool});
export const stayEventSchema=s.object({provider:s.choice(['demo','lodgify','airbnb']),event_id:s.str(160,1),external_reference:s.str(160,1),source_revision:s.int(1),event:s.choice(['confirmed','modified','cancelled']),unit_id:s.uuid,guest_name:s.str(120,2),guest_email:s.email,guests:s.int(1,100),checkin_date:s.date,checkout_date:s.date});
const safeReservation=r=>({...r,checkin_date:dateOnly(r.checkin_date),checkout_date:dateOnly(r.checkout_date),source:r.verified_external?'verified_external':'demo',payment_verified:false});
const activity=(tx,id,actor,action,detail={})=>tx.query('INSERT INTO stay_activity(id,reservation_id,actor_id,action,detail) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,actor||null,action,JSON.stringify(detail)]);
const reservationEvidence=r=>({...r,checkin_date:dateOnly(r.checkin_date),checkout_date:dateOnly(r.checkout_date),checkin_at:new Date(r.checkin_at).toISOString(),checkout_at:new Date(r.checkout_at).toISOString(),created_at:new Date(r.created_at).toISOString(),updated_at:new Date(r.updated_at).toISOString()});
const stayLock=tx=>tx.query('SELECT pg_advisory_xact_lock(73182010)');
function validateEvent(e){
  if(!e||typeof e!=='object'||Array.isArray(e)||Object.keys(e).some(k=>!Object.hasOwn(stayEventSchema.properties,k))||Object.keys(stayEventSchema.properties).some(k=>!Object.hasOwn(e,k)))fail(400,'Invalid normalised reservation event.');
  if(!['demo','lodgify','airbnb'].includes(e.provider)||!['confirmed','modified','cancelled'].includes(e.event)||!Number.isInteger(e.source_revision)||e.source_revision<1||e.source_revision>99999999||!Number.isInteger(e.guests)||e.guests<1||e.guests>100||!/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(e.unit_id))fail(400,'Invalid normalised reservation identifiers.');
  for(const [key,max,min]of [['guest_name',120,2],['guest_email',254,3],['event_id',160,1],['external_reference',160,1]])if(typeof e[key]!=='string'||e[key].length>max||e[key].trim().length<min)fail(400,'Invalid normalised reservation details.');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.guest_email))fail(400,'Invalid guest email.');validStayDate(e.checkin_date);validStayDate(e.checkout_date);if(e.checkout_date<=e.checkin_date)fail(400,'Checkout must be after check-in.');
}

export async function seedStayUnits(db){
  await db.query("INSERT INTO stay_units(id,name,address,timezone,capacity,checkin_time,checkout_time,arrival_message,departure_message,demo_key) VALUES($1,'Demo - Okanagan Retreat','100 Demonstration Street, Kelowna, BC','America/Vancouver',4,'16:00','11:00','The team will coordinate your arrival. No access code is included in this demonstration.','Please leave the property tidy and contact the team if you need assistance.','phase2-stay-okanagan') ON CONFLICT(demo_key) DO NOTHING",[randomUUID()]);
}

// Trusted internal boundary for future provider adapters. An HTTP signature must
// be verified by the adapter BEFORE calling this function. No public webhook is
// exposed here. Normalised provider events must be full reservation snapshots.
export async function ingestStayEvent(db,event,{actorId,authenticatedSource='admin_demo',now=new Date(),mailApproved=false}={}){
  validateEvent(event);
  if(!['admin_demo','verified_adapter'].includes(authenticatedSource))fail(403,'Reservation source is not verified.');
  if(authenticatedSource==='admin_demo'&&!actorId)fail(403,'Demo events require an administrator.');
  return db.transaction(async tx=>{await stayLock(tx);return applyStayEvent(tx,event,{actorId,authenticatedSource,now,mailApproved});});
}
async function applyStayEvent(tx,event,{actorId,authenticatedSource='admin_demo',now=new Date(),review,mailApproved=false}={}){
    const payloadHash=snapshotHash(event);
    // Serialise events for the unit and all existing reservations: prevents double
    // bookings even when two distinct provider events arrive concurrently.
    const unit=await one(tx,'SELECT * FROM stay_units WHERE id=$1 FOR UPDATE',[event.unit_id]);if(!unit)fail(404,'Stay unit not found.');
    const oldEvent=await one(tx,'SELECT * FROM stay_event_inbox WHERE provider=$1 AND external_event_id=$2',[event.provider,event.event_id]);if(oldEvent&&!review){if(oldEvent.payload_hash!==payloadHash)fail(409,'Provider event ID was reused for different data.');return{...oldEvent.result,duplicate:true};}
    const prior=await one(tx,'SELECT * FROM stay_reservations WHERE provider=$1 AND external_reference=$2 FOR UPDATE',[event.provider,event.external_reference]);
    if(prior?.verified_external&&authenticatedSource==='admin_demo')fail(409,'Externally verified reservations cannot be changed through simulation tools.');
    const inboxId=randomUUID(),saveEvent=async(status,result)=>{if(review)return result;await tx.query('INSERT INTO stay_event_inbox(id,provider,external_event_id,payload_hash,payload,reservation_id,status,result,authenticated_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[inboxId,event.provider,event.event_id,payloadHash,JSON.stringify(event),prior?.id||result.id||null,status,JSON.stringify(result),authenticatedSource]);return result;};
    const needReview=async reason=>{
      const id=randomUUID(),original=reservationEvidence(prior),result={rejected:true,requires_review:true,reason,id:prior.id,review_id:id};
      await saveEvent('rejected',result);await tx.query('INSERT INTO stay_reviews(id,event_id,reservation_id,reason,original,original_hash,target_unit_revision) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,inboxId,prior.id,reason,JSON.stringify(original),snapshotHash(original),unit.revision]);
      await activity(tx,prior.id,actorId,'review.requested',{review_id:id,reason,event_id:event.event_id,proposed:event});return result;
    };
    if(prior&&event.source_revision<=prior.source_revision)return saveEvent('ignored',{ignored:true,reason:'stale_revision',id:prior.id});
    if(!prior&&event.event!=='confirmed')return saveEvent('rejected',{rejected:true,reason:'reservation_not_found'});
    if(prior&&event.event==='confirmed')return saveEvent('rejected',{rejected:true,reason:'existing_reservation_requires_modified_event',id:prior.id});
    if(prior?.status==='cancelled'&&event.event!=='cancelled')return saveEvent('rejected',{rejected:true,reason:'cancelled_reservation_requires_new_reference',id:prior.id});
    if(prior?.status==='cancelled')return saveEvent('ignored',{ignored:true,reason:'already_cancelled',id:prior.id});
    if(prior&&(prior.status==='checked_out'||new Date(prior.checkout_at)<=now))return saveEvent('rejected',{rejected:true,reason:'stay_already_ended',id:prior.id});
    if(prior&&event.event==='cancelled'&&event.unit_id!==prior.unit_id)return saveEvent('rejected',{rejected:true,reason:'cancellation_unit_mismatch',id:prior.id});
    if(prior&&!review&&event.unit_id!==prior.unit_id)return needReview('unit_change_requires_review');
    if(prior&&!review&&(prior.status==='checked_in'||new Date(prior.checkin_at)<=now))return needReview('stay_already_started');
    validStayDate(event.checkin_date);validStayDate(event.checkout_date);
    if(event.checkout_date<=event.checkin_date)fail(400,'Checkout must be after check-in.');
    const id=prior?.id||randomUUID(),revision=(prior?.revision||0)+1,status=event.event==='cancelled'?'cancelled':prior?.status==='checked_in'?'checked_in':'confirmed';
    let checkinAt=prior?.checkin_at,checkoutAt=prior?.checkout_at;
    if(status!=='cancelled'){
      if(!unit.active||event.guests>unit.capacity)return saveEvent('rejected',{rejected:true,reason:'unit_inactive_or_capacity_exceeded',...(prior?{id:prior.id}:{})});
      checkinAt=localStayTime(event.checkin_date,unit.checkin_time,unit.timezone);checkoutAt=localStayTime(event.checkout_date,unit.checkout_time,unit.timezone);
      if(new Date(checkoutAt)<=now)return saveEvent('rejected',{rejected:true,reason:'stay_already_ended',...(prior?{id:prior.id}:{})});
      if(status==='checked_in'&&new Date(checkinAt)>now)return saveEvent('rejected',{rejected:true,reason:'checked_in_date_in_future',id:prior.id});
      const overlap=await one(tx,"SELECT id FROM stay_reservations WHERE unit_id=$1 AND status IN ('confirmed','checked_in') AND checkin_date<$3::date AND checkout_date>$2::date AND id<>$4::uuid",[unit.id,event.checkin_date,event.checkout_date,id]);
      if(overlap)return saveEvent('rejected',{rejected:true,reason:'availability_conflict',...(prior?{id:prior.id}:{})});
    }
    const unitSnapshot={name:unit.name,address:unit.address,timezone:unit.timezone,checkin_time:unit.checkin_time,checkout_time:unit.checkout_time,arrival_message:unit.arrival_message,departure_message:unit.departure_message};
    if(!prior)await tx.query("INSERT INTO stay_reservations(id,unit_id,unit_snapshot,provider,external_reference,source_revision,guest_name,guest_email,guests,checkin_date,checkout_date,checkin_at,checkout_at,status,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",[id,unit.id,JSON.stringify(unitSnapshot),event.provider,event.external_reference,event.source_revision,event.guest_name,event.guest_email.toLowerCase(),event.guests,event.checkin_date,event.checkout_date,checkinAt,checkoutAt,status,revision]);
    else if(status==='cancelled')await tx.query("UPDATE stay_reservations SET status='cancelled',source_revision=$2,revision=$3,updated_at=now() WHERE id=$1",[id,event.source_revision,revision]);
    else await tx.query('UPDATE stay_reservations SET unit_snapshot=$2,source_revision=$3,guest_name=$4,guest_email=$5,guests=$6,checkin_date=$7,checkout_date=$8,checkin_at=$9,checkout_at=$10,status=$11,revision=$12,unit_id=$13,updated_at=now() WHERE id=$1',[id,JSON.stringify(unitSnapshot),event.source_revision,event.guest_name,event.guest_email.toLowerCase(),event.guests,event.checkin_date,event.checkout_date,checkinAt,checkoutAt,status,revision,unit.id]);
    if(authenticatedSource==='verified_adapter')await tx.query('UPDATE stay_reservations SET verified_external=true,delivery_scope=$2 WHERE id=$1',[id,mailApproved?'standard':'preview']);
    await cancelStayJobs(tx,id);
    const addJob=(kind,due,expires)=>tx.query('INSERT INTO stay_jobs(id,reservation_id,reservation_revision,kind,due_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,revision,kind,due,expires]);
    if(status==='cancelled')await addJob('cancellation',now,new Date(now.getTime()+7*86400000));
    else{
      await addJob(prior?'rescheduled':'confirmation',now,checkoutAt);
      if(status!=='checked_in')await addJob('arrival',new Date(new Date(checkinAt).getTime()-24*3600000),checkinAt);
      await addJob('departure',new Date(new Date(checkoutAt).getTime()-24*3600000),checkoutAt);
    }
    const current=await one(tx,'SELECT * FROM stay_reservations WHERE id=$1',[id]);
    await activity(tx,id,actorId,review?'review.applied':event.event,{source_revision:event.source_revision,revision,...(prior?{before:reservationEvidence(prior)}:{}),after:reservationEvidence(current),...(review?{review_id:review.id,note:review.note}:{})});
    return saveEvent('applied',{id,revision,status,applied:true});
}

async function cancelStayJobs(tx,reservationId){
  await tx.query("UPDATE commercial_mail SET status='cancelled' WHERE status IN ('pending','failed') AND id IN (SELECT mail_id FROM stay_jobs WHERE reservation_id=$1)",[reservationId]);
  await tx.query("UPDATE stay_jobs SET status='cancelled',processed_at=now() WHERE reservation_id=$1 AND status IN ('scheduled','queued')",[reservationId]);
}

function stayMail(reservation,kind){
  const unit=reservation.unit_snapshot;
  const content={confirmation:['Your ViiConcierge reservation','Reservation confirmed','Your demonstration reservation is confirmed. This message does not confirm a payment.'],rescheduled:['Your ViiConcierge reservation has changed','Updated stay details','Your reservation details have been updated. Please review the latest schedule below.'],arrival:['Your ViiConcierge arrival','Welcome to your next stay',unit.arrival_message||'The team will coordinate your arrival.'],departure:['Your ViiConcierge departure','Before you leave',unit.departure_message||'Thank you for staying with VII. The team can assist with departure.'],cancellation:['Your ViiConcierge reservation was cancelled','Reservation cancelled','Your demonstration reservation has been cancelled. This notice does not process a refund or a cancellation fee.']}[kind];
  return{...brandedMail({subject:'[PHASE 2 DEMO] '+content[0],title:content[1],kicker:'VII · VIICONCIERGE',paragraphs:['Hello '+reservation.guest_name+',',content[2]],details:[['Reference',reservation.external_reference],['Property',unit.name],['Arrival',dateOnly(reservation.checkin_date)+' · '+unit.checkin_time],['Departure',dateOnly(reservation.checkout_date)+' · '+unit.checkout_time],['Time zone',unit.timezone]],testNote:'Fictional reservation. Preview only; no external booking, payment, access code or refund is confirmed.'}),delivery_scope:'preview'};
}

export async function processStayJobs(db,{now=new Date(),mailApproved=false,adminEmail}={}){
  const candidates=(await db.query("SELECT id,reservation_id FROM stay_jobs WHERE status='scheduled' AND due_at<=$1 ORDER BY due_at LIMIT 100",[now])).rows;let queued=0,skipped=0;
  for(const candidate of candidates)await db.transaction(async tx=>{
    const r=await one(tx,'SELECT * FROM stay_reservations WHERE id=$1 FOR UPDATE',[candidate.reservation_id]),job=await one(tx,'SELECT * FROM stay_jobs WHERE id=$1 FOR UPDATE',[candidate.id]);
    if(!job||job.status!=='scheduled'||new Date(job.due_at)>now)return;
    if(!r||r.revision!==job.reservation_revision||new Date(job.expires_at)<=now||job.kind!=='cancellation'&&r.status==='cancelled'||['checked_in','checked_out'].includes(r.status)&&job.kind==='arrival'||r.status==='checked_out'&&job.kind==='departure'){
      await tx.query("UPDATE stay_jobs SET status='skipped',processed_at=now() WHERE id=$1",[job.id]);skipped++;return;
    }
    const message=stayMail(r,job.kind);if(mailApproved&&r.verified_external&&r.delivery_scope==='standard'){
      const body={confirmation:'Your reservation was recorded from the authorised booking channel. This notice does not verify a payment.',cancellation:'Your reservation cancellation was recorded from the authorised booking channel. This notice does not issue a refund.',arrival:r.unit_snapshot.arrival_message||'The ViiConcierge team will coordinate your arrival.',departure:r.unit_snapshot.departure_message||'The ViiConcierge team can assist with your departure.'}[job.kind];
      Object.assign(message,brandedMail({subject:'[PHASE 2 TEST] ViiConcierge '+job.kind,title:'Your ViiConcierge stay',kicker:'VII · VIICONCIERGE',paragraphs:['Hello '+r.guest_name+',',body||'Please review the latest details of your stay.'],details:[['Reference',r.external_reference],['Property',r.unit_snapshot.name],['Arrival',dateOnly(r.checkin_date)+' · '+r.unit_snapshot.checkin_time],['Departure',dateOnly(r.checkout_date)+' · '+r.unit_snapshot.checkout_time],['Time zone',r.unit_snapshot.timezone]],testNote:'Integration review environment. Reservation information is separate from payment verification.'}),{delivery_scope:'standard'});
    }
    const mailId=await queueCommercialMail(tx,'stay:'+r.id+':v'+r.revision+':'+job.kind,r.guest_email,message);
    if(message.delivery_scope==='standard'&&adminEmail&&['confirmation','rescheduled','cancellation'].includes(job.kind))await queueCommercialMail(tx,'stay:'+r.id+':v'+r.revision+':'+job.kind+':admin',adminEmail,message);
    await tx.query("UPDATE stay_jobs SET status='queued',mail_id=$2,processed_at=now() WHERE id=$1",[job.id,mailId]);queued++;
  });return{queued,skipped,delivery:'preview_only'};
}

export async function registerStays(app,{db,adminGuard,customerGuard,seedExamples=true,mailApproved=false,adminEmail}){
  if(seedExamples)await seedStayUnits(db);
  const route=(method,url,body,handler)=>app.route({method,url:'/api/commercial/stays'+url,...(body?{schema:{body}}:{}),preHandler:adminGuard,handler});
  route('GET','/units',null,async()=>({items:(await db.query('SELECT * FROM stay_units ORDER BY name')).rows}));
  route('POST','/units',unitSchema,async r=>{timezoneFormatter(r.body.timezone);localStayTime('2027-02-15',r.body.checkin_time,r.body.timezone);localStayTime('2027-02-16',r.body.checkout_time,r.body.timezone);const id=randomUUID();await db.query('INSERT INTO stay_units(id,name,address,timezone,capacity,checkin_time,checkout_time,arrival_message,departure_message,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,...['name','address','timezone','capacity','checkin_time','checkout_time','arrival_message','departure_message','active'].map(k=>r.body[k])]);await audit(db,r.teamUser.id,'stay.unit.create',id);return{id};});
  route('PUT','/units/:id',s.object({...unitSchema.properties,revision:s.int(1)}),async r=>db.transaction(async tx=>{
    timezoneFormatter(r.body.timezone);localStayTime('2027-02-15',r.body.checkin_time,r.body.timezone);localStayTime('2027-02-16',r.body.checkout_time,r.body.timezone);
    const u=await one(tx,'SELECT * FROM stay_units WHERE id=$1 FOR UPDATE',[r.params.id]);if(!u)fail(404,'Stay unit not found.');if(u.revision!==r.body.revision)fail(409,'Unit changed. Refresh before editing.');
    await tx.query('UPDATE stay_units SET name=$2,address=$3,timezone=$4,capacity=$5,checkin_time=$6,checkout_time=$7,arrival_message=$8,departure_message=$9,active=$10,revision=revision+1 WHERE id=$1',[u.id,...['name','address','timezone','capacity','checkin_time','checkout_time','arrival_message','departure_message','active'].map(k=>r.body[k])]);await audit(tx,r.teamUser.id,'stay.unit.update',u.id);return{ok:true};
  }));
  route('GET','/reservations',null,async()=>({items:(await db.query('SELECT * FROM stay_reservations ORDER BY checkin_date DESC LIMIT 250')).rows.map(safeReservation)}));
  route('GET','/events',null,async()=>({items:(await db.query('SELECT id,provider,external_event_id,reservation_id,status,result,created_at FROM stay_event_inbox ORDER BY created_at DESC LIMIT 150')).rows}));
  route('GET','/reviews',null,async(r,reply)=>{reply.header('Cache-Control','private, no-store');return{items:(await db.query('SELECT q.*,e.payload AS proposed FROM stay_reviews q JOIN stay_event_inbox e ON e.id=q.event_id ORDER BY q.created_at DESC LIMIT 200')).rows};});
  route('POST','/reviews/:id/resolve',s.object({revision:s.int(1),decision:s.choice(['approve','decline']),request_id:s.uuid,note:s.str(2000,3),acknowledged:{const:true}}),r=>db.transaction(async tx=>{
    await stayLock(tx);const q=await one(tx,'SELECT * FROM stay_reviews WHERE id=$1 FOR UPDATE',[r.params.id]);if(!q)fail(404,'Stay review not found.');
    const note=r.body.note.trim();if(note.length<3)fail(400,'Explain the reviewed change.');
    const usedKey=await one(tx,'SELECT id FROM stay_reviews WHERE decision_key=$1',[r.body.request_id]);if(usedKey&&usedKey.id!==q.id)fail(409,'Decision key belongs to another review.');
    if(q.status!=='pending'){if(q.decision_key===r.body.request_id&&q.note===note&&q.status===(r.body.decision==='approve'?'approved':'declined'))return{...q.result,duplicate:true};fail(409,'This review is already resolved.');}
    if(q.revision!==r.body.revision)fail(409,'Review changed. Refresh first.');
    const e=await one(tx,'SELECT * FROM stay_event_inbox WHERE id=$1',[q.event_id]);if(!e||snapshotHash(e.payload)!==e.payload_hash||snapshotHash(q.original)!==q.original_hash)fail(409,'Review evidence needs investigation.');
    let result={declined:true};if(r.body.decision==='approve'){
      const current=await one(tx,'SELECT * FROM stay_reservations WHERE id=$1 FOR UPDATE',[q.reservation_id]),target=await one(tx,'SELECT * FROM stay_units WHERE id=$1 FOR UPDATE',[e.payload.unit_id]);
      if(!current||!target||snapshotHash(reservationEvidence(current))!==q.original_hash||target.revision!==q.target_unit_revision)fail(409,'Reservation or target unit changed. Decline this review and submit a new event.');
      result=await applyStayEvent(tx,e.payload,{actorId:r.teamUser.id,authenticatedSource:e.authenticated_source,review:{id:q.id,note},mailApproved});
      if(!result.applied)fail(409,'Reviewed change cannot be applied: '+result.reason);
    }else await activity(tx,q.reservation_id,r.teamUser.id,'review.declined',{review_id:q.id,note});
    await tx.query('UPDATE stay_reviews SET status=$2,revision=revision+1,decision_key=$3,note=$4,actor_id=$5,result=$6,resolved_at=now() WHERE id=$1',[q.id,r.body.decision==='approve'?'approved':'declined',r.body.request_id,note,r.teamUser.id,JSON.stringify(result)]);
    await audit(tx,r.teamUser.id,'stay.review',q.id,{decision:r.body.decision,note,result,external_update:false});return result;
  }));
  route('GET','/jobs',null,async()=>({items:(await db.query('SELECT j.*,r.guest_name,r.external_reference FROM stay_jobs j JOIN stay_reservations r ON r.id=j.reservation_id ORDER BY j.due_at DESC LIMIT 250')).rows}));
  route('POST','/events/demo',stayEventSchema,async r=>ingestStayEvent(db,r.body,{actorId:r.teamUser.id}));
  route('POST','/process',s.object({}),()=>processStayJobs(db,{mailApproved,adminEmail}));
  route('GET','/reservations/:id/activity',null,async r=>({items:(await db.query('SELECT * FROM stay_activity WHERE reservation_id=$1 ORDER BY created_at DESC',[r.params.id])).rows}));
  route('POST','/reservations/:id/status',s.object({status:s.choice(['checked_in','checked_out']),revision:s.int(1)}),async r=>db.transaction(async tx=>{
    await stayLock(tx);
    const reservation=await one(tx,'SELECT * FROM stay_reservations WHERE id=$1 FOR UPDATE',[r.params.id]);if(!reservation)fail(404,'Reservation not found.');if(reservation.revision!==r.body.revision)fail(409,'Reservation changed. Refresh first.');
    const allowed={confirmed:'checked_in',checked_in:'checked_out'};if(allowed[reservation.status]!==r.body.status)fail(409,'Invalid stay transition.');
    const today=stayLocalDay(reservation.unit_snapshot.timezone);if(r.body.status==='checked_in'&&(today<dateOnly(reservation.checkin_date)||today>=dateOnly(reservation.checkout_date)))fail(409,'Check-in is only available during the booked stay.');
    await tx.query('UPDATE stay_reservations SET status=$2,updated_at=now() WHERE id=$1',[reservation.id,r.body.status]);await activity(tx,reservation.id,r.teamUser.id,r.body.status);
    const obsolete=r.body.status==='checked_in'?['arrival']:['arrival','departure'];
    await tx.query("UPDATE commercial_mail SET status='cancelled' WHERE delivery_scope='preview' AND status IN ('pending','failed') AND id IN (SELECT mail_id FROM stay_jobs WHERE reservation_id=$1 AND kind=ANY($2::text[]))",[reservation.id,obsolete]);
    await tx.query("UPDATE stay_jobs SET status='cancelled' WHERE reservation_id=$1 AND kind=ANY($2::text[]) AND status IN ('scheduled','queued')",[reservation.id,obsolete]);return{ok:true};
  }));
  // Only verified account emails match stays. Guests cannot enumerate by email.
  app.get('/api/client/stays',{preHandler:customerGuard},async r=>({items:(await db.query('SELECT * FROM stay_reservations WHERE guest_email=$1 ORDER BY checkin_date DESC LIMIT 100',[r.customer.email])).rows.map(({guest_email,...reservation})=>safeReservation(reservation))}));
}
