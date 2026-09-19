import {prepareGeolocation,locationPreference,clientIp} from '../viicasa-backend/src/geolocation.js';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {buildApp} from '../viicasa-backend/src/app.js';
import {configFromEnv} from '../viicasa-backend/src/config.js';
import {hash,token,fail} from '../viicasa-backend/src/lib.js';
import {key,now,afterMinutes} from '../viicasa-backend/src/firestore-store.js';
import {saveCatalog,saveVariant} from '../viicasa-backend/src/firestore-catalog.js';
import {safeCheckout} from '../viicasa-backend/src/firestore-commerce.js';
import {createUser} from '../viicasa-backend/src/firestore-auth.js';
import {seedDemoPricing} from './demo-pricing.mjs';
import {saveGoogleCustomer,publicCustomer} from '../viicasa-backend/src/customer-registration.js';
const require=createRequire(new URL('../viicasa-backend/package.json',import.meta.url));
const {initializeApp,applicationDefault,cert}=require('firebase-admin/app');
const {getAuth}=require('firebase-admin/auth');
export const demo=process.env.PLATFORM_MODE!=='live';
export const origin=process.env.SITE_URL||'http://127.0.0.1:3015';
if(new URL(origin).origin!==origin)throw Error('SITE_URL must be an exact origin without a path or trailing slash.');
if(process.env.NODE_ENV==='production'&&demo)throw Error('Production requires PLATFORM_MODE=live; demo access is local only.');
if(!demo&&!origin.startsWith('https://'))throw Error('Live platform requires HTTPS.');
if(demo&&process.env.PAYMENT_PROVIDER==='stripe'&&!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_'))throw Error('Local demo only accepts Stripe test keys.');
const config=configFromEnv(demo?{DATABASE_DRIVER:'firestore',FIREBASE_MODE:'emulator',FIREBASE_PROJECT_ID:'demo-viicasa-platform',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8088',PUBLIC_SITE_URL:origin,ALLOWED_ORIGINS:origin,PAYMENT_PROVIDER:process.env.PAYMENT_PROVIDER==='stripe'?'stripe':'demo',STRIPE_SECRET_KEY:process.env.STRIPE_SECRET_KEY,STRIPE_WEBHOOK_SECRET:process.env.STRIPE_WEBHOOK_SECRET,MAIL_MODE:'outbox',ADMIN_EMAIL:'demo@example.invalid'}:{...process.env,DATABASE_DRIVER:'firestore',FIREBASE_MODE:'live',NODE_ENV:'production',PUBLIC_SITE_URL:origin,ALLOWED_ORIGINS:origin,PAYMENT_PROVIDER:process.env.PAYMENT_PROVIDER||'disabled'});
let appPromise,authService;
const api=()=>appPromise??=(buildApp(config,{logger:false}).catch(e=>{appPromise=null;throw e;}));
export async function platformReady(){
  prepareGeolocation().catch(()=>console.warn('Country lookup unavailable; default currency is USD.'));
  if(demo){
    const content=await readFile(new URL('../viicasa-backend/firestore.rules',import.meta.url),'utf8');
    const r=await fetch('http://127.0.0.1:8088/emulator/v1/projects/demo-viicasa-platform:securityRules',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({rules:{files:[{name:'security.rules',content}]}})});
    if(!r.ok)throw Error('Local security rules could not be applied');
  }
  const app=await api();if(demo){await seed(app.store);await seedDemoPricing(app.store);}return app;
}
let seeded=false;
async function seed(store){
  if(seeded)return;
  const houses=[
    ['casa-brisa','Casa Brisa','Costa · Coastal',8,4,4,680000,['Terraza / Terrace','Vista al mar / Sea view','Wi-Fi','Cocina / Kitchen'],'Espacios abiertos hacia el paisaje, materiales naturales y una terraza para compartir.','Open spaces facing the landscape, natural materials and a terrace for gathering.'],
    ['villa-oliva','Villa Oliva','Bosque · Forest',6,3,3,490000,['Jardín / Garden','Chimenea / Fireplace','Wi-Fi','Cocina / Kitchen'],'Un refugio entre naturaleza y arquitectura, con espacios para descansar sin prisa.','A retreat between nature and architecture, with space to slow down.'],
    ['casa-lumbre','Casa Lumbre','Ciudad · City',4,2,2,350000,['Terraza / Terrace','Área de trabajo / Workspace','Wi-Fi','Cocina / Kitchen'],'Luz, líneas limpias y una selección de texturas para una estancia serena.','Light, clean lines and selected textures for a serene stay.'],
    ['residencia-arena','Residencia Arena','Costa · Coastal',10,5,4,920000,['Alberca / Pool','Jardín / Garden','Wi-Fi','Estacionamiento / Parking'],'Una residencia para reunirse, con interiores amplios y vida al aire libre.','A residence for coming together, with generous interiors and outdoor living.']
  ];
  for(const [slug,name,location,capacity,bedrooms,bathrooms,nightly_minor,amenities,es,en] of houses){if(await store.get('unique_keys',key('properties-slug',slug)))continue;await saveCatalog(store,null,'properties',{slug,name,location,capacity,bedrooms,bathrooms,nightly_minor,amenities,description:`${es}\n[EN]\n${en}`,timezone:'America/Mexico_City',cleaning_minor:85000,deposit_percent:30,min_nights:2,currency:'MXN',images:[],policies:'Demostración: no constituye una oferta real. No se permiten eventos.\n[EN]\nDemo: not a real offer. Events are not allowed.',published:true});}
  for(const [slug,name,price,category]of [['jarron-terra','Jarrón Terra / Terra Vase',185000,'Objetos / Objects'],['lino-natural','Lino natural / Natural linen',240000,'Textiles'],['ritual-casa','Ritual de casa / Home ritual',95000,'Objetos / Objects']]){if(await store.get('unique_keys',key('products-slug',slug)))continue;const p=await saveCatalog(store,null,'products',{slug,name,category,description:'Pieza de demostración. Materiales y medidas pendientes de confirmación.\n[EN]\nDemonstration item. Materials and dimensions to be confirmed.',images:[],published:true});await saveVariant(store,null,p.id,{sku:slug.toUpperCase(),name:'Natural',price_minor:price,currency:'MXN',stock:12,active:true});}
  seeded=true;
}
const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(s=>s.trim().split(/=(.*)/s).slice(0,2)));
const secretCookie=(res,name,value,age=28800)=>{const previous=res.getHeader('Set-Cookie')||[];res.setHeader('Set-Cookie',[...previous,`${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${origin.startsWith('https:')?'; Secure':''}`]);};
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const requests=new Map();
function limit(req){
  const minute=Math.floor(Date.now()/60000),address=clientIp(req,(process.env.TRUSTED_PROXY_IPS||'').split(',').map(s=>s.trim()).filter(Boolean));
  const previous=requests.get(address);const count=previous?.minute===minute?previous.count+1:1;
  requests.set(address,{minute,count});if(requests.size>5000)for(const [k,v]of requests)if(v.minute!==minute)requests.delete(k);
  if(count>240)fail(429,'Demasiadas solicitudes. Espera un momento.');
}
async function payload(req){let size=0;const parts=[];for await(const p of req){size+=p.length;if(size>(req.headers['content-type']?.startsWith('multipart/')?8*1024*1024+65536:262144))fail(413,'Solicitud demasiado grande');parts.push(p);}return Buffer.concat(parts);}
async function guest(app,req,res){let secret=cookies(req).vc_guest;const index=secret&&await app.store.get('guest_tokens',hash(secret));const row=index&&await app.store.get('guests',index.guest_id);if(row&&row.expires_at>now())return{secret,row};const response=await app.inject({method:'POST',url:'/v1/guest-sessions'});if(response.statusCode!==201)fail(response.statusCode,'No se pudo iniciar la sesión');const d=response.json();secretCookie(res,'vc_guest',d.token,2592000);return{secret:d.token,row:{id:d.id,expires_at:d.expires_at}};}
function auth(){
  if(!authService){let credential;try{credential=process.env.FIREBASE_SERVICE_ACCOUNT_JSON?cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)):applicationDefault();}catch{fail(503,'Configuración de autenticación no disponible');}authService=getAuth(initializeApp({projectId:config.firebaseProjectId,credential},'viicasa-platform-auth'));}return authService;
}
// A production launch needs approved privacy/terms and a configured payment provider.
const writesOpen=()=>demo||process.env.COMMERCE_ENABLED==='true'&&process.env.PRIVACY_APPROVED==='true';
export async function handlePlatform(req,res,url){
  const path=url.pathname;
  if(!path.startsWith('/api/')&&!path.startsWith('/v1/media/')&&path!=='/v1/webhooks/stripe')return false;
  try{
    limit(req);
    const mutation=!['GET','HEAD'].includes(req.method);
    if(mutation&&path!=='/v1/webhooks/stripe'&&req.headers.origin!==origin)fail(403,'Origen no permitido');
    if(path==='/api/config'&&req.method==='GET'){json(res,200,{demo,...locationPreference(req,(process.env.TRUSTED_PROXY_IPS||'').split(',').map(s=>s.trim()).filter(Boolean)),commerceEnabled:writesOpen(),payment:config.paymentProvider,googleEnabled:!demo&&!!process.env.FIREBASE_WEB_API_KEY,firebase:!demo?{apiKey:process.env.FIREBASE_WEB_API_KEY,authDomain:process.env.FIREBASE_AUTH_DOMAIN||'viicasa.firebaseapp.com',projectId:config.firebaseProjectId,appId:process.env.FIREBASE_WEB_APP_ID}:null});return true;}
    const app=await api();const store=app.store;
    if(path==='/api/auth/google'&&req.method==='POST'){
      if(demo||!process.env.FIREBASE_WEB_API_KEY)fail(503,'Google no está habilitado en este entorno');
      const input=JSON.parse((await payload(req)).toString());if(typeof input.idToken!=='string'||input.idToken.length>16000)fail(400,'Token inválido');
      let user;try{user=await auth().verifyIdToken(input.idToken,true);}catch{fail(401,'Sesión de Google inválida');}
      if(!user.email_verified||user.firebase?.sign_in_provider!=='google.com'||Date.now()/1000-user.auth_time>300)fail(401,'Vuelve a iniciar sesión con Google');
      const secret=token();
      const location=locationPreference(req,(process.env.TRUSTED_PROXY_IPS||'').split(',').map(s=>s.trim()).filter(Boolean));
      await saveGoogleCustomer(store,user,location.country,secret);
      secretCookie(res,'vc_guest',secret,2592000);secretCookie(res,'vc_identity',await auth().createSessionCookie(input.idToken,{expiresIn:28800000}));
      json(res,200,{ok:true});return true;
    }
    if(path==='/api/auth/logout'&&req.method==='POST'){
      const c=cookies(req);await store.transaction(async tx=>{if(c.vc_guest)tx.remove('guest_tokens',hash(c.vc_guest));if(c.vc_admin)tx.remove('sessions',hash(c.vc_admin));});for(const name of ['vc_guest','vc_admin','vc_identity'])secretCookie(res,name,'',0);json(res,200,{ok:true});return true;
    }
    if(path==='/api/demo-admin'&&req.method==='POST'){
      if(!demo||!['127.0.0.1','::1'].includes(req.socket.remoteAddress))fail(404,'No disponible');
      let record=await store.get('unique_keys',key('email','demo@example.invalid'));
      if(!record){const user=await createUser(store,{email:'demo@example.invalid',name:'Administrador de demostración',password:token()});record={owner:user.id};}
      const user=await store.get('users',record.owner),secret=token();await store.set('sessions',hash(secret),{user_id:user.id,auth_version:user.auth_version,expires_at:afterMinutes(480)});secretCookie(res,'vc_admin',secret);json(res,200,{ok:true});return true;
    }
    const g=await guest(app,req,res);
    let verified;
    if(g.row.google_uid){try{verified=await auth().verifySessionCookie(cookies(req).vc_identity||'',true);if(verified.uid!==g.row.google_uid)throw Error();}catch{for(const name of ['vc_guest','vc_identity'])secretCookie(res,name,'',0);fail(401,'Vuelve a iniciar sesión con Google');}}
    if(path==='/api/account'&&req.method==='GET'){
      const records=await store.list('checkouts',{where:[['guest_id','==',g.row.id]],limit:100});
      json(res,200,{profile:g.row.google_uid?publicCustomer(g.row):null,items:records.sort((a,b)=>b.created_at.localeCompare(a.created_at)).map(safeCheckout),demo});return true;
    }
    let target=path.replace(/^\/api/,'/v1'),secret=g.secret;
    if(path.startsWith('/api/admin/')){
      if(!demo){if(!verified||!(process.env.ADMIN_EMAILS||'').split(',').map(s=>s.trim().toLowerCase()).includes(verified.email.toLowerCase()))fail(403,'Acceso administrativo denegado');
        // Roles remain server-owned. Provision only an explicitly allowed verified Google identity.
        let index=await store.get('unique_keys',key('email',verified.email.toLowerCase()));
        if(!index){const u=await createUser(store,{email:verified.email,name:verified.name||verified.email,password:token()});index={owner:u.id};}
        const u=await store.get('users',index.owner);if(!u.active)fail(403,'Acceso administrativo denegado');secret=token();await store.set('sessions',hash(secret),{user_id:u.id,auth_version:u.auth_version,expires_at:afterMinutes(1)});
      }else secret=cookies(req).vc_admin;
      if(!secret)fail(401,'Acceso administrativo requerido');
    }
    const allowed=/^\/v1\/(properties(?:\/[^/]+)?|products(?:\/[^/]+)?|shop\/settings|bookings(?:\/quote)?|cart(?:\/items\/[^/]+)?|orders|checkouts\/[^/]+(?:\/(?:payment|cancel))?|inquiries|admin\/.+|media\/[^/]+|webhooks\/stripe)$/;
    if(!allowed.test(target))fail(404,'Ruta no encontrada');
    if(mutation&&!writesOpen()&&['/v1/bookings','/v1/orders','/v1/inquiries'].includes(target))fail(503,'El registro de operaciones todavía no está habilitado');
    const body=mutation?await payload(req):undefined;
    const headers={authorization:`Bearer ${secret||''}`};for(const h of ['content-type','idempotency-key','stripe-signature'])if(req.headers[h])headers[h]=req.headers[h];
    // No browser-provided Authorization or admin role is forwarded.
    const response=await app.inject({method:req.method,url:target+url.search,headers,remoteAddress:clientIp(req,(process.env.TRUSTED_PROXY_IPS||'').split(',').map(s=>s.trim()).filter(Boolean))||'127.0.0.1',payload:body?.length?body:undefined});
    res.writeHead(response.statusCode,{'Content-Type':response.headers['content-type']||'application/json','Cache-Control':'no-store'});res.end(response.rawPayload);
  }catch(error){json(res,error.statusCode||503,{error:error.statusCode?error.message:'Servicio no disponible. Reintenta en unos momentos.'});}
  return true;
}
export async function maintenance(){const app=await api();await app.maintenance();}
