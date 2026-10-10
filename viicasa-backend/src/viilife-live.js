import {demoQuote,quoteBody,requestBody} from './viilife-demo.js';
import {getCleaningSettings,createCleaningRequest} from './cleaning.js';
import {fail} from './lib.js';

// Reuse the approved schedule/price calculation, not demo persistence or payments.
export async function liveViiLifeQuote(store,input){
  const settings=await getCleaningSettings(store);
  if(settings.currency!=='CAD')fail(409,'Configura las tarifas de ViiLife en CAD antes de continuar.');
  const {demo,...quote}=demoQuote(input,{...settings,max_hours:8,large_hours:3,large_days:3});
  return {...quote,can_pay:quote.coverage==='inside'&&settings.enabled&&settings.pricing_confirmed,terms:{es:settings.terms_es,en:settings.terms_en},pricing_confirmed:settings.pricing_confirmed};
}
export async function registerViiLifeLive(app,store,config,guard){
  const live=async()=>{if(config.viilifeMode!=='live')fail(409,'ViiLife está en modo de demostración.');};
  app.get('/v1/viilife/settings',{preHandler:live},async()=>({...await getCleaningSettings(store),max_hours:8,large_hours:3,large_days:3}));
  app.post('/v1/viilife/quote',{preHandler:live,schema:{body:quoteBody}},r=>liveViiLifeQuote(store,r.body));
  app.post('/v1/viilife/requests',{preHandler:[live,guard.guest],schema:{body:requestBody,headers:{type:'object',properties:{'idempotency-key':{type:'string',minLength:16,maxLength:200}},required:['idempotency-key']}},config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async(r,reply)=>{
    const result=await createCleaningRequest(store,config,r.guest.id,r.headers['idempotency-key'],{...r.body,focus:[],marketing:false,pricing_version:2},liveViiLifeQuote);
    reply.code(201);return result;
  });
}
export async function maintainViiLifeLive(store,config){
  // Approval messages are queued transactionally; no abandonment notifications.
  // Keep the maintenance hook compatible with existing callers.
}
