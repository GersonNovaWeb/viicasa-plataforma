import {randomBytes,createHmac,timingSafeEqual,createCipheriv,createDecipheriv} from 'node:crypto';
import {hash,token,fail,passwordMatches} from '../viicasa-backend/src/lib.js';

const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function totpSecret(){let bits='';for(const b of randomBytes(20))bits+=b.toString(2).padStart(8,'0');return bits.match(/.{5}/g).map(b=>alphabet[parseInt(b,2)]).join('');}
export function totp(secret,counter=Math.floor(Date.now()/30000)){
  const bits=[...secret].map(c=>{const n=alphabet.indexOf(c);if(n<0)throw Error('Invalid TOTP secret');return n.toString(2).padStart(5,'0');}).join('');
  const key=Buffer.from((bits.match(/.{8}/g)||[]).map(b=>parseInt(b,2))),message=Buffer.alloc(8);message.writeBigUInt64BE(BigInt(counter));
  const hmac=createHmac('sha1',key).update(message).digest(),offset=hmac[19]&15;
  return String((hmac.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
}
export function verifyTotp(secret,code,previous=-1,now=Date.now()){
  if(!/^\d{6}$/.test(code))return null;const counter=Math.floor(now/30000);
  for(const step of [counter,counter-1,counter+1])if(step>Number(previous)&&timingSafeEqual(Buffer.from(totp(secret,step)),Buffer.from(code)))return step;
  return null;
}
export function secretVault(key){
  return {
    seal(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');},
    open(value){const data=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));cipher.setAuthTag(data.subarray(12,28));return Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]).toString('utf8');},
  };
}
export const safeUser=u=>({id:u.id,email:u.email,name:u.name,role:u.role,active:u.active,phone:u.phone,goal_minor:Number(u.goal_minor),mfa_enabled:Boolean(u.totp_secret&&u.totp_counter>=0)});
export async function sessionUser(db,secret){
  if(!secret)return null;
  const row=(await db.query('SELECT u.* FROM team_sessions s JOIN team_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active AND NOT u.deleted AND s.auth_version=u.auth_version',[hash(secret)])).rows[0];return row||null;
}
export async function beginLogin(db,vault,email,password,dummyHash,requestedRole=null){
  const user=(await db.query('SELECT * FROM team_users WHERE email=$1',[email.toLowerCase().trim()])).rows[0];
  const valid=await passwordMatches(password,user?.password_hash||dummyHash);
  if(!valid||!user?.active||user.deleted)fail(401,'Email or password is incorrect.');
  if(requestedRole&&user.role!==requestedRole)fail(403,'This account cannot access the selected portal.');
  return db.transaction(async tx=>{
    const current=(await tx.query('SELECT * FROM team_users WHERE id=$1 FOR UPDATE',[user.id])).rows[0];
    if(!current.active||current.deleted||current.auth_version!==user.auth_version)fail(401,'Access changed. Sign in again.');
    if(requestedRole&&current.role!==requestedRole)fail(403,'This account cannot access the selected portal.');
    let setup=current.totp_counter<0,secret;
    if(setup){secret=totpSecret();await tx.query('UPDATE team_users SET totp_secret=$2,totp_counter=-1 WHERE id=$1',[user.id,vault.seal(secret)]);await tx.query('DELETE FROM team_challenges WHERE user_id=$1',[user.id]);}
    const challenge=token();await tx.query("INSERT INTO team_challenges(token_hash,user_id,auth_version,expires_at,requested_role) VALUES($1,$2,$3,now()+interval '5 minutes',$4)",[hash(challenge),user.id,current.auth_version,requestedRole]);
    return{challenge,setup,...(setup?{secret,uri:`otpauth://totp/VII%20Phase%202:${encodeURIComponent(user.email)}?secret=${secret}&issuer=VII%20Phase%202&algorithm=SHA1&digits=6&period=30`}:{})};
  });
}
export async function finishLogin(db,vault,challenge,code,requestedRole=null){
  // Count rejected attempts in a committed transaction, not one rolled back by fail().
  const outcome=await db.transaction(async tx=>{
    const c=(await tx.query('SELECT * FROM team_challenges WHERE token_hash=$1 FOR UPDATE',[hash(challenge)])).rows[0];
    if(!c||new Date(c.expires_at)<=new Date()||c.attempts>=5)return{error:'Sign-in challenge expired. Start again.'};
    const u=(await tx.query('SELECT * FROM team_users WHERE id=$1 FOR UPDATE',[c.user_id])).rows[0];
    if(!u.active||u.deleted||u.auth_version!==c.auth_version)return{error:'Access changed. Sign in again.'};
    if(c.requested_role&&u.role!==c.requested_role||requestedRole&&u.role!==requestedRole){
      await tx.query('UPDATE team_challenges SET attempts=attempts+1 WHERE token_hash=$1',[hash(challenge)]);return{error:'This account cannot access the selected portal.'};
    }
    let hashes=u.recovery_hashes,step=verifyTotp(vault.open(u.totp_secret),code,u.totp_counter),usingBackup=false;
    if(step===null&&u.totp_counter>=0&&hashes.includes(hash(code))){usingBackup=true;hashes=hashes.filter(h=>h!==hash(code));}
    if(step===null&&!usingBackup){await tx.query('UPDATE team_challenges SET attempts=attempts+1 WHERE token_hash=$1',[hash(challenge)]);return{error:'Invalid or already used verification code.'};}
    let recovery;
    if(u.totp_counter<0){recovery=Array.from({length:8},()=>randomBytes(8).toString('hex'));hashes=recovery.map(hash);}
    await tx.query('UPDATE team_users SET totp_counter=$2,recovery_hashes=$3 WHERE id=$1',[u.id,usingBackup?u.totp_counter:step,JSON.stringify(hashes)]);
    await tx.query('DELETE FROM team_challenges WHERE token_hash=$1',[hash(challenge)]);
    const secret=token();await tx.query("INSERT INTO team_sessions(token_hash,user_id,auth_version,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",[hash(secret),u.id,u.auth_version]);
    return{secret,user:safeUser({...u,totp_counter:step??u.totp_counter}),...(recovery?{recovery}: {})};
  });
  if(outcome.error)fail(401,outcome.error);return outcome;
}
