import {openPhase2Databases} from './database.mjs';
import {runtimeProfile,installRuntimeProfile} from './runtime-profile.mjs';
const profile=runtimeProfile(process.env);if(process.env.PHASE2_DATABASE_DRIVER!=='postgres')throw Error('This command only migrates two separate Phase 2 PostgreSQL databases.');
const dbs=await openPhase2Databases('',{driver:'postgres',commercialUrl:process.env.PHASE2_COMMERCIAL_DATABASE_URL,platformUrl:process.env.PHASE2_PLATFORM_DATABASE_URL,ssl:process.env.PHASE2_DATABASE_SSL!=='false'});
try{await installRuntimeProfile(dbs,profile);}finally{await dbs.close();}console.log('Phase 2 schemas/profile ready. No seed, mail or payment was executed.');
