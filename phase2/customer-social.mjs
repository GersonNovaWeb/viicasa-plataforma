import {randomUUID} from 'node:crypto';
import {hash,token,fail,passwordHash} from '../viicasa-backend/src/lib.js';
import * as s from '../viicasa-backend/src/schemas.js';
import {cookieValue} from './api.mjs';
import {authenticatedCustomer} from './customer-auth.mjs';
import {identityConfiguration,identityProviderGateway} from './identity-provider.mjs';
import {queueCommercialMail,serviceMail} from './mail.mjs';
import {renderWelcomeMail} from '../viicasa-backend/src/platform-mail.js';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];

export async function registerCustomerSocial(app,{db,vault,origin,environment={},customerGuard,gateway,testing=false}){
  if(gateway&&!testing)throw Error('Identity gateway override is restricted to isolated tests.');
  const providers=identityConfiguration(environment,origin),adapter=gateway||identityProviderGateway(providers),secure=origin.startsWith('https:');
  const flowCookie=(provider,value,age=600)=>`vc2_oauth_${provider}=${value}; Path=/; HttpOnly; SameSite=${provider==='apple'?'None':'Lax'}; Max-Age=${age}${secure?'; Secure':''}`;
  const clientCookie=value=>`vc2_client=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${secure?'; Secure':''}`;
  const availability=()=>Object.fromEntries(Object.entries(providers).map(([id,p])=>[id,{enabled:p.enabled,reason:p.reason,callback:p.callback}]));
  app.get('/api/client/auth/providers',async()=>({providers:availability()}));
  app.post('/api/client/auth/:provider/start',{schema:{body:s.object({intent:s.choice(['signin','link']),consent:{const:true}})},config:{rateLimit:{max:12,timeWindow:'5 minutes'}}},async(r,reply)=>{
    const provider=r.params.provider,c=providers[provider];if(!c?.enabled)fail(409,'This provider is not enabled in this environment.');
    const current=await authenticatedCustomer(db,cookieValue(r,'vc2_client'));if(r.body.intent==='signin'&&current)fail(409,'Sign out first, or link the provider from account settings.');
    let targetSession;if(r.body.intent==='link'){
      if(!current)fail(401,'Sign in before linking another provider.');
      targetSession=await one(db,"SELECT token_hash FROM customer_sessions WHERE token_hash=$1 AND expires_at>now()+interval '7 hours 45 minutes'",[hash(cookieValue(r,'vc2_client'))]);if(!targetSession)fail(401,'Sign in again before linking a provider.');
      if(await one(db,'SELECT 1 FROM customer_identities WHERE customer_id=$1 AND provider=$2',[current.id,provider]))fail(409,'This provider is already linked.');
    }
    const state=token(),browser=token(),nonce=token(),verifier=provider==='google'?token():null;
    await db.query("INSERT INTO customer_oauth_flows(state_hash,browser_hash,provider,nonce,verifier_cipher,client_id,intent,target_id,target_session_hash,target_auth_version,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+interval '10 minutes')",[hash(state),hash(browser),provider,nonce,verifier?vault.seal(verifier):null,c.clientId,r.body.intent,current?.id||null,targetSession?.token_hash||null,current?.auth_version||null]);
    reply.header('Set-Cookie',flowCookie(provider,browser)).header('Cache-Control','no-store');return{authorization_url:adapter.authorize(provider,{state,nonce,verifier})};
  });
  const callback=async(provider,r,reply)=>{
    reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer');
    const b=provider==='google'?r.query:r.body,c=providers[provider];
    const failed=code=>reply.header('Set-Cookie',flowCookie(provider,'',0)).redirect('/cliente?auth_error='+code,303);
    if(!c?.enabled||!b||typeof b.state!=='string'||b.state.length!==43)return failed('provider_failed');
    const cookie=cookieValue(r,'vc2_oauth_'+provider);if(!cookie||cookie.length!==43)return failed('browser_mismatch');
    const flow=await db.transaction(async tx=>{
      const f=await one(tx,'SELECT * FROM customer_oauth_flows WHERE state_hash=$1 FOR UPDATE',[hash(b.state)]);
      if(!f||f.provider!==provider||f.browser_hash!==hash(cookie)||f.status!=='pending'||new Date(f.expires_at)<=new Date()||f.client_id!==c.clientId)return null;
      await tx.query("UPDATE customer_oauth_flows SET status='processing' WHERE state_hash=$1",[f.state_hash]);return f;
    });if(!flow)return failed('flow_expired');
    try{
      if(b.error||typeof b.code!=='string'||!b.code.length||b.code.length>4096)throw Error('Provider cancelled');
      const identity=await adapter.exchange(provider,{code:b.code,nonce:flow.nonce,verifier:flow.verifier_cipher?vault.open(flow.verifier_cipher):null});
      let name=identity.name;if(provider==='apple'&&typeof b.user==='string'&&b.user.length<4000){try{const info=JSON.parse(b.user);name=[info.name?.firstName,info.name?.lastName].filter(v=>typeof v==='string').join(' ').slice(0,120);}catch{}}
      const result=await db.transaction(async tx=>{
        // Serialises first-time identities and matching email checks across both
        // providers. Never promotes a customer to a commercial team account.
        await tx.query("INSERT INTO phase2_settings(key,value) VALUES('customer_identity_lock','{}') ON CONFLICT(key) DO NOTHING");await tx.query("SELECT key FROM phase2_settings WHERE key='customer_identity_lock' FOR UPDATE");
        const identityRow=await one(tx,'SELECT * FROM customer_identities WHERE provider=$1 AND subject=$2',[provider,identity.subject]);let user;
        if(flow.intent==='link'){
          user=await one(tx,'SELECT u.* FROM customer_accounts u JOIN customer_sessions s ON s.customer_id=u.id WHERE u.id=$1 AND s.token_hash=$2 AND s.expires_at>now() AND s.auth_version=u.auth_version AND u.active AND u.email_verified FOR UPDATE OF u',[flow.target_id,flow.target_session_hash]);
          if(!user||user.auth_version!==flow.target_auth_version)throw Error('Target account revoked');
          if(identityRow&&identityRow.customer_id!==user.id)throw Error('Provider belongs to another account');
          if(await one(tx,'SELECT 1 FROM customer_identities WHERE customer_id=$1 AND provider=$2',[user.id,provider]))throw Error('Provider already linked');
          // Even with a verified provider email, another VII email account is
          // not merged or taken over. Explicit linking can keep a private relay.
          const emailOwner=await one(tx,'SELECT id FROM customer_accounts WHERE email=$1',[identity.email]);if(emailOwner&&emailOwner.id!==user.id)throw Object.assign(Error('Existing account'),{publicCode:'account_conflict'});
        }else if(identityRow){
          user=await one(tx,'SELECT * FROM customer_accounts WHERE id=$1 FOR UPDATE',[identityRow.customer_id]);if(!user?.active||!user.email_verified)throw Error('Access disabled');
        }else{
          if(await one(tx,'SELECT id FROM customer_accounts WHERE email=$1',[identity.email]))throw Object.assign(Error('Existing account'),{publicCode:'link_required'});
          user={id:randomUUID(),email:identity.email,name:name?.trim().length>=2?name.trim():'VII Customer',auth_version:1,active:true,email_verified:true,password_enabled:false};
          await tx.query('INSERT INTO customer_accounts(id,email,name,password_hash,email_verified,password_enabled) VALUES($1,$2,$3,$4,true,false)',[user.id,user.email,user.name,await passwordHash(token())]);
          await queueCommercialMail(tx,'customer-welcome:'+user.id,user.email,renderWelcomeMail(user,origin));
        }
        if(!identityRow)await tx.query('INSERT INTO customer_identities(provider,subject,customer_id,provider_email) VALUES($1,$2,$3,$4)',[provider,identity.subject,user.id,identity.email]);
        if(flow.intent==='link')await queueCommercialMail(tx,'identity-linked:'+user.id+':'+provider,user.email,serviceMail({subject:'A sign-in method was linked to your account',title:'Account security update',paragraphs:[`${provider==='google'?'Google':'Apple'} was linked to your VII account. Your orders and primary contact email remain unchanged.`],actionUrl:new URL('/cliente',origin).href}));
        const secret=token();await tx.query("INSERT INTO customer_sessions(token_hash,customer_id,auth_version,expires_at,provider) VALUES($1,$2,$3,now()+interval '8 hours',$4)",[hash(secret),user.id,user.auth_version,provider]);
        await tx.query("UPDATE customer_oauth_flows SET status='complete',verifier_cipher=NULL WHERE state_hash=$1",[flow.state_hash]);return{secret};
      });
      reply.header('Set-Cookie',[flowCookie(provider,'',0),clientCookie(result.secret)]);return reply.redirect('/cliente?auth_success='+provider,303);
    }catch(error){await db.query("UPDATE customer_oauth_flows SET status='failed',verifier_cipher=NULL WHERE state_hash=$1",[flow.state_hash]);return failed(error.publicCode||'provider_failed');}
  };
  app.get('/auth/google/callback',{config:{rateLimit:{max:30,timeWindow:'5 minutes'}}},(r,reply)=>callback('google',r,reply));
  await app.register(async scope=>{
    scope.addContentTypeParser('application/x-www-form-urlencoded',{parseAs:'string'},(_,body,done)=>{
      const values={};for(const [key,value]of new URLSearchParams(body)){if(Object.hasOwn(values,key))return done(Object.assign(Error('Duplicated authorization fields'),{statusCode:400}));values[key]=value;}done(null,values);
    });
    scope.post('/auth/apple/callback',{bodyLimit:32768,config:{rateLimit:{max:30,timeWindow:'5 minutes'}}},(r,reply)=>callback('apple',r,reply));
  });
  app.get('/api/client/auth/identities',{preHandler:customerGuard},async r=>({password_enabled:r.customer.password_enabled,items:(await db.query('SELECT provider,provider_email,linked_at FROM customer_identities WHERE customer_id=$1 ORDER BY provider',[r.customer.id])).rows,providers:availability()}));
  app.delete('/api/client/auth/identities/:provider',{preHandler:customerGuard,schema:{body:s.object({})}},async(r,reply)=>{
    const provider=r.params.provider;if(!['google','apple'].includes(provider))fail(404,'Provider not found.');
    await db.transaction(async tx=>{
      const user=await one(tx,'SELECT * FROM customer_accounts WHERE id=$1 FOR UPDATE',[r.customer.id]);
      if(!await one(tx,"SELECT 1 FROM customer_sessions WHERE token_hash=$1 AND auth_version=$2 AND expires_at>now()+interval '7 hours 45 minutes'",[hash(cookieValue(r,'vc2_client')),user.auth_version]))fail(401,'Sign in again before changing sign-in methods.');
      const methods=(await tx.query('SELECT provider FROM customer_identities WHERE customer_id=$1',[user.id])).rows;if(!methods.some(m=>m.provider===provider))fail(404,'Provider not linked.');
      if(!user.password_enabled&&methods.length<2)fail(409,'Keep another sign-in method before unlinking this provider.');
      await tx.query('DELETE FROM customer_identities WHERE customer_id=$1 AND provider=$2',[user.id,provider]);await tx.query('UPDATE customer_accounts SET auth_version=auth_version+1 WHERE id=$1',[user.id]);await tx.query('DELETE FROM customer_sessions WHERE customer_id=$1',[user.id]);
      await queueCommercialMail(tx,'identity-unlinked:'+user.id+':'+provider+':'+user.auth_version,user.email,serviceMail({subject:'A sign-in method was removed',title:'Account security update',paragraphs:[`${provider==='google'?'Google':'Apple'} was unlinked. All current sessions were closed. Sign in with a remaining method.`],actionUrl:new URL('/cliente',origin).href}));
    });reply.header('Set-Cookie','vc2_client=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'+(secure?'; Secure':''));return{signed_out:true};
  });
  return{availability};
}
