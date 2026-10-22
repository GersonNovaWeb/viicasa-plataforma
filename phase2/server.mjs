import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openPhase2Databases} from './database.mjs';
import {seedPhase2} from './bootstrap.mjs';
import {secretVault} from './security.mjs';
import {buildPhase2App} from './app.mjs';
import {workerRole} from './worker-runtime.mjs';
import {runtimeProfile,installRuntimeProfile} from './runtime-profile.mjs';

const profile=runtimeProfile(process.env);
const role=workerRole(process.env);
const root=fileURLToPath(new URL('../',import.meta.url)),data=resolve(root,profile.directory);
await mkdir(data,{recursive:true});
const vaultFile=resolve(data,'vault.key');let key;
if(process.env.PHASE2_VAULT_KEY){
  key=Buffer.from(process.env.PHASE2_VAULT_KEY,'base64');
  if(key.length!==32||key.toString('base64')!==process.env.PHASE2_VAULT_KEY)throw Error('PHASE2_VAULT_KEY must be 32 random bytes encoded as base64.');
}else{
  if(process.env.PHASE2_DATABASE_DRIVER==='postgres')throw Error('Remote demo databases require a persistent PHASE2_VAULT_KEY. Never change it after creating users.');
  try{key=await readFile(vaultFile);}catch(e){if(e.code!=='ENOENT')throw e;key=randomBytes(32);await writeFile(vaultFile,key,{flag:'wx',mode:0o600});}
}
if(key.length!==32)throw Error('Invalid Phase 2 vault key.');
const port=Number(process.env.PORT||3030),host=process.env.HOST||'127.0.0.1';
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid PORT.');
const origin=process.env.PHASE2_SITE_URL||`http://127.0.0.1:${port}`;
if(new URL(origin).origin!==origin)throw Error('PHASE2_SITE_URL must be an origin without a trailing slash.');
const databases=await openPhase2Databases(data,{driver:process.env.PHASE2_DATABASE_DRIVER||'pglite',commercialUrl:process.env.PHASE2_COMMERCIAL_DATABASE_URL,platformUrl:process.env.PHASE2_PLATFORM_DATABASE_URL,ssl:process.env.PHASE2_DATABASE_SSL!=='false'});await installRuntimeProfile(databases,profile);if(role!=='worker'&&profile.seedExamples)await seedPhase2(databases);
const app=await buildPhase2App(databases,secretVault(key),{origin,stripeKey:process.env.PHASE2_STRIPE_SECRET_KEY,stripeWebhookSecret:process.env.PHASE2_STRIPE_WEBHOOK_SECRET,mailMode:process.env.PHASE2_MAIL_MODE||'outbox',mailFrom:process.env.PHASE2_MAIL_FROM,adminEmail:process.env.PHASE2_ADMIN_EMAIL,
  smtp:{host:process.env.PHASE2_SMTP_HOST,port:Number(process.env.PHASE2_SMTP_PORT||587),secure:process.env.PHASE2_SMTP_SECURE==='true',user:process.env.PHASE2_SMTP_USER,password:process.env.PHASE2_SMTP_PASSWORD},connectionEnvironment:process.env,mode:profile.mode});
if(role!=='worker')await app.listen({port,host});console.log(role==='worker'?'VII Phase 2 dedicated worker.':`VII Phase 2 demo: ${origin}\nTeam portal: ${origin}/equipo\nIndependent databases: ${databases.driver==='postgres'?'Remote PostgreSQL (demo)':'data/phase2/platform + data/phase2/commercial'}`);
const cycle=async()=>{try{const result=await app.processMail();if(result.status==='partial')console.error('Phase 2 worker has incomplete steps. Review private operation status.');}catch{console.error('Phase 2 worker cycle incomplete. No external status was assumed.');}};
const mailTimer=role==='web'?null:setInterval(cycle,30000);if(role==='embedded')mailTimer.unref();if(role==='worker')await cycle();
let closing=false;const shutdown=async()=>{if(closing)return;closing=true;if(mailTimer)clearInterval(mailTimer);await app.drainWorker();await app.close();await databases.close();process.exit(0);};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
