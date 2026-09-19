import { configFromEnv } from '../src/config.js';
import { openDatabase,migrate } from '../src/db.js';
import { deliverMail } from '../src/notifications.js';
const config=configFromEnv();
if(config.driver==='firestore'){
  const {openFirestore}=await import('../src/firestore-store.js');
  const {deliverMail:deliver}=await import('../src/firestore-payments.js');
  const store=await openFirestore(config);
  try{console.log(await deliver(store,config));}finally{await store.close();}
}else{
const db=await openDatabase(config);
try{await migrate(db);console.log(await deliverMail(db,config));}finally{await db.close();}
}
