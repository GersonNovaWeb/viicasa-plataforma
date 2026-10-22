import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openPhase2Databases} from '../database.mjs';
import {seedPhase2,demoCredentials} from '../bootstrap.mjs';
import {buildPhase2App} from '../app.mjs';
import {secretVault,totp} from '../security.mjs';
import {csvCell,reportFilters} from '../commercial-reports.mjs';

test('report ranges validate dates and scope; CSV cells neutralise formula prefixes and escape quotes',()=>{
  const user={id:randomUUID(),role:'seller'};
  assert.equal(reportFilters({from:'2026-11-01',to:'2026-11-01'},user).seller_id,user.id);
  for(const q of [{from:'2026-02-30',to:'2026-03-01'},{from:'2026-11-02',to:'2026-11-01'},{from:'2025-01-01',to:'2026-11-01'}])assert.throws(()=>reportFilters(q,user));
  for(const text of ['=HYPERLINK("bad")','+formula','\t@formula',' -formula'])assert.ok(csvCell(text).startsWith('"\''));
  assert.equal(csvCell('normal "name"'),'"normal ""name"""');
});

test('commercial reports and own-session security enforce roles without external providers',async t=>{
  const databases=await openPhase2Databases('',{memory:true});t.after(()=>databases.close());await seedPhase2(databases);
  const db=databases.commercial,app=await buildPhase2App(databases,secretVault(Buffer.alloc(32,11)),{testing:true});t.after(()=>app.close());
  const origin='http://127.0.0.1:3030',range='?from=2026-11-01&to=2026-11-01';
  const call=(url,{cookie,body,method='GET'}={})=>app.inject({url,method,headers:{origin,...(cookie?{cookie}:{})},payload:body});
  const login=async(credentials,code)=>{const first=await call('/api/commercial/login',{method:'POST',body:credentials}),challenge=first.json();const verified=await call('/api/commercial/verify',{method:'POST',body:{challenge:challenge.challenge,code:code||totp(challenge.secret)}});assert.equal(verified.statusCode,200,verified.body);return{cookie:verified.headers['set-cookie'].split(';')[0],...verified.json()};};
  const admin=await login(demoCredentials.admin),seller=await login(demoCredentials.seller);
  const leads=[];
  for(const [owner,stage,created]of [[seller.user.id,'won','2026-11-01T07:30:00Z'],[seller.user.id,'qualified','2026-11-02T07:30:00Z'],[admin.user.id,'won','2026-11-01T12:00:00Z']]){
    const id=randomUUID();leads.push(id);await db.query("INSERT INTO crm_leads(id,owner_id,name,email,service,stage,priority,source,created_at) VALUES($1,$2,'Fixture','fixture@example.invalid','home',$3,'normal','Fixture',$4)",[id,owner,stage,created]);
  }
  for(const [owner,lead,amount,status,commission,commissionStatus,created]of [
    [seller.user.id,leads[0],101,'paid',5,'pending','2026-11-01T07:30:00Z'],
    [seller.user.id,leads[1],9999,'paid',500,'approved','2026-11-02T07:30:00Z'],
    [seller.user.id,leads[0],1000,'pending',50,'pending','2026-11-01T09:30:00Z'],
    [seller.user.id,leads[0],20000,'cancelled',1000,'cancelled','2026-11-01T10:00:00Z'],
    [seller.user.id,leads[0],77700,'paid',3885,'paid','2026-11-02T08:01:00Z'],
    [admin.user.id,leads[2],50000,'paid',2500,'paid','2026-11-01T12:00:00Z']]){
    await db.query("INSERT INTO commercial_sales(id,lead_id,seller_id,reference,amount_minor,currency,status,basis_points,commission_minor,commission_status,created_at) VALUES($1,$2,$3,$4,$5,'CAD',$6,500,$7,$8,$9)",[randomUUID(),lead,owner,randomUUID(),amount,status,commission,commissionStatus,created]);
  }
  await t.test('reports require authentication and a seller cannot request another member',async()=>{
    assert.equal((await call('/api/commercial/reports'+range)).statusCode,401);
    assert.equal((await call('/api/commercial/reports'+range+'&seller_id='+admin.user.id,{cookie:seller.cookie})).statusCode,403);
    assert.equal((await call('/api/commercial/reports/export'+range+'&seller_id='+admin.user.id,{cookie:seller.cookie})).statusCode,403);
    assert.equal((await call('/api/commercial/reports?from=bad&to=bad',{cookie:admin.cookie})).statusCode,400);
  });
  await t.test('inclusive Vancouver DST days, totals and conversion use separate aggregations',async()=>{
    const mine=(await call('/api/commercial/reports'+range,{cookie:seller.cookie})).json();assert.equal(mine.items.length,1);assert.equal(mine.items[0].id,seller.user.id);
    assert.equal(mine.totals.lead_count,2);assert.equal(mine.totals.won_count,1);assert.equal(mine.totals.conversion_percent,50);
    assert.equal(mine.totals.paid_minor,10100);assert.equal(mine.totals.pending_sales_minor,1000);assert.equal(mine.totals.sale_count,4);
    assert.equal(mine.totals.pending_commission_minor,5);assert.equal(mine.totals.approved_commission_minor,500);assert.equal(mine.totals.paid_commission_minor,0);
    assert.equal(mine.monthly[0].paid_minor,10100);
    const global=(await call('/api/commercial/reports'+range,{cookie:admin.cookie})).json();assert.equal(global.totals.paid_minor,60100);assert.equal(global.totals.lead_count,3);
    const filtered=(await call('/api/commercial/reports'+range+'&seller_id='+seller.user.id,{cookie:admin.cookie})).json();assert.deepEqual(filtered.totals,mine.totals);
  });
  await t.test('CSV is scoped and audited; formula names cannot become spreadsheet commands',async()=>{
    await db.query('UPDATE team_users SET name=$2 WHERE id=$1',[seller.user.id,'=DANGEROUS("fixture")']);
    const csv=await call('/api/commercial/reports/export'+range,{cookie:seller.cookie});assert.equal(csv.statusCode,200);assert.match(csv.headers['content-type'],/text\/csv/);assert.equal(csv.headers['cache-control'],'private, no-store');
    assert.ok(csv.body.includes("'=DANGEROUS"));assert.ok(!csv.body.includes(admin.user.name));assert.ok(csv.body.includes('101.00'));
    const audit=(await db.query("SELECT detail FROM team_audit WHERE actor_id=$1 AND action='report.export'",[seller.user.id])).rows;assert.equal(audit.length,1);assert.equal(audit[0].detail.seller_id,seller.user.id);
  });
  await t.test('own-session list hides secrets and cannot revoke another person; self revocation logs out',async()=>{
    const second=await login(demoCredentials.seller,seller.recovery[0]);
    const sessions=await call('/api/commercial/sessions',{cookie:seller.cookie});assert.equal(sessions.json().items.length,2);assert.ok(!sessions.body.includes('token_hash'));assert.ok(!sessions.body.includes(seller.cookie.split('=')[1]));
    const other=sessions.json().items.find(s=>!s.current),current=sessions.json().items.find(s=>s.current);
    const adminSession=(await call('/api/commercial/sessions',{cookie:admin.cookie})).json().items[0];
    assert.equal((await call('/api/commercial/sessions/'+adminSession.id+'/revoke',{method:'POST',cookie:seller.cookie,body:{}})).statusCode,404);
    const revoke=await call('/api/commercial/sessions/'+other.id+'/revoke',{method:'POST',cookie:seller.cookie,body:{}});assert.equal(revoke.json().signed_out,false);
    assert.equal((await call('/api/commercial/me',{cookie:second.cookie})).statusCode,401);
    assert.equal((await call('/api/commercial/me',{cookie:seller.cookie})).statusCode,200);
    const self=await call('/api/commercial/sessions/'+current.id+'/revoke',{method:'POST',cookie:seller.cookie,body:{}});assert.equal(self.json().signed_out,true);assert.match(self.headers['set-cookie'],/Max-Age=0/);
    assert.equal((await call('/api/commercial/me',{cookie:seller.cookie})).statusCode,401);
    assert.equal((await call('/api/commercial/me',{cookie:admin.cookie})).statusCode,200);
  });
});
