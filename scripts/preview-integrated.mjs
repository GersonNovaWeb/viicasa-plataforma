// Loopback-only visual QA. No .env, Firebase, SMTP, Stripe or PostgreSQL connection.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {memoryStore} from '../test/helpers/memory-store.mjs';
import {buildFirestoreApp} from '../viicasa-backend/src/firestore-app.js';
import {configFromEnv} from '../viicasa-backend/src/config.js';
import {installDemoProperties} from '../viicasa-backend/src/demo-properties.js';
import {installDemoProducts} from '../viicasa-backend/src/demo-products.js';
import {defaultCleaningSettings} from '../viicasa-backend/src/cleaning.js';
const port=Number(process.env.QA_PORT||3052),origin='http://127.0.0.1:'+port,store=memoryStore();
const config=configFromEnv({PUBLIC_SITE_URL:origin,ALLOWED_ORIGINS:origin,PAYMENT_PROVIDER:'disabled',MAIL_MODE:'outbox',ADMIN_EMAIL:'qa@example.invalid'});
const app=await buildFirestoreApp(config,{store,logger:false,testing:true});await installDemoProperties(store,'qa');await installDemoProducts(store,'qa');await store.set('cleaning_settings','main',{...defaultCleaningSettings(),enabled:true,pricing_confirmed:true});
await store.set('shop_settings','CAD',{currency:'CAD',pickup_enabled:true,shipping_enabled:true,shipping_minor:1500,terms:'Illustrative QA only'});
const guest=(await app.inject({method:'POST',url:'/v1/guest-sessions'})).json();
const root=fileURLToPath(new URL('../viicasa-frontend-prototype/',import.meta.url)),types={'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.mp4':'video/mp4'};
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,origin);res.setHeader('Cache-Control','no-store');
  if(url.pathname==='/api/config'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({phase:2,demo:true,commercialReady:false,payment:'disabled',paymentMode:'test',viilifeMode:'live',commerceEnabled:true,googleEnabled:false,authProviders:{google:false,apple:false,email:false}}));}
  if(url.pathname==='/api/account'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({profile:null,items:await store.list('checkouts',{where:[['guest_id','==',guest.id]]})}));}
  if(url.pathname.startsWith('/api/')){const parts=[];for await(const part of req)parts.push(part);const body=Buffer.concat(parts),response=await app.inject({method:req.method,url:url.pathname.replace('/api/','/v1/')+url.search,headers:{...req.headers,authorization:'Bearer '+guest.token},payload:body.length?body:undefined});res.writeHead(response.statusCode,{'Content-Type':response.headers['content-type']||'application/json'});return res.end(response.rawPayload);}
  let file=url.pathname.slice(1);if(!file||!extname(file))file='index.html';const target=resolve(root,file);if(!target.startsWith(root.endsWith(sep)?root:root+sep)||file.startsWith('.')||(!types[extname(file)])||(!file.startsWith('assets/')&&file.includes('/')))throw Error('Not found');
  const body=await readFile(target);res.setHeader('Content-Type',types[extname(file)]);res.end(body);
}catch{res.writeHead(404).end('Not found');}});
server.listen(port,'127.0.0.1',()=>console.log('ISOLATED QA: '+origin));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(async()=>{await app.close();process.exit();}));
