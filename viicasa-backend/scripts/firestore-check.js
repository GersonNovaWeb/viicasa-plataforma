import {configFromEnv} from '../src/config.js';
import {openFirestore} from '../src/firestore-store.js';
const config=configFromEnv(),store=await openFirestore(config);
try{
  // Read-only: this probe must not initialize or populate the client's project.
  await store.get('system','schema');
  console.log(`Conexión de lectura correcta: ${config.firebaseProjectId} (${config.firebaseMode}).`);
}finally{await store.close();}
