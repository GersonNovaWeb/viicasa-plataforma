// Isolated, disposable browser QA. No .env, SMTP, provider APIs or durable data.
import {openPhase2Databases} from './database.mjs';
import {seedPhase2} from './bootstrap.mjs';
import {buildPhase2App} from './app.mjs';
import {secretVault} from './security.mjs';
import {randomUUID} from 'node:crypto';
const origin='http://127.0.0.1:3038',dbs=await openPhase2Databases('',{memory:true});await seedPhase2(dbs);
const app=await buildPhase2App(dbs,secretVault(Buffer.alloc(32,61)),{origin,testing:true});
const row=(await dbs.commercial.query("SELECT * FROM service_catalogue WHERE id='home-cleaning'")).rows[0];await dbs.commercial.query('UPDATE service_catalogue SET content=$2 WHERE id=$1',[row.id,JSON.stringify({...row.content,published:true,images:['/assets/life.png'],pricing:{kind:'fixed',amount_minor:9999,basis:'hour',currency:'CAD'}})]);
await app.listen({host:'127.0.0.1',port:3038});console.log(origin+'/servicios/home-cleaning');
const r=await app.inject({url:'/api/viilife/requests',method:'POST',headers:{origin,'idempotency-key':randomUUID()},payload:{selection:{service:'routine',frequency:'weekly',hours:4,full_clean:false,extras:[]},schedule:{days:['mon'],start_date:new Date(Date.now()+7*86400000).toISOString().slice(0,10),start_hour:8},address:{street:'123 Fictional Home',city:'Kelowna',state:'BC',country:'CA',postal_code:'V1Y 1A1'},customer:{name:'Fictional Guest',email:'browser-guest@example.invalid',phone:'+12505550123',consent:true},locale:'en',settings_revision:1}});
if(r.statusCode!==201)throw Error(r.body);const mail=(await dbs.store.list('mail_outbox')).find(m=>m.subject.includes('private order link'));console.log(mail.body.match(/http:\/\/127\.0\.0\.1:3038\/pedido#access=[ps]_[A-Za-z0-9_-]{43}/)[0]);
let closing=false;const close=async()=>{if(closing)return;closing=true;await app.close();await dbs.close();process.exit(0);};process.on('SIGINT',close);process.on('SIGTERM',close);
