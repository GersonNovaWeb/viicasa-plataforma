import { configFromEnv } from './config.js';
import { buildApp } from './app.js';
import { expireHolds } from './commerce.js';
import { deliverMail } from './notifications.js';

const config=configFromEnv();
const app=await buildApp(config);
await app.listen({host:config.host,port:config.port});
let running=null;
const interval=setInterval(()=>{
  if(running)return;
  running=(async()=>{
    if(app.maintenance){await app.maintenance();return;}
    await expireHolds(app.db);
    await deliverMail(app.db,config);
    await app.db.query('DELETE FROM sessions WHERE expires_at<=now()');
  })().catch(()=>app.log.error('Falló el mantenimiento; se reintentará en el siguiente ciclo')).finally(()=>{running=null;});
},30000);
let shuttingDown=false;
async function shutdown(){
  if(shuttingDown)return;shuttingDown=true;clearInterval(interval);
  if(running)await running;
  await app.close();
}
process.on('SIGINT',shutdown);
process.on('SIGTERM',shutdown);
