import {spawn} from 'node:child_process';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,mkdtemp,writeFile,readFile,chmod,rm,lstat} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {databaseIdentity,postgresDatabase} from './postgres.mjs';
const kinds=['commercial','platform'];
const digest=value=>createHash('sha256').update(value).digest('hex');
const id=value=>digest(databaseIdentity(value));
const escapePass=value=>value.replaceAll('\\','\\\\').replaceAll(':','\\:');
export function backupKey(value){const key=Buffer.from(value||'','base64');if(key.length!==32||key.toString('base64')!==value)throw Error('Provide a separate 32-byte base64 PHASE2_BACKUP_KEY.');return key;}
export function backupPlan(env){
  if(env.PHASE2_DATABASE_DRIVER!=='postgres')throw Error('Remote backup requires PostgreSQL.');
  const sources={commercial:env.PHASE2_COMMERCIAL_DATABASE_URL,platform:env.PHASE2_PLATFORM_DATABASE_URL};
  if(id(sources.commercial)===id(sources.platform))throw Error('Backup databases must be distinct.');
  if(env.PHASE2_DATABASE_SSL==='false')throw Error('Remote backups require certificate-verified TLS.');
  return{sources,key:backupKey(env.PHASE2_BACKUP_KEY),vault_hash:digest(backupKey(env.PHASE2_VAULT_KEY))};
}
export function restorePlan(env,manifest){
  const plan=backupPlan(env),targets={commercial:env.PHASE2_RESTORE_COMMERCIAL_URL,platform:env.PHASE2_RESTORE_PLATFORM_URL};
  if(manifest.version!==1||manifest.kind!=='encrypted-phase2-postgres'||manifest.vault_hash!==plan.vault_hash||!Number.isFinite(Date.parse(manifest.created_at)))throw Error('Unsupported backup or incorrect vault key.');
  const sourceIds=[...Object.values(plan.sources).map(id),...kinds.map(k=>manifest.files?.[k]?.source)];
  if(id(targets.commercial)===id(targets.platform)||Object.values(targets).some(v=>sourceIds.includes(id(v))))throw Error('Restore targets must be new, distinct from all source databases.');
  for(const kind of kinds){const f=manifest.files?.[kind];if(!f||f.name!==kind+'.dump.enc'||!/^[a-f0-9]{64}$/.test(f.source)||!/^[a-f0-9]{64}$/.test(f.sha256)||!/^[a-f0-9]{24}$/.test(f.iv)||!/^[a-f0-9]{32}$/.test(f.tag))throw Error('Invalid backup manifest.');}
  return{...plan,targets};
}
function aad(manifest,kind){return Buffer.from(JSON.stringify({version:manifest.version,kind:manifest.kind,created_at:manifest.created_at,vault_hash:manifest.vault_hash,component:kind,source:manifest.files[kind].source}));}
async function checksum(path){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
async function tool(binary,args,url,tmp,{input,output}={}){
  const address=new URL(url);if(address.search)throw Error('Backup URLs may not contain query parameters.');
  const username=decodeURIComponent(address.username),password=decodeURIComponent(address.password),database=decodeURIComponent(address.pathname.slice(1));
  if([username,password,database,address.hostname].some(v=>/[\r\n]/.test(v)))throw Error('Invalid backup connection fields.');
  const passfile=join(tmp,'pgpass');await writeFile(passfile,[address.hostname,address.port||'5432',database,username,password].map(escapePass).join(':')+'\n',{mode:0o600,flag:'w'});await chmod(passfile,0o600);
  const environment=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^PG/i.test(name)&&!/^PHASE2_/.test(name)));
  Object.assign(environment,{PGHOST:address.hostname,PGPORT:address.port||'5432',PGDATABASE:database,PGUSER:username,PGPASSFILE:passfile,PGSSLMODE:'verify-full',PGCONNECT_TIMEOUT:'15'});
  const child=spawn(binary,args,{env:environment,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});child.stderr.resume();
  const completion=new Promise((yes,no)=>{child.on('error',()=>no(Error('PostgreSQL client could not start. Install compatible pg_dump/pg_restore.')));child.on('exit',code=>code===0?yes():no(Error('PostgreSQL operation did not complete. No success was recorded.')));});
  completion.catch(()=>{});const timeout=setTimeout(()=>child.kill(),10*60*1000);
  try{if(input)await pipeline(input,child.stdin);else child.stdin.end();if(output)await pipeline(child.stdout,output);else child.stdout.resume();await completion;}catch(error){child.kill();throw error;}finally{clearTimeout(timeout);}
}
export async function createRemoteBackup(env,{confirmed=false,runTool=tool,baseDirectory='data/backups'}={}){
  if(!confirmed)throw Error('Pause both web and worker processes, then confirm --confirm-stopped.');
  const plan=backupPlan(env),base=resolve(baseDirectory);await mkdir(base,{recursive:true,mode:0o700});const directory=await mkdtemp(join(base,'phase2-pg-')),tmp=await mkdtemp(join(base,'phase2-private-'));
  const manifest={version:1,kind:'encrypted-phase2-postgres',created_at:new Date().toISOString(),vault_hash:plan.vault_hash,requires_quiescence:true,restoration_verified:false,files:{}};
  try{for(const kind of kinds){const iv=randomBytes(12),f=manifest.files[kind]={name:kind+'.dump.enc',source:id(plan.sources[kind]),iv:iv.toString('hex')},cipher=createCipheriv('aes-256-gcm',plan.key,iv);cipher.setAAD(aad(manifest,kind));
      const path=join(directory,f.name),output=createWriteStream(path,{flags:'wx',mode:0o600}),encrypted=pipeline(cipher,output);encrypted.catch(()=>{});
      try{await runTool('pg_dump',['--format=custom','--no-password'],plan.sources[kind],tmp,{output:cipher});await encrypted;}catch(error){cipher.destroy();await encrypted.catch(()=>{});throw error;}
      f.tag=cipher.getAuthTag().toString('hex');f.sha256=await checksum(path);
    }await writeFile(join(directory,'backup.json'),JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});return{directory,manifest};
  }finally{await rm(tmp,{recursive:true,force:true});}
}
export async function restoreRemoteBackup(env,directory,{confirmed=false,trusted=false,runTool=tool,openDb=postgresDatabase}={}){
  if(!confirmed||!trusted)throw Error('Restore requires --confirm-empty-targets --trusted-backup. Never restore untrusted SQL archives.');
  directory=resolve(directory);const manifest=JSON.parse(await readFile(join(directory,'backup.json'),'utf8')),plan=restorePlan(env,manifest),tmp=await mkdtemp(join(directory,'restore-private-')),connections=[];
  try{
    // Authenticate/decrypt BOTH archives before touching either target.
    for(const kind of kinds){const f=manifest.files[kind],file=join(directory,f.name),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||await checksum(file)!==f.sha256)throw Error('Backup archive integrity failed.');const decipher=createDecipheriv('aes-256-gcm',plan.key,Buffer.from(f.iv,'hex'));decipher.setAAD(aad(manifest,kind));decipher.setAuthTag(Buffer.from(f.tag,'hex'));await pipeline(createReadStream(file),decipher,createWriteStream(join(tmp,kind+'.dump'),{flags:'wx',mode:0o600}));}
    for(const kind of kinds){const db=openDb(plan.targets[kind],{ssl:true});connections.push(db);await db.waitReady;const rows=(await db.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' UNION SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' LIMIT 1")).rows;if(rows.length)throw Error('Restore target is not empty. No overwrite is allowed.');}
    for(const kind of kinds)await runTool('pg_restore',['--no-password','--single-transaction','--exit-on-error','--no-owner','--no-acl','--dbname',decodeURIComponent(new URL(plan.targets[kind]).pathname.slice(1)),join(tmp,kind+'.dump')],plan.targets[kind],tmp);
    return{restored:true,application_verified:false,outbound_providers_must_remain_disabled:true};
  }finally{for(const db of connections)await db.close();await rm(tmp,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const args=process.argv.slice(2);if(args[0]==='restore'){const r=await restoreRemoteBackup(process.env,args[1],{confirmed:args.includes('--confirm-empty-targets'),trusted:args.includes('--trusted-backup')});console.log(JSON.stringify(r));}else{const r=await createRemoteBackup(process.env,{confirmed:args.includes('--confirm-stopped')});console.log('Encrypted private backup: '+r.directory+'\nKeep the backup key and vault key separately. Restore verification is still required.');}}catch{console.error('Phase 2 backup/restore incomplete. Verify guards, compatible PostgreSQL clients and private configuration; no credentials are printed.');process.exitCode=1;}
}
