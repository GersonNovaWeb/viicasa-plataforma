// Read-only deployment checks. Never displays credentials or connects to services.
import {existsSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const env=process.env,failures=[],warnings=[];
const require=createRequire(new URL('../viicasa-backend/package.json',import.meta.url));
const need=(name)=>{if(!env[name]?.trim())failures.push(`Falta ${name}`);};
if(env.PLATFORM_MODE!=='live')failures.push('PLATFORM_MODE debe ser live para publicar');
if(env.NODE_ENV!=='production')failures.push('NODE_ENV debe ser production');
try{const u=new URL(env.SITE_URL);if(u.protocol!=='https:'||u.origin!==env.SITE_URL)throw Error();}catch{failures.push('SITE_URL debe ser el origen HTTPS exacto, sin barra final');}
for(const name of ['FIREBASE_PROJECT_ID','FIREBASE_WEB_API_KEY','FIREBASE_AUTH_DOMAIN','FIREBASE_WEB_APP_ID','ADMIN_EMAILS','MEDIA_DIR'])need(name);
if(env.FIREBASE_PROJECT_ID?.startsWith('demo-')||env.FIRESTORE_EMULATOR_HOST)failures.push('No usar proyecto demo ni emulador en producción');
try{
  const raw=env.FIREBASE_SERVICE_ACCOUNT_JSON||(env.GOOGLE_APPLICATION_CREDENTIALS&&readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS,'utf8'));
  if(!raw)throw Error();
  const account=JSON.parse(raw);
  if(account.project_id!==env.FIREBASE_PROJECT_ID||!account.private_key||!account.client_email)throw Error();
}catch{failures.push('Falta una cuenta de servicio válida del proyecto seleccionado (no se muestran secretos)');}
const payments=process.argv.includes('--payments');
if(payments){
  if(env.PAYMENT_PROVIDER!=='stripe')failures.push('Configurar PAYMENT_PROVIDER=stripe para la validación de pagos');
  for(const name of ['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'])need(name);
  if(env.STRIPE_SECRET_KEY&&!env.STRIPE_SECRET_KEY.startsWith('sk_test_'))failures.push('Este preflight de validación sólo acepta claves Stripe de prueba');
  if(env.STRIPE_WEBHOOK_SECRET&&!env.STRIPE_WEBHOOK_SECRET.startsWith('whsec_'))failures.push('Formato de STRIPE_WEBHOOK_SECRET inválido');
}else if(env.PAYMENT_PROVIDER!=='disabled')failures.push('Durante la validación de Google/Firestore usar PAYMENT_PROVIDER=disabled');
if(env.PRIVACY_APPROVED!=='true')warnings.push('Privacidad y condiciones aún requieren aprobación');
if(env.COMMERCE_ENABLED!=='true')warnings.push('Operaciones públicas deshabilitadas');
if(!env.TRUSTED_PROXY_IPS)warnings.push('Verificar proxy de Hostinger: sin confianza explícita no se usa X-Forwarded-For');
if(env.MAIL_MODE!=='smtp')warnings.push('Los correos no se envían; MAIL_MODE no es smtp');
else for(const name of ['SMTP_HOST','MAIL_FROM'])need(name);
for(const dependency of ['fastify','firebase-admin','stripe','ip-location-api']){
  try{require.resolve(dependency);}catch{failures.push(`Instalar dependencia del backend: ${dependency}`);}
}
if(!existsSync(new URL('../viicasa-backend/data/geoip',import.meta.url)))warnings.push('Preparar la base de países con node scripts/geoip.mjs en el backend');
warnings.push('Verificar persistencia de MEDIA_DIR, índices, copias y Google en el hosting: no se prueban aquí');
console.log('VIICASA — preflight de staging, sin llamadas externas');
for(const item of failures)console.log('PENDIENTE: '+item);
for(const item of warnings)console.log('REVISAR: '+item);
console.log(failures.length?`${failures.length} requisitos de staging pendientes.`:'Configuración local de staging consistente. Faltan pruebas externas.');
process.exitCode=failures.length?1:0;
