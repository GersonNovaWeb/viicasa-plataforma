import {createInterface,emitKeypressEvents} from 'node:readline';
import {openPhase2Databases} from './database.mjs';
import {runtimeProfile,installRuntimeProfile,initialiseAdministrator} from './runtime-profile.mjs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
async function privateInput(){
  if(!process.stdin.isTTY){let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>4096)throw Error('Input exceeds limit.');}return JSON.parse(input);}
  const rl=createInterface({input:process.stdin,output:process.stdout}),ask=q=>new Promise(r=>rl.question(q,r));const name=await ask('Administrator name: '),email=await ask('Administrator email: '),yes=await ask('Create the first administrator in staging? Type YES: ');rl.close();
  process.stdout.write('Password (hidden; at least 16 characters): ');emitKeypressEvents(process.stdin);process.stdin.setRawMode(true);process.stdin.resume();
  const password=await new Promise((resolve,reject)=>{let value='';const key=(str,k)=>{if(k?.ctrl&&k.name==='c'){finish();reject(Error('Cancelled'));}else if(k?.name==='return'){finish();resolve(value);}else if(k?.name==='backspace')value=value.slice(0,-1);else if(str&&!k?.ctrl&&!k?.meta&&value.length<129)value+=str;};const finish=()=>{process.stdin.off('keypress',key);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');};process.stdin.on('keypress',key);});return{name,email,password,confirmed:yes==='YES'};
}
let databases;
try{const profile=runtimeProfile(process.env);if(profile.mode!=='staging')throw Error('Use staging.');const payload=await privateInput(),root=fileURLToPath(new URL('../',import.meta.url));databases=await openPhase2Databases(resolve(root,profile.directory),{driver:process.env.PHASE2_DATABASE_DRIVER||'pglite',commercialUrl:process.env.PHASE2_COMMERCIAL_DATABASE_URL,platformUrl:process.env.PHASE2_PLATFORM_DATABASE_URL,ssl:process.env.PHASE2_DATABASE_SSL!=='false'});await installRuntimeProfile(databases,profile);await initialiseAdministrator(databases.commercial,payload);console.log('Initial administrator created. Sign in at /admin and complete mandatory two-step setup. No example account, email or payment was created.');}
catch{console.error('Administrator setup incomplete. Verify staging, fresh databases and private input. Existing users were not changed.');process.exitCode=1;}finally{if(databases)await databases.close();}
