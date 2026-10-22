import {randomUUID} from 'node:crypto';
import {hash,token,fail,passwordHash} from '../viicasa-backend/src/lib.js';
import {beginLogin,finishLogin,sessionUser,safeUser} from './security.mjs';
import {serviceMenu,quoteService} from './service-menu.mjs';
import * as s from '../viicasa-backend/src/schemas.js';
import {visibleTeamNotifications} from './team-followup.mjs';
import {priceConfiguredQuote,verifyQuotePricing,quoteExtras} from './pricing.mjs';
import {commissionLock,requireReviewedCommission} from './commission-core.mjs';

export const cookieValue=(request,name)=>{const part=(request.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='));return part?.slice(name.length+1)||'';};
export async function audit(db,actor,action,resource,detail={}){await db.query('INSERT INTO team_audit(id,actor_id,action,resource,detail) VALUES($1,$2,$3,$4,$5)',[randomUUID(),actor,action,resource,JSON.stringify(detail)]);}
const notify=async(db,user,body)=>db.query('INSERT INTO team_notifications(id,user_id,body) VALUES($1,$2,$3)',[randomUUID(),user,body]);
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const numRows=rows=>rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,k.endsWith('_minor')?Number(v):v])));
export async function registerCommercial(app,{db,vault,origin,secure=false}){
  const prefix='/api/commercial',dummy=await passwordHash(token());
  const cookie=(secret,age=28800)=>`vc2_team=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure?'; Secure':''}`;
  const userGuard=async r=>{const user=await sessionUser(db,cookieValue(r,'vc2_team'));if(!user)fail(401,'Sign in with two-step verification.');r.teamUser=user;};
  const adminGuard=async r=>{await userGuard(r);if(r.teamUser.role!=='admin')fail(403,'Administrator access required.');};
  const route=(method,path,body,handler,{admin=false,publicRoute=false,limit}={})=>app.route({method,url:prefix+path,
    ...(body?{schema:{body}}:{}),...(publicRoute?{}:{preHandler:admin?adminGuard:userGuard}),
    ...(limit?{config:{rateLimit:{max:limit,timeWindow:'5 minutes'}}}:{}),handler});
  app.addHook('onRequest',async r=>{if(r.url.startsWith(prefix)&&!['GET','HEAD','OPTIONS'].includes(r.method)&&r.headers.origin!==origin)fail(403,'Request origin is not allowed.');});
  route('POST','/login',s.object({email:s.email,password:s.str(128,1),portal:s.choice(['admin','seller'])},['email','password']),async r=>{
    const result=await beginLogin(db,vault,r.body.email,r.body.password,dummy,r.body.portal);return result;
  },{publicRoute:true,limit:12});
  route('POST','/verify',s.object({challenge:s.str(43,43),code:s.str(32,6),portal:s.choice(['admin','seller'])},['challenge','code']),async(r,reply)=>{
    const result=await finishLogin(db,vault,r.body.challenge,r.body.code,r.body.portal);reply.header('Set-Cookie',cookie(result.secret));
    await audit(db,result.user.id,'auth.login',result.user.id,{portal:r.body.portal||'team'});return{user:result.user,portal_url:result.user.role==='admin'?'/admin':'/vendedor',...(result.recovery?{recovery:result.recovery}:{})};
  },{publicRoute:true,limit:25});
  route('GET','/me',null,r=>safeUser(r.teamUser));
  route('GET','/sessions',null,async r=>({items:(await db.query('SELECT id,created_at,expires_at,(token_hash=$2) AS current FROM team_sessions WHERE user_id=$1 AND auth_version=$3 AND expires_at>now() ORDER BY created_at DESC',[r.teamUser.id,hash(cookieValue(r,'vc2_team')),r.teamUser.auth_version])).rows}));
  route('POST','/sessions/:id/revoke',s.object({}),async(r,reply)=>{
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(r.params.id))fail(404,'Session not found.');
    const outcome=await db.transaction(async tx=>{
      const session=await one(tx,'SELECT id,token_hash FROM team_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',[r.params.id,r.teamUser.id]);if(!session)fail(404,'Session not found.');
      await tx.query('DELETE FROM team_sessions WHERE id=$1 AND user_id=$2',[session.id,r.teamUser.id]);await audit(tx,r.teamUser.id,'security.session_revoke',session.id);
      return{signed_out:session.token_hash===hash(cookieValue(r,'vc2_team'))};
    });if(outcome.signed_out)reply.header('Set-Cookie',cookie('',0));return outcome;
  });
  route('POST','/logout',s.object({}),async(r,reply)=>{await db.query('DELETE FROM team_sessions WHERE token_hash=$1',[hash(cookieValue(r,'vc2_team'))]);reply.header('Set-Cookie',cookie('',0));return{ok:true};});
  route('PUT','/profile',s.object({name:s.str(120,2),phone:s.str(30,0)}),async r=>{
    await db.query('UPDATE team_users SET name=$2,phone=$3 WHERE id=$1',[r.teamUser.id,r.body.name,r.body.phone]);return safeUser({...r.teamUser,...r.body});
  });
  route('GET','/users',null,async()=>({items:(await db.query('SELECT * FROM team_users WHERE NOT deleted ORDER BY name')).rows.map(safeUser)}),{admin:true});
  route('GET','/customers',null,async()=>({items:(await db.query('SELECT id,name,email,email_verified,active,created_at FROM customer_accounts ORDER BY created_at DESC LIMIT 250')).rows}),{admin:true});
  const userFields={name:s.str(120,2),email:s.email,phone:s.str(30,0),role:s.choice(['admin','seller']),goal_minor:s.int(),active:s.bool};
  route('POST','/users',s.object({...userFields,password:s.str(128,12)}),async r=>{
    const id=randomUUID(),b=r.body;await db.transaction(async tx=>{await tx.query('INSERT INTO team_users(id,email,name,password_hash,role,phone,goal_minor,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,b.email.toLowerCase(),b.name,await passwordHash(b.password),b.role,b.phone,b.goal_minor,b.active]);await audit(tx,r.teamUser.id,'user.create',id);});return{id};
  },{admin:true});
  route('PUT','/users/:id',s.object(userFields),async r=>db.transaction(async tx=>{
    const old=await one(tx,'SELECT * FROM team_users WHERE id=$1 AND NOT deleted FOR UPDATE',[r.params.id]);if(!old)fail(404,'User not found.');
    if(old.id===r.teamUser.id&&(!r.body.active||r.body.role!=='admin'))fail(409,'You cannot remove your own administrator access.');
    const b=r.body;await tx.query('UPDATE team_users SET name=$2,email=$3,phone=$4,role=$5,goal_minor=$6,active=$7,auth_version=auth_version+1 WHERE id=$1',[old.id,b.name,b.email.toLowerCase(),b.phone,b.role,b.goal_minor,b.active]);
    await audit(tx,r.teamUser.id,'user.update',old.id,{role:b.role,active:b.active});return{ok:true};
  }),{admin:true});
  route('POST','/users/:id/security',s.object({action:s.choice(['revoke','reset_mfa','reset_password']),password:s.str(128,12)},['action']),async r=>db.transaction(async tx=>{
    const u=await one(tx,'SELECT * FROM team_users WHERE id=$1 AND NOT deleted FOR UPDATE',[r.params.id]);if(!u)fail(404,'User not found.');
    const action=r.body.action;
    if(action==='reset_password'&&!r.body.password)fail(400,'A temporary password is required.');
    if(action==='reset_mfa')await tx.query("UPDATE team_users SET totp_secret=NULL,totp_counter=-1,recovery_hashes='[]',auth_version=auth_version+1 WHERE id=$1",[u.id]);
    else if(action==='reset_password')await tx.query('UPDATE team_users SET password_hash=$2,auth_version=auth_version+1 WHERE id=$1',[u.id,await passwordHash(r.body.password)]);
    else await tx.query('UPDATE team_users SET auth_version=auth_version+1 WHERE id=$1',[u.id]);
    await tx.query('DELETE FROM team_sessions WHERE user_id=$1',[u.id]);await tx.query('DELETE FROM team_challenges WHERE user_id=$1',[u.id]);
    await audit(tx,r.teamUser.id,'security.'+action,u.id);return{ok:true};
  }),{admin:true});
  route('POST','/users/:id/delete',s.object({confirm_email:s.email}),async r=>db.transaction(async tx=>{
    const u=await one(tx,'SELECT * FROM team_users WHERE id=$1 AND NOT deleted FOR UPDATE',[r.params.id]);if(!u)fail(404,'User not found.');
    if(u.id===r.teamUser.id||r.body.confirm_email.toLowerCase()!==u.email)fail(409,'Confirm the email of another user to remove access.');
    // Retain related sales and audit; login is permanently disabled.
    await tx.query('UPDATE team_users SET active=false,deleted=true,auth_version=auth_version+1 WHERE id=$1',[u.id]);await audit(tx,r.teamUser.id,'user.delete_access',u.id);return{ok:true};
  }),{admin:true});
  const ownedLead=async(sql,id,user)=>{const lead=await one(sql,'SELECT * FROM crm_leads WHERE id=$1',[id]);if(!lead||user.role!=='admin'&&lead.owner_id!==user.id)fail(404,'Lead not found.');return lead;};
  const leadBody=s.object({name:s.str(120,2),email:s.email,phone:s.str(30,0),company:s.str(160,0),service:s.choice(['home','commercial','shop','concierge']),stage:s.choice(['new','contacted','qualified','proposal','won','lost']),priority:s.choice(['low','normal','high']),source:s.str(100),notes:s.str(5000,0)});
  route('GET','/leads',null,async r=>({items:(await db.query('SELECT l.*,u.name AS owner_name FROM crm_leads l JOIN team_users u ON u.id=l.owner_id WHERE ($1::boolean OR l.owner_id=$2) ORDER BY l.updated_at DESC',[r.teamUser.role==='admin',r.teamUser.id])).rows}));
  route('POST','/leads',leadBody,async r=>db.transaction(async tx=>{
    const id=randomUUID(),b=r.body;await tx.query('INSERT INTO crm_leads(id,owner_id,name,email,phone,company,service,stage,priority,source,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,r.teamUser.id,b.name,b.email.toLowerCase(),b.phone,b.company,b.service,b.stage,b.priority,b.source,b.notes]);
    await audit(tx,r.teamUser.id,'lead.create',id);return{id};
  }));
  route('PUT','/leads/:id',leadBody,async r=>db.transaction(async tx=>{
    await ownedLead(tx,r.params.id,r.teamUser);const b=r.body;
    await tx.query('UPDATE crm_leads SET name=$2,email=$3,phone=$4,company=$5,service=$6,stage=$7,priority=$8,source=$9,notes=$10,updated_at=now() WHERE id=$1',[r.params.id,b.name,b.email.toLowerCase(),b.phone,b.company,b.service,b.stage,b.priority,b.source,b.notes]);await audit(tx,r.teamUser.id,'lead.update',r.params.id);return{ok:true};
  }));
  route('POST','/leads/:id/assign',s.object({owner_id:s.uuid}),async r=>db.transaction(async tx=>{
    await ownedLead(tx,r.params.id,r.teamUser);const u=await one(tx,'SELECT * FROM team_users WHERE id=$1 AND active AND NOT deleted',[r.body.owner_id]);if(!u)fail(400,'Choose an active user.');
    await tx.query('UPDATE crm_leads SET owner_id=$2,updated_at=now() WHERE id=$1',[r.params.id,u.id]);await notify(tx,u.id,'A prospect has been assigned to you.');await audit(tx,r.teamUser.id,'lead.assign',r.params.id,{owner:u.id});return{ok:true};
  }),{admin:true});
  route('GET','/leads/:id/activities',null,async r=>{await ownedLead(db,r.params.id,r.teamUser);return{items:(await db.query('SELECT a.*,u.name AS actor_name FROM crm_activities a JOIN team_users u ON u.id=a.actor_id WHERE a.lead_id=$1 ORDER BY a.created_at DESC',[r.params.id])).rows};});
  route('POST','/leads/:id/activities',s.object({kind:s.choice(['note','call','email','task']),body:s.str(5000),due_at:{anyOf:[{type:'string',format:'date-time'},{type:'null'}]}},['kind','body']),async r=>db.transaction(async tx=>{
    const lead=await ownedLead(tx,r.params.id,r.teamUser),id=randomUUID();await tx.query('INSERT INTO crm_activities(id,lead_id,actor_id,kind,body,due_at) VALUES($1,$2,$3,$4,$5,$6)',[id,lead.id,r.teamUser.id,r.body.kind,r.body.body,r.body.due_at||null]);
    await audit(tx,r.teamUser.id,'activity.create',id);return{id};
  }));
  route('POST','/activities/:id/complete',s.object({done:s.bool}),async r=>db.transaction(async tx=>{
    const activity=await one(tx,'SELECT * FROM crm_activities WHERE id=$1',[r.params.id]);if(!activity)fail(404,'Task not found.');await ownedLead(tx,activity.lead_id,r.teamUser);
    await tx.query('UPDATE crm_activities SET done=$2 WHERE id=$1',[activity.id,r.body.done]);return{ok:true};
  }));
  route('GET','/tasks',null,async r=>({items:(await db.query("SELECT a.*,l.name AS lead_name FROM crm_activities a JOIN crm_leads l ON l.id=a.lead_id WHERE a.kind='task' AND ($1::boolean OR l.owner_id=$2) ORDER BY a.done,a.due_at NULLS LAST",[r.teamUser.role==='admin',r.teamUser.id])).rows}));
  route('GET','/rules',null,async()=>({items:(await db.query('SELECT * FROM commission_rules ORDER BY service')).rows}));
  route('PUT','/rules/:service',s.object({basis_points:s.int(0,10000),approved:s.bool}),async r=>{
    if(!['home','commercial','shop','concierge'].includes(r.params.service))fail(400,'Unknown service.');
    await db.transaction(async tx=>{await tx.query('UPDATE commission_rules SET basis_points=$2,approved=$3 WHERE service=$1',[r.params.service,r.body.basis_points,r.body.approved]);await audit(tx,r.teamUser.id,'commission.rule',r.params.service,r.body);});return{ok:true};
  },{admin:true});
  route('GET','/sales',null,async r=>({items:numRows((await db.query('SELECT v.*,l.name AS client_name,u.name AS seller_name FROM commercial_commission_balances v JOIN crm_leads l ON l.id=v.lead_id JOIN team_users u ON u.id=v.seller_id WHERE ($1::boolean OR v.seller_id=$2) ORDER BY v.created_at DESC',[r.teamUser.role==='admin',r.teamUser.id])).rows)}));
  route('POST','/sales',s.object({lead_id:s.uuid,reference:s.str(100,3),amount_minor:s.int(1),status:s.choice(['pending','paid'])}),async r=>db.transaction(async tx=>{
    const lead=await ownedLead(tx,r.body.lead_id,r.teamUser);const rule=await one(tx,'SELECT * FROM commission_rules WHERE service=$1',[lead.service]);const id=randomUUID(),amount=r.body.amount_minor;
    const commission=Math.floor((amount*rule.basis_points+5000)/10000);
    await tx.query("INSERT INTO commercial_sales(id,lead_id,seller_id,reference,amount_minor,currency,status,basis_points,commission_minor,commission_status) VALUES($1,$2,$3,$4,$5,'CAD',$6,$7,$8,'pending')",[id,lead.id,lead.owner_id,r.body.reference,amount,r.body.status,rule.basis_points,commission]);
    await notify(tx,lead.owner_id,'A sale and its pending commission have been recorded.');await audit(tx,r.teamUser.id,'sale.create',id,{amount_minor:amount});return{id,commission_minor:commission};
  }));
  route('POST','/sales/:id/commission',s.object({status:s.choice(['approved','paid','cancelled'])}),async r=>db.transaction(async tx=>{
    await commissionLock(tx);
    const sale=await one(tx,'SELECT * FROM commercial_sales WHERE id=$1 FOR UPDATE',[r.params.id]);if(!sale)fail(404,'Sale not found.');
    if(sale.commission_status===r.body.status)return{ok:true};
    const balance=await requireReviewedCommission(tx,sale.id);
    if(sale.commission_status==='paid'||sale.commission_status==='cancelled')fail(409,'This commission is closed.');
    if(r.body.status!=='cancelled'&&sale.status!=='paid')fail(409,'The sale must be paid before approving a commission.');
    if(r.body.status==='approved'){
      const rule=await one(tx,'SELECT r.approved FROM commission_rules r JOIN crm_leads l ON l.service=r.service WHERE l.id=$1',[sale.lead_id]);
      if(!rule?.approved)fail(409,'Approve the service commission rule before approving payment.');
    }
    if(r.body.status==='paid'&&sale.commission_status!=='approved')fail(409,'Approve the commission before marking it paid.');
    if(r.body.status==='paid'&&balance.effective_commission_minor<=0)fail(409,'There is no payable commission balance. Close it as cancelled instead.');
    if(r.body.status==='paid')await tx.query('INSERT INTO commission_payout_baselines(review_id,baseline_minor) SELECT id,current_reduction_minor FROM commission_review_effects WHERE sale_id=$1 AND status=\'resolved\' ON CONFLICT(review_id) DO NOTHING',[sale.id]);
    await tx.query("UPDATE commercial_sales SET commission_status=$2,commission_paid_minor=CASE WHEN $2='paid' THEN $3 ELSE commission_paid_minor END WHERE id=$1",[sale.id,r.body.status,balance.effective_commission_minor]);await notify(tx,sale.seller_id,'Commission status: '+r.body.status);await audit(tx,r.teamUser.id,'commission.status',sale.id,{...r.body,effective_commission_minor:balance.effective_commission_minor});return{ok:true};
  }),{admin:true});
  route('POST','/sales/:id/status',s.object({status:s.choice(['paid','cancelled'])}),async r=>db.transaction(async tx=>{
    await commissionLock(tx);
    const sale=await one(tx,'SELECT * FROM commercial_sales WHERE id=$1 FOR UPDATE',[r.params.id]);if(!sale)fail(404,'Sale not found.');
    await requireReviewedCommission(tx,sale.id);
    if(sale.commission_status==='paid')fail(409,'Paid commissions require an adjustment workflow.');
    if(sale.status==='cancelled')fail(409,'Cancelled sale is closed.');
    await tx.query("UPDATE commercial_sales SET status=$2,commission_status=CASE WHEN $2='cancelled' THEN 'cancelled' ELSE commission_status END WHERE id=$1",[sale.id,r.body.status]);await audit(tx,r.teamUser.id,'sale.status',sale.id,r.body);return{ok:true};
  }),{admin:true});
  route('GET','/notifications',null,async r=>({items:await visibleTeamNotifications(db,r.teamUser)}));
  route('POST','/notifications/:id/read',s.object({}),async r=>{await db.query('UPDATE team_notifications SET read=true WHERE id=$1 AND user_id=$2',[r.params.id,r.teamUser.id]);return{ok:true};});
  route('GET','/summary',null,async r=>{
    const args=[r.teamUser.role==='admin',r.teamUser.id];
    const leads=(await db.query('SELECT stage,count(*)::integer AS count FROM crm_leads WHERE ($1::boolean OR owner_id=$2) GROUP BY stage',args)).rows;
    const sales=numRows((await db.query("SELECT seller_id,sum(CASE WHEN status='paid' THEN amount_minor ELSE 0 END)::bigint AS sales_minor,sum(CASE WHEN commission_status='pending' THEN effective_commission_minor ELSE 0 END)::bigint AS pending_minor,sum(CASE WHEN commission_status='approved' THEN effective_commission_minor ELSE 0 END)::bigint AS approved_minor,sum(CASE WHEN commission_status='paid' THEN COALESCE(commission_paid_minor,commission_minor) ELSE 0 END)::bigint AS paid_minor FROM commercial_commission_balances WHERE ($1::boolean OR seller_id=$2) GROUP BY seller_id",args)).rows);
    return{leads,sales,goal_minor:Number(r.teamUser.goal_minor),currency:'CAD'};
  });
  route('GET','/service-menu',null,async()=>({items:serviceMenu}));
  const quoteBody=s.object({lead_id:s.uuid,service_id:s.str(100),rate_minor:s.int(1),quantity:s.int(1,1000000),visits:s.int(1,100),frequency:s.choice(['once','daily','weekly','biweekly','monthly']),term:s.choice(['month_to_month','annual']),properties:s.array(s.object({address:s.str(300,3),sqft:s.int(1,1000000)}),30),weekly_days:s.array(s.int(0,6),7),extras:quoteExtras,pricing_revision:s.int(0)},['lead_id','service_id','rate_minor','quantity','visits','frequency','term','properties']);
  route('POST','/quotes/preview',quoteBody,async r=>db.transaction(async tx=>{const lead=await ownedLead(tx,r.body.lead_id,r.teamUser),result=await priceConfiguredQuote(tx,r.body);if(lead.service!==serviceMenu.find(x=>x.id===result.service_id).segment)fail(400,'Service does not match the client.');return result;}));
  route('POST','/quotes',quoteBody,async r=>db.transaction(async tx=>{
    const lead=await ownedLead(tx,r.body.lead_id,r.teamUser),result=await priceConfiguredQuote(tx,r.body),id=randomUUID();if(lead.service!==serviceMenu.find(x=>x.id===result.service_id).segment)fail(400,'Choose a service matching this prospect.');
    await tx.query('INSERT INTO service_quotes(id,lead_id,actor_id,selection,result) VALUES($1,$2,$3,$4,$5)',[id,lead.id,r.teamUser.id,JSON.stringify(r.body),JSON.stringify(result)]);await audit(tx,r.teamUser.id,'quote.create',id);return{id,...result};
  }));
  route('GET','/quotes',null,async r=>({items:(await db.query('SELECT q.*,l.name AS client_name FROM service_quotes q JOIN crm_leads l ON l.id=q.lead_id WHERE ($1::boolean OR l.owner_id=$2) ORDER BY q.created_at DESC',[r.teamUser.role==='admin',r.teamUser.id])).rows}));
  route('PUT','/quotes/:id',s.object({...quoteBody.properties,revision:s.int(1)},[...quoteBody.required,'revision']),async r=>db.transaction(async tx=>{
    const q=await one(tx,'SELECT * FROM service_quotes WHERE id=$1 FOR UPDATE',[r.params.id]);if(!q)fail(404,'Quote not found.');
    await ownedLead(tx,q.lead_id,r.teamUser);
    if(q.status!=='draft'||q.revision!==r.body.revision)fail(409,'Quote changed or is already approved.');
    if(q.lead_id!==r.body.lead_id)fail(400,'A quote cannot be moved to a different client.');
    const result=await priceConfiguredQuote(tx,r.body);
    const lead=await ownedLead(tx,q.lead_id,r.teamUser);if(lead.service!==serviceMenu.find(s=>s.id===r.body.service_id).segment)fail(400,'Service does not match the client.');
    const {revision,...selection}=r.body;
    await tx.query('UPDATE service_quotes SET selection=$2,result=$3,revision=revision+1 WHERE id=$1',[q.id,JSON.stringify(selection),JSON.stringify(result)]);await audit(tx,r.teamUser.id,'quote.update',q.id);return{id:q.id,revision:q.revision+1,...result};
  }));
  route('POST','/quotes/:id/review',s.object({action:s.choice(['approve','reject']),revision:s.int(1)}),async r=>db.transaction(async tx=>{
    const q=await one(tx,'SELECT * FROM service_quotes WHERE id=$1 FOR UPDATE',[r.params.id]);if(!q)fail(404,'Quote not found.');
    if(q.revision!==r.body.revision||q.status!=='draft')fail(409,'Quote changed or has already been reviewed.');
    if(r.body.action==='approve')await verifyQuotePricing(tx,q);
    const status=r.body.action==='approve'?'approved':'rejected';await tx.query('UPDATE service_quotes SET status=$2,revision=revision+1 WHERE id=$1',[q.id,status]);await audit(tx,r.teamUser.id,'quote.'+status,q.id);return{ok:true};
  }),{admin:true});
  route('GET','/audit',null,async()=>({items:(await db.query('SELECT a.*,u.name AS actor_name FROM team_audit a LEFT JOIN team_users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 150')).rows}),{admin:true});
  route('GET','/integrations',null,async()=>({items:['lodgify','airbnb','shopify','meta','ga4','gtm'].map(provider=>({provider,mode:'demo',status:'requires_client_access'})),events:(await db.query('SELECT * FROM integration_events ORDER BY created_at DESC LIMIT 50')).rows}),{admin:true});
  route('POST','/integrations/:provider/simulate',s.object({event:s.choice(['reservation','order','cancellation','checkout','form'])}),async r=>{
    const provider=r.params.provider;if(!['lodgify','airbnb','shopify','meta','ga4','gtm'].includes(provider))fail(400,'Unknown provider.');
    const id=randomUUID(),reference='DEMO-'+provider+'-'+id.slice(0,8),payload={event:r.body.event,source:'local_fixture',external_request:false};
    await db.transaction(async tx=>{await tx.query("INSERT INTO integration_events(id,provider,reference,payload,mode) VALUES($1,$2,$3,$4,'demo')",[id,provider,reference,JSON.stringify(payload)]);await audit(tx,r.teamUser.id,'integration.simulate',id,{provider});});return{id,reference,mode:'demo'};
  },{admin:true});
  return{userGuard,adminGuard};
}
