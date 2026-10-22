import {mkdir,readFile,cp,writeFile,stat,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {runtimeProfile} from './runtime-profile.mjs';

// Offline only: never take a filesystem copy of a running PostgreSQL engine.
if(!process.argv.includes('--confirm-stopped'))throw Error('Stop the Phase 2 server, then run npm run backup:phase2 -- --confirm-stopped. No backup was created.');
if((process.env.PHASE2_DATABASE_DRIVER||'pglite')!=='pglite')throw Error('For remote databases, use provider snapshots/pg_dump for both databases and back up the vault key separately.');
const profile=runtimeProfile(process.env),root=fileURLToPath(new URL('../',import.meta.url)),source=resolve(root,profile.directory);
for(const name of ['platform','commercial'])await access(join(source,name));
const key=process.env.PHASE2_VAULT_KEY?Buffer.from(process.env.PHASE2_VAULT_KEY,'base64'):await readFile(join(source,'vault.key'));if(key.length!==32||process.env.PHASE2_VAULT_KEY&&key.toString('base64')!==process.env.PHASE2_VAULT_KEY)throw Error('Invalid vault key.');
const destination=resolve(root,'data/backups/phase2-'+profile.mode+'-'+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(resolve(root,'data/backups'),{recursive:true,mode:0o700});
await mkdir(destination,{recursive:false,mode:0o700});
for(const name of ['platform','commercial']){if(!(await stat(join(source,name))).isDirectory())throw Error('Database directory not found.');await cp(join(source,name),join(destination,name),{recursive:true,errorOnExist:true,force:false});}
await writeFile(join(destination,'vault.key'),key,{flag:'wx',mode:0o600});
await writeFile(join(destination,'backup.json'),JSON.stringify({version:1,kind:'offline-pglite-'+profile.mode,profile:profile.mode,created_at:new Date().toISOString(),requires_server_stopped:true,contains_private_credentials:true,components:['platform','commercial','vault.key'],restoration_verified:false},null,2),{flag:'wx',mode:0o600});
console.log('Private offline backup created in '+destination+'\nContains personal data and encryption key. Do not publish or share. Restore validation remains required.');
