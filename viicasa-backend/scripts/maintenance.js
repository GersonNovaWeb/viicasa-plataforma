import { configFromEnv } from '../src/config.js';
import { openDatabase,migrate } from '../src/db.js';
import { expireHolds } from '../src/commerce.js';
const config=configFromEnv();
if(config.driver==='firestore'){
  const {openFirestore}=await import('../src/firestore-store.js');
  const {expireHolds:expire}=await import('../src/firestore-commerce.js');
  const store=await openFirestore(config);
  try{console.log(await expire(store));}finally{await store.close();}
}else{
const db=await openDatabase(config);
try{await migrate(db);console.log(await expireHolds(db));}finally{await db.close();}
}
