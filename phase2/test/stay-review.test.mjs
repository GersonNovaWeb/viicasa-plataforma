import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {moduleFixture} from './module-fixture.mjs';
import {ingestStayEvent,processStayJobs} from '../stays.mjs';
import {addServiceDays,serviceDay} from '../service-time.mjs';
async function units(f){const first=(await f.db.query('SELECT * FROM stay_units LIMIT 1')).rows[0],id=randomUUID();await f.db.query('INSERT INTO stay_units(id,name,address,timezone,capacity,checkin_time,checkout_time) VALUES($1,\'Second Fictional Unit\',\'200 Example Street\',\'America/Vancouver\',4,\'16:00\',\'11:00\')',[id]);return[first.id,id];}
const event=(unit,overrides={})=>({provider:'demo',event_id:randomUUID(),external_reference:randomUUID(),source_revision:1,event:'confirmed',unit_id:unit,guest_name:'Alex Example',guest_email:'stay-module@example.invalid',guests:2,checkin_date:addServiceDays(serviceDay(),10),checkout_date:addServiceDays(serviceDay(),13),...overrides});
const decision=(q,extra={})=>({revision:1,decision:'approve',request_id:randomUUID(),note:'Guest-coordinated isolated review',acknowledged:true,...extra});
test('unit moves require admin review, preserve inbox/history and replace previews exactly once',async t=>{
  const f=await moduleFixture(t),[a,b]=await units(f),original=event(a),created=(await f.post('/api/commercial/stays/events/demo',original)).json();await processStayJobs(f.db);
  const change={...original,event_id:randomUUID(),source_revision:2,event:'modified',unit_id:b},queued=await f.post('/api/commercial/stays/events/demo',change);assert.equal(queued.json().requires_review,true);const id=queued.json().review_id;
  assert.equal((await f.db.query('SELECT unit_id FROM stay_reservations WHERE id=$1',[created.id])).rows[0].unit_id,a);
  const url='/api/commercial/stays/reviews/'+id+'/resolve',body=decision(id);assert.equal((await f.post(url,body,f.seller.cookie)).statusCode,403);
  assert.equal((await f.call(url,{method:'POST',body,cookie:f.admin.cookie,origin:'https://outside.invalid'})).statusCode,403);
  const replies=await Promise.all([f.post(url,body),f.post(url,body)]);assert.ok(replies.every(r=>r.statusCode===200),replies.map(r=>r.body).join('\n'));
  const r=(await f.db.query('SELECT * FROM stay_reservations WHERE id=$1',[created.id])).rows[0];assert.equal(r.unit_id,b);assert.equal(r.revision,2);
  assert.equal((await f.db.query("SELECT count(*)::integer AS n FROM commercial_mail WHERE dedupe LIKE $1 AND status='cancelled'",['stay:'+created.id+':v1:%'])).rows[0].n,1);
  assert.equal((await f.post('/api/commercial/stays/events/demo',event(a))).json().applied,true);
  const h=(await f.db.query("SELECT detail FROM stay_activity WHERE reservation_id=$1 AND action='review.applied'",[created.id])).rows[0].detail;assert.equal(h.before.unit_id,a);assert.equal(h.after.unit_id,b);
  assert.equal((await f.post('/api/commercial/stays/events/demo',change)).json().duplicate,true);assert.equal((await f.call('/stay-review-workspace.js')).statusCode,200);
});
test('concurrent reviewed moves cannot double-book; stale unit revisions and declined proposals never change occupancy',async t=>{
  const f=await moduleFixture(t),[a,b]=await units(f),c=randomUUID();await f.db.query('INSERT INTO stay_units(id,name,address,timezone,capacity,checkin_time,checkout_time) SELECT $1,\'Third Fixture\',address,timezone,capacity,checkin_time,checkout_time FROM stay_units WHERE id=$2',[c,a]);
  const e1=event(a),e2=event(c);await f.post('/api/commercial/stays/events/demo',e1);await f.post('/api/commercial/stays/events/demo',e2);
  const proposals=[];for(const e of [e1,e2])proposals.push((await f.post('/api/commercial/stays/events/demo',{...e,event_id:randomUUID(),source_revision:2,event:'modified',unit_id:b})).json());
  const results=await Promise.all(proposals.map(q=>f.post('/api/commercial/stays/reviews/'+q.review_id+'/resolve',decision(q.review_id))));assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);
  const pending=(await f.db.query("SELECT * FROM stay_reviews WHERE status='pending'")).rows[0];await f.db.query('UPDATE stay_units SET revision=revision+1 WHERE id=$1',[b]);
  assert.equal((await f.post('/api/commercial/stays/reviews/'+pending.id+'/resolve',decision(pending.id))).statusCode,409);assert.equal((await f.post('/api/commercial/stays/reviews/'+pending.id+'/resolve',decision(pending.id,{decision:'decline'}))).statusCode,200);
  assert.equal((await f.db.query("SELECT count(*)::integer AS n FROM stay_reservations WHERE unit_id=$1 AND status='confirmed'",[b])).rows[0].n,1);
});
test('started stays keep checked-in state after review; cancellation is supervised and completed stays stay closed',async t=>{
  const f=await moduleFixture(t),[a]=await units(f),e=event(a,{checkin_date:addServiceDays(serviceDay(),-1),checkout_date:addServiceDays(serviceDay(),3)}),initial=await ingestStayEvent(f.db,e,{actorId:f.admin.user.id,now:new Date(e.checkin_date+'T00:00:00Z')});
  await f.db.query("UPDATE stay_reservations SET status='checked_in' WHERE id=$1",[initial.id]);
  const change={...e,event_id:randomUUID(),event:'modified',source_revision:2,checkout_date:addServiceDays(serviceDay(),4)},q=(await f.post('/api/commercial/stays/events/demo',change)).json();assert.equal(q.requires_review,true);
  const approved=await f.post('/api/commercial/stays/reviews/'+q.review_id+'/resolve',decision(q.review_id));assert.equal(approved.statusCode,200,approved.body);assert.equal(approved.json().status,'checked_in');assert.equal((await f.db.query("SELECT count(*)::integer AS n FROM stay_jobs WHERE reservation_id=$1 AND reservation_revision=2 AND kind='arrival'",[initial.id])).rows[0].n,0);
  const cancel={...change,event_id:randomUUID(),source_revision:3,event:'cancelled'},cancelQ=(await f.post('/api/commercial/stays/events/demo',cancel)).json();assert.equal(cancelQ.requires_review,true);assert.equal((await f.post('/api/commercial/stays/reviews/'+cancelQ.review_id+'/resolve',decision(cancelQ.review_id))).json().status,'cancelled');
  await f.db.query("UPDATE stay_reservations SET status='checked_out' WHERE id=$1",[initial.id]);assert.equal((await f.post('/api/commercial/stays/events/demo',{...change,event_id:randomUUID(),source_revision:4})).json().reason,'stay_already_ended');
});
