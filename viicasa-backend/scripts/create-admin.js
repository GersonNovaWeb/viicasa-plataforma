import { configFromEnv } from '../src/config.js';
import { openDatabase,migrate } from '../src/db.js';
import { id,passwordHash,audit } from '../src/lib.js';
const email=process.env.ADMIN_CREATE_EMAIL?.trim().toLowerCase(),password=process.env.ADMIN_CREATE_PASSWORD;
const role=process.env.ADMIN_CREATE_ROLE||'admin';
if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length<12 || password.length>128 || !['admin','catalog','support','viewer'].includes(role)){
  throw new Error('Configura ADMIN_CREATE_EMAIL, ADMIN_CREATE_PASSWORD (12-128 caracteres) y opcionalmente ADMIN_CREATE_ROLE');
}
if(configFromEnv().driver==='firestore'){
  await import('./firestore-admin.js');
}else{
const db=await openDatabase(configFromEnv());
try{
  await migrate(db);const userId=id(),encoded=await passwordHash(password);
  await db.transaction(async tx=>{
    await tx.query('INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5)',[userId,email,process.env.ADMIN_CREATE_NAME||'Administración VIICASA',encoded,role]);
    await audit(tx,userId,'user.bootstrap',userId);
  });console.log('Usuario creado. No se muestran credenciales.');
}finally{await db.close();}
}
