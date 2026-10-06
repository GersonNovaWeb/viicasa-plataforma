import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {stripeLocalConfig} from './stripe-local-config.mjs';

// Do not load .env: it may contain production settings and Firebase credentials.
let values;
try {values=parseEnv(await readFile(new URL('../.env.stripe.local',import.meta.url),'utf8'));}
catch {console.error('No se pudo leer .env.stripe.local en la raíz del proyecto.');process.exit(1);}
try {Object.assign(process.env,stripeLocalConfig(values));}
catch(error){console.error(error.message);process.exit(1);}

if(process.argv.includes('--check')){
  console.log('Formato de claves de prueba correcto. Valores ocultos; sin llamadas a Stripe ni Firebase.');
  console.log('Esto no verifica la vigencia de las claves ni que pertenezcan al mismo sandbox.');
}else{
  try{
    const response=await fetch('http://127.0.0.1:8088/',{signal:AbortSignal.timeout(3000)});
    if(!response.ok)throw new Error();
  }catch{console.error('El emulador de Firestore no está disponible en 127.0.0.1:8088. Inícialo antes de npm run dev:stripe.');process.exit(1);}
  console.log('VIICASA · Stripe sandbox · Firestore local · Sin cobros reales.');
  try {await import('./server.mjs');}
  catch {console.error('No se pudo iniciar el servidor de pruebas. Revisa el emulador y la configuración local.');process.exit(1);}
}
