import {configFromEnv} from '../src/config.js';
import {openFirestore,initializeStore} from '../src/firestore-store.js';
import {createUser} from '../src/firestore-auth.js';
const email=process.env.ADMIN_CREATE_EMAIL?.trim().toLowerCase(),password=process.env.ADMIN_CREATE_PASSWORD,role=process.env.ADMIN_CREATE_ROLE||'admin';
if(!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!password||password.length<12||password.length>128||!['admin','catalog','support','viewer'].includes(role))throw new Error('Configura ADMIN_CREATE_EMAIL, ADMIN_CREATE_PASSWORD (12-128 caracteres) y opcionalmente ADMIN_CREATE_ROLE');
const store=await openFirestore(configFromEnv());
try{await initializeStore(store);await createUser(store,{email,password,role,name:process.env.ADMIN_CREATE_NAME||'Administración VIICASA'});console.log('Usuario creado; no se muestran credenciales.');}
finally{await store.close();}
