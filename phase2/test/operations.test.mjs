import {test} from 'node:test';
import assert from 'node:assert/strict';
import {moduleFixture} from './module-fixture.mjs';
import {backgroundProcessor,workerRole} from '../worker-runtime.mjs';
import {backupPlan,restorePlan,createRemoteBackup,restoreRemoteBackup} from '../backup-postgres.mjs';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {databaseIdentity} from '../postgres.mjs';
test('worker serialises local cycles, records sanitised partial outcomes and preserves later tasks',async t=>{
  const f=await moduleFixture(t),done=[];let release;const wait=new Promise(r=>release=r),p=backgroundProcessor(f.db,[['first',async()=>{await wait;done.push('first');}],['failure',async()=>{throw Error('secret-credential-never-record');}],['last',async()=>done.push('last')]]);
  const first=p.run();assert.equal((await p.run()).skipped,true);release();const result=await first;assert.equal(result.status,'partial');assert.deepEqual(done,['first','last']);assert.ok(!JSON.stringify(await p.status()).includes('secret-credential'));assert.equal((await f.call('/api/commercial/operations/worker',{cookie:f.seller.cookie})).statusCode,403);assert.equal((await f.call('/health/ready')).json().ok,true);
  assert.equal(workerRole({}), 'embedded');assert.throws(()=>workerRole({PHASE2_RUN_ROLE:'worker'}),/single process/);assert.equal(workerRole({PHASE2_RUN_ROLE:'worker',PHASE2_DATABASE_DRIVER:'postgres'}),'worker');
});
test('remote backup and restore reject TLS downgrade, shared databases, original targets and wrong vault',()=>{
  const key=Buffer.alloc(32,71).toString('base64'),env={PHASE2_DATABASE_DRIVER:'postgres',PHASE2_BACKUP_KEY:key,PHASE2_VAULT_KEY:Buffer.alloc(32,72).toString('base64'),PHASE2_COMMERCIAL_DATABASE_URL:'postgresql://fixture:fictional@localhost:5432/source_a',PHASE2_PLATFORM_DATABASE_URL:'postgresql://fixture:fictional@localhost:5432/source_b',PHASE2_RESTORE_COMMERCIAL_URL:'postgresql://fixture:fictional@localhost:5432/empty_a',PHASE2_RESTORE_PLATFORM_URL:'postgresql://fixture:fictional@localhost:5432/empty_b'};
  const plan=backupPlan(env),manifest={version:1,kind:'encrypted-phase2-postgres',created_at:new Date().toISOString(),vault_hash:plan.vault_hash,files:Object.fromEntries(['commercial','platform'].map(k=>[k,{name:k+'.dump.enc',source:createHash('sha256').update(databaseIdentity(plan.sources[k])).digest('hex'),sha256:'a'.repeat(64),iv:'b'.repeat(24),tag:'c'.repeat(32)}]))};
  assert.ok(restorePlan(env,manifest));assert.throws(()=>backupPlan({...env,PHASE2_DATABASE_SSL:'false'}),/TLS/);assert.throws(()=>backupPlan({...env,PHASE2_PLATFORM_DATABASE_URL:env.PHASE2_COMMERCIAL_DATABASE_URL}),/distinct/);assert.throws(()=>restorePlan({...env,PHASE2_RESTORE_PLATFORM_URL:env.PHASE2_PLATFORM_DATABASE_URL},manifest),/new, distinct/);assert.throws(()=>restorePlan({...env,PHASE2_VAULT_KEY:key},manifest),/vault/);assert.throws(()=>restorePlan(env,{...manifest,files:{...manifest.files,commercial:{...manifest.files.commercial,name:'../outside.dump'}}}),/manifest/);
});
test('backup pipeline encrypts both archives, authenticates before restore and never overwrites a populated target',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'viicasa-backup-fixture-'));t.after(()=>rm(directory,{recursive:true,force:true}));const env={PHASE2_DATABASE_DRIVER:'postgres',PHASE2_BACKUP_KEY:Buffer.alloc(32,81).toString('base64'),PHASE2_VAULT_KEY:Buffer.alloc(32,82).toString('base64'),PHASE2_COMMERCIAL_DATABASE_URL:'postgres://fixture:fictional@localhost/source_a',PHASE2_PLATFORM_DATABASE_URL:'postgres://fixture:fictional@localhost/source_b',PHASE2_RESTORE_COMMERCIAL_URL:'postgres://fixture:fictional@localhost/target_a',PHASE2_RESTORE_PLATFORM_URL:'postgres://fixture:fictional@localhost/target_b'};
  const backup=await createRemoteBackup(env,{confirmed:true,baseDirectory:directory,runTool:async(binary,args,url,tmp,{output})=>output.end(Buffer.from('PGDMP-private-'+new URL(url).pathname))});
  const encrypted=await readFile(join(backup.directory,'commercial.dump.enc'));assert.ok(!encrypted.includes(Buffer.from('PGDMP-private')));let restored=0;
  const openDb=()=>({waitReady:Promise.resolve(),query:async()=>({rows:[]}),close:async()=>{}}),runTool=async(binary,args)=>{assert.equal(binary,'pg_restore');assert.ok(args.includes('--single-transaction'));assert.ok(!args.includes('--clean'));assert.ok((await readFile(args.at(-1),'utf8')).startsWith('PGDMP-private-'));restored++;};
  assert.equal((await restoreRemoteBackup(env,backup.directory,{confirmed:true,trusted:true,openDb,runTool})).restored,true);assert.equal(restored,2);
  await assert.rejects(restoreRemoteBackup(env,backup.directory,{confirmed:true,trusted:true,runTool,openDb:()=>({...openDb(),query:async()=>({rows:[{}]})})}),/not empty/);assert.equal(restored,2);
  encrypted[0]^=1;await writeFile(join(backup.directory,'commercial.dump.enc'),encrypted);await assert.rejects(restoreRemoteBackup(env,backup.directory,{confirmed:true,trusted:true,openDb,runTool}),/integrity/);assert.equal(restored,2);
});
