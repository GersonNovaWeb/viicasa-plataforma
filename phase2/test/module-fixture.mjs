import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openPhase2Databases} from '../database.mjs';
import {seedPhase2,demoCredentials} from '../bootstrap.mjs';
import {buildPhase2App} from '../app.mjs';
import {secretVault,totp} from '../security.mjs';
import {commissionLock,queueCommissionReviews} from '../commission-core.mjs';
export async function moduleFixture(t,options={}){
  const dbs=await openPhase2Databases('',{memory:true});t.after(()=>dbs.close());await seedPhase2(dbs);const db=dbs.commercial,app=await buildPhase2App(dbs,secretVault(Buffer.alloc(32,29)),{testing:true,...options});t.after(()=>app.close());
  const call=(url,{method='GET',body,cookie,origin='http://127.0.0.1:3030'}={})=>app.inject({url,method,headers:{origin,...(cookie?{cookie}:{})},payload:body});
  const login=async credentials=>{const a=(await call('/api/commercial/login',{method:'POST',body:credentials})).json(),r=await call('/api/commercial/verify',{method:'POST',body:{challenge:a.challenge,code:totp(a.secret)}});assert.equal(r.statusCode,200,r.body);return{cookie:r.headers['set-cookie'].split(';')[0],user:r.json().user};};
  const admin=await login(demoCredentials.admin),seller=await login(demoCredentials.seller);
  const customer=async(email='new-module@example.invalid')=>{const a=(await call('/api/client/register',{method:'POST',body:{name:'Alex Example',email,password:'Modules-Test-2026!'}})).json(),m=(await db.query('SELECT body FROM commercial_mail WHERE recipient=$1 ORDER BY created_at DESC LIMIT 1',[email])).rows[0],r=await call('/api/client/verify',{method:'POST',body:{challenge:a.challenge,code:m.body.match(/code is (\d{6})/)[1]}});assert.equal(r.statusCode,200,r.body);return r.headers['set-cookie'].split(';')[0];};
  const post=(url,body,cookie=admin.cookie)=>call(url,{method:'POST',body,cookie});
  const refund=async invoice=>{const request=randomUUID(),entry=randomUUID();await db.query("INSERT INTO financial_requests(id,invoice_id,requester_id,requester_kind,kind,amount_minor,reason,status,approved_minor,evidence,evidence_hash,idempotency_key) VALUES($1,$2,$3,'team','refund',4000,'Isolated fixture','completed',4000,'{}',$4,$5)",[request,invoice,admin.user.id,'0'.repeat(64),randomUUID()]);await db.query("INSERT INTO financial_entries(id,request_id,invoice_id,kind,amount_minor,reference) VALUES($1,$2,$3,'refund',4000,$4)",[entry,request,invoice,'modules-refund:'+entry]);await db.transaction(async tx=>{await commissionLock(tx);await queueCommissionReviews(tx);});return(await db.query('SELECT * FROM commission_reviews WHERE refund_entry_id=$1',[entry])).rows[0];};
  const commissionSale=async({paid=false}={})=>{const lead=randomUUID(),quote=randomUUID(),contract=randomUUID(),invoice=randomUUID(),id=randomUUID(),number='MODULE-'+invoice;
    await db.query("INSERT INTO crm_leads(id,owner_id,name,email,service,stage,priority,source) VALUES($1,$2,'Alex Example','modules@example.invalid','home','won','normal','Isolated fixture')",[lead,seller.user.id]);
    await db.query("INSERT INTO service_quotes(id,lead_id,actor_id,selection,result,status) VALUES($1,$2,$3,'{}','{}','approved')",[quote,lead,seller.user.id]);
    await db.query("INSERT INTO service_contracts(id,quote_id,lead_id,seller_id,customer_email,status,snapshot,snapshot_hash) VALUES($1,$2,$3,$4,'modules@example.invalid','accepted','{}',$5)",[contract,quote,lead,seller.user.id,'0'.repeat(64)]);
    await db.query("INSERT INTO service_invoices(id,contract_id,number,customer_email,total_minor,period,snapshot,due_date,status) VALUES($1,$2,$3,'modules@example.invalid',10000,'2026-10','{}',now()::date,'paid')",[invoice,contract,number]);
    await db.query("INSERT INTO commercial_sales(id,lead_id,seller_id,reference,amount_minor,currency,status,basis_points,commission_minor,commission_status,service_invoice_id,commission_paid_minor) VALUES($1,$2,$3,$4,10000,'CAD','paid',500,500,$5,$6,$7)",[id,lead,seller.user.id,number,paid?'paid':'pending',invoice,paid?500:null]);
    await db.query('UPDATE commission_rules SET approved=true');return{id,invoice,lead,q:await refund(invoice)};
  };
  return{db,app,call,post,admin,seller,customer,refund,commissionSale};
}
