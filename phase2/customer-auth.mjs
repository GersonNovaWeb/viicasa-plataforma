import {randomUUID,randomInt,timingSafeEqual} from 'node:crypto';
import {hash,token,fail,passwordHash,passwordMatches} from '../viicasa-backend/src/lib.js';
import {cookieValue} from './api.mjs';
import * as s from '../viicasa-backend/src/schemas.js';
import {queueCommercialMail,serviceMail} from './mail.mjs';
import {renderWelcomeMail} from '../viicasa-backend/src/platform-mail.js';

export const customerProfile=u=>({id:u.id,name:u.name,email:u.email,email_verified:u.email_verified,login_provider:u.login_provider||'password',password_enabled:u.password_enabled!==false,registration:{region:null}});
export async function authenticatedCustomer(db,secret){
  if(!secret)return null;return(await db.query('SELECT u.*,s.provider AS login_provider FROM customer_sessions s JOIN customer_accounts u ON u.id=s.customer_id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.auth_version=u.auth_version AND u.active AND u.email_verified',[hash(secret)])).rows[0]||null;
}
export async function registerCustomers(app,{db,origin}){
  const prefix='/api/client',dummy=await passwordHash(token()),secure=origin.startsWith('https:');
  const cookie=(secret,age=28800)=>`vc2_client=${secret}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure?'; Secure':''}`;
  const guard=async r=>{const customer=await authenticatedCustomer(db,cookieValue(r,'vc2_client'));if(!customer)fail(401,'Sign in with a verified customer account.');r.customer=customer;};
  app.addHook('onRequest',async r=>{if(r.url.startsWith(prefix)&&!['GET','HEAD'].includes(r.method)&&r.headers.origin!==origin)fail(403,'Request origin is not allowed.');});
  const route=(method,path,body,handler,{privateRoute=false}={})=>app.route({method,url:prefix+path,...(body?{schema:{body}}:{}),...(privateRoute?{preHandler:guard}:{config:{rateLimit:{max:15,timeWindow:'5 minutes'}}}),handler});
  const challenge=async(tx,u,purpose)=>{
    const secret=token(),code=String(randomInt(0,1000000)).padStart(6,'0');
    await tx.query('UPDATE customer_challenges SET used=true WHERE customer_id=$1 AND purpose=$2 AND NOT used',[u.id,purpose]);
    await tx.query("INSERT INTO customer_challenges(token_hash,customer_id,code_hash,purpose,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')",[hash(secret),u.id,hash(secret+':'+code),purpose]);
    await queueCommercialMail(tx,'customer-code:'+hash(secret),u.email,serviceMail({subject:purpose==='reset'?'Reset your password':'Verify your email',title:purpose==='reset'?'Password reset':'Confirm your email',paragraphs:[`Hello ${u.name},`,`Your verification code is ${code}. It expires in 10 minutes.`,purpose==='reset'?'Enter it on the password reset screen.':'Enter it to verify your email and open your VII account.'],actionUrl:new URL('/cliente',origin).href}));
    return{challenge:secret,needs_verification:true};
  };
  route('POST','/register',s.object({name:s.str(120,2),email:s.email,password:s.str(128,12)}),async r=>db.transaction(async tx=>{
    const b=r.body,email=b.email.toLowerCase().trim(),existing=(await tx.query('SELECT * FROM customer_accounts WHERE email=$1 FOR UPDATE',[email])).rows[0];
    if(existing){if(existing.email_verified||!await passwordMatches(b.password,existing.password_hash))fail(409,'Please sign in or use password recovery.');return challenge(tx,existing,'verify');}
    const u={id:randomUUID(),email,name:b.name};await tx.query('INSERT INTO customer_accounts(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[u.id,email,b.name,await passwordHash(b.password)]);return challenge(tx,u,'verify');
  }));
  route('POST','/login',s.object({email:s.email,password:s.str(128,1)}),async(r,reply)=>{
    const u=(await db.query('SELECT * FROM customer_accounts WHERE email=$1',[r.body.email.toLowerCase().trim()])).rows[0];
    if(!await passwordMatches(r.body.password,u?.password_hash||dummy)||!u?.active||!u.password_enabled)fail(401,'Email or password is incorrect.');
    if(!u.email_verified)return db.transaction(tx=>challenge(tx,u,'verify'));
    const secret=token();await db.transaction(async tx=>{const current=(await tx.query('SELECT * FROM customer_accounts WHERE id=$1 FOR UPDATE',[u.id])).rows[0];if(!current.active||current.auth_version!==u.auth_version)fail(401,'Access changed. Sign in again.');await tx.query("INSERT INTO customer_sessions(token_hash,customer_id,auth_version,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",[hash(secret),u.id,u.auth_version]);});
    reply.header('Set-Cookie',cookie(secret));return{profile:customerProfile(u)};
  });
  const consumeCode=async(tx,secret,code,purpose)=>{
    const c=(await tx.query('SELECT * FROM customer_challenges WHERE token_hash=$1 FOR UPDATE',[hash(secret)])).rows[0];
    if(!c||c.purpose!==purpose||c.used||c.attempts>=5||new Date(c.expires_at)<=new Date())return null;
    const valid=timingSafeEqual(Buffer.from(c.code_hash),Buffer.from(hash(secret+':'+code)));
    if(!valid){await tx.query('UPDATE customer_challenges SET attempts=attempts+1 WHERE token_hash=$1',[hash(secret)]);return null;}
    await tx.query('UPDATE customer_challenges SET used=true WHERE token_hash=$1',[hash(secret)]);return c;
  };
  route('POST','/verify',s.object({challenge:s.str(43,43),code:{type:'string',pattern:'^\\d{6}$'}}),async(r,reply)=>{
    const result=await db.transaction(async tx=>{
      const c=await consumeCode(tx,r.body.challenge,r.body.code,'verify');if(!c)return null;
      const u=(await tx.query('SELECT * FROM customer_accounts WHERE id=$1 FOR UPDATE',[c.customer_id])).rows[0];if(!u.active)return null;
      await tx.query('UPDATE customer_accounts SET email_verified=true WHERE id=$1',[u.id]);
      if(!u.email_verified)await queueCommercialMail(tx,'customer-welcome:'+u.id,u.email,renderWelcomeMail(u,origin));
      const secret=token();await tx.query("INSERT INTO customer_sessions(token_hash,customer_id,auth_version,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",[hash(secret),u.id,u.auth_version]);return{secret,profile:customerProfile({...u,email_verified:true})};
    });if(!result)fail(401,'Verification code is invalid or expired.');reply.header('Set-Cookie',cookie(result.secret));return{profile:result.profile};
  });
  route('POST','/recover',s.object({email:s.email}),async r=>{
    const u=(await db.query('SELECT * FROM customer_accounts WHERE email=$1 AND active AND email_verified',[r.body.email.toLowerCase().trim()])).rows[0];
    const result=u?await db.transaction(tx=>challenge(tx,u,'reset')):{challenge:token()};return{challenge:result.challenge,message:'If an account exists, a recovery code has been sent.'};
  });
  route('POST','/reset',s.object({challenge:s.str(43,43),code:{type:'string',pattern:'^\\d{6}$'},password:s.str(128,12)}),async r=>{
    const digest=await passwordHash(r.body.password);
    const result=await db.transaction(async tx=>{const c=await consumeCode(tx,r.body.challenge,r.body.code,'reset');if(!c)return false;await tx.query('UPDATE customer_accounts SET password_hash=$2,password_enabled=true,auth_version=auth_version+1 WHERE id=$1 AND active',[c.customer_id,digest]);await tx.query('DELETE FROM customer_sessions WHERE customer_id=$1',[c.customer_id]);return true;});if(!result)fail(401,'Recovery code is invalid or expired.');return{ok:true};
  });
  route('GET','/me',null,r=>({profile:customerProfile(r.customer)}),{privateRoute:true});
  route('POST','/logout',s.object({}),async(r,reply)=>{await db.query('DELETE FROM customer_sessions WHERE token_hash=$1',[hash(cookieValue(r,'vc2_client'))]);reply.header('Set-Cookie',cookie('',0));return{ok:true};},{privateRoute:true});
  return{customerGuard:guard};
}
