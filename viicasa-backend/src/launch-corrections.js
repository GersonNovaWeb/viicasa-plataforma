import {id,token,hash,passwordHash,passwordMatches,fail,bearer} from './lib.js';
import {key,now,afterMinutes,must,auditDoc} from './firestore-store.js';
import * as s from './firestore-schemas.js';
import {enqueue,createOrder} from './firestore-commerce.js';
import {brandedMail} from './platform-mail.js';

const adminSchema=body=>({body});
const role=s.choice(['host','seller']),section=s.choice(['orders','services','agenda']);
const mail=(title,paragraphs,url,label='View details')=>brandedMail({subject:'VII · '+title,title,paragraphs,...(url?{actionUrl:url,actionLabel:label}:{})});
const cleanApplication=x=>{const {password_hash,token_hash,...safe}=x;return safe;};
const partnerPublic=x=>({id:x.id,name:x.name,email:x.email,role:x.role,active:x.active});
export async function registerLaunchCorrections(app,store,config,guard){
  app.post('/v1/orders/direct',{preHandler:guard.guest,schema:{headers:s.keyHeader,body:s.object({...s.orderBody.properties,items:{...s.array(s.object({variant_id:s.uuid,quantity:s.int(1,99)}),20),minItems:1}},[...s.orderBody.required,'items'])}},async(r,reply)=>{
    const row=await createOrder(store,config,r.guest.id,r.headers['idempotency-key'],r.body,{directItems:r.body.items});reply.code(201);return row;
  });
  const page=async collection=>({items:(await store.list(collection,{limit:100})).map(cleanApplication).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)))});
  app.post('/v1/waitlist',{schema:{body:s.object({name:s.str(120,2),email:s.email,segment:s.choice(['shop','viilife','viiconcierge']),item:s.str(100,0),consent:{const:true}},['name','email','segment','consent'])},config:{rateLimit:{max:5,timeWindow:'15 minutes'}}},async r=>{
    const b=r.body,email=b.email.trim().toLowerCase(),entry=key('waitlist',email+':'+b.segment+':'+(b.item||''));
    await store.transaction(async tx=>{const old=await tx.get('launch_waitlist',entry);if(old)return;
      tx.create('launch_waitlist',entry,{id:entry,name:b.name.trim(),email,segment:b.segment,item:b.item||null,consent:true,created_at:now(),status:'waiting'});
      const m=mail('You are on the list',[`Hello ${b.name.trim()},`,'Thank you for your interest. We will let you know when this experience is available. No booking or purchase has been made.']);
      await enqueue(tx,'launch-waitlist:'+entry,email,m.subject,m.body,m.html);
    });return{ok:true};
  });
  app.get('/v1/admin/waitlist',{preHandler:guard.admin(['admin'])},()=>page('launch_waitlist'));
  app.post('/v1/partner-applications',{schema:adminSchema(s.object({name:s.str(120,2),email:s.email,phone:s.str(40,0),company:s.str(160,0),message:s.str(3000,0),role,consent:{const:true}},['name','email','role','consent'])),config:{rateLimit:{max:5,timeWindow:'15 minutes'}}},async r=>{
    const b=r.body,email=b.email.trim().toLowerCase(),applicationKey=key('partner-application',email+':'+b.role);
    await store.transaction(async tx=>{if(await tx.get('partner_applications',applicationKey))return;
      tx.create('partner_applications',applicationKey,{...b,email,id:applicationKey,status:'pending',created_at:now()});
      const receipt=mail('Partner application received',[`Hello ${b.name},`,'Thank you for applying. Our team will review your application and contact you. Applying does not create an account or grant access.']);
      await enqueue(tx,'partner-application:'+applicationKey,email,receipt.subject,receipt.body,receipt.html);
      const notice=mail('New partner application',[`${b.name} has applied as ${b.role}.`,'Review this application in your administrator panel.'],config.siteUrl+'/admin?tab=partners');
      await enqueue(tx,'partner-application-admin:'+applicationKey,config.adminEmail,notice.subject,notice.body,notice.html);
    });return{ok:true};
  });
  app.get('/v1/admin/partner-applications',{preHandler:guard.admin(['admin'])},()=>page('partner_applications'));
  app.post('/v1/admin/partner-applications/:id/approve',{preHandler:guard.admin(['admin']),schema:{body:s.object({})}},async r=>{
    const secret=token(),digest=hash(secret);
    const result=await store.transaction(async tx=>{
      const application=must(await tx.get('partner_applications',r.params.id));if(application.status!=='pending')fail(409,'La solicitud ya fue revisada');
      const accountKey=key('partner-email',application.email),existing=await tx.get('partner_accounts',accountKey);if(existing)fail(409,'Ya existe una cuenta para ese correo');
      const account={id:accountKey,email:application.email,name:application.name,role:application.role,active:false,auth_version:1,created_at:now()};
      tx.create('partner_accounts',accountKey,account);tx.create('partner_invitations',digest,{account_id:accountKey,expires_at:afterMinutes(48*60),used:false});
      tx.put('partner_applications',application.id,{...application,status:'approved',account_id:accountKey,reviewed_by:r.user.id,reviewed_at:now()});
      const m=mail('Your partner access is ready',[`Hello ${application.name},`,'Your application has been approved. Set your private password using the secure invitation below. The link expires in 48 hours. We never email passwords.'],config.siteUrl+'/socios/activar?token='+secret,'Activate my access');
      await enqueue(tx,'partner-invitation:'+application.id,application.email,m.subject,m.body,m.html);auditDoc(tx,r.user.id,'partner.approved',accountKey,{role:account.role});return{ok:true,role:account.role};
    });return result;
  });
  app.post('/v1/admin/partner-applications/:id/reject',{preHandler:guard.admin(['admin']),schema:{body:s.object({})}},async r=>store.transaction(async tx=>{const a=must(await tx.get('partner_applications',r.params.id));if(a.status!=='pending')fail(409,'La solicitud ya fue revisada');tx.put('partner_applications',a.id,{...a,status:'declined',reviewed_by:r.user.id,reviewed_at:now()});auditDoc(tx,r.user.id,'partner.declined',a.id);return{ok:true};}));
  app.post('/v1/partners/activate',{schema:{body:s.object({token:s.str(100,32),password:s.str(128,12)})},config:{rateLimit:{max:8,timeWindow:'15 minutes'}}},async r=>{
    const encoded=await passwordHash(r.body.password);return store.transaction(async tx=>{const invitation=must(await tx.get('partner_invitations',hash(r.body.token)),'Invitación inválida');if(invitation.used||invitation.expires_at<=now())fail(409,'Invitación vencida o utilizada');
      const account=must(await tx.get('partner_accounts',invitation.account_id));if(account.active)fail(409,'Esta cuenta ya está activada');
      tx.put('partner_accounts',account.id,{...account,password_hash:encoded,active:true});tx.put('partner_invitations',hash(r.body.token),{...invitation,used:true});return{ok:true};});
  });
  const dummy=await passwordHash(token());
  app.post('/v1/partners/login',{schema:{body:s.object({email:s.email,password:s.str(128,1),role})},config:{rateLimit:{max:5,timeWindow:'5 minutes'}}},async r=>{
    const account=await store.get('partner_accounts',key('partner-email',r.body.email.trim().toLowerCase()));const matches=await passwordMatches(r.body.password,account?.password_hash||dummy);
    if(!matches||!account?.active||account.role!==r.body.role)fail(401,'Correo o contraseña incorrectos');const secret=token();
    await store.transaction(async tx=>{const current=must(await tx.get('partner_accounts',account.id));if(!current.active||current.password_hash!==account.password_hash)fail(401,'Vuelve a iniciar sesión');tx.create('partner_sessions',hash(secret),{account_id:account.id,auth_version:current.auth_version,expires_at:afterMinutes(480)});});
    return{token:secret,profile:partnerPublic(account)};
  });
  const partnerGuard=async r=>{const session=await store.get('partner_sessions',bearer(r));const account=session&&await store.get('partner_accounts',session.account_id);if(!account?.active||session.expires_at<=now()||session.auth_version!==account.auth_version)fail(401,'Inicia sesión como socio');r.partner=account;};
  app.get('/v1/partners/dashboard',{preHandler:partnerGuard},async r=>{
    const links=await store.list('partner_resources',{where:[['account_id','==',r.partner.id]],limit:100}),items=[];
    for(const link of links){const row=await store.get(link.collection,link.resource_id);if(row&&!row.archived)items.push({id:row.id,name:row.name,slug:row.slug,type:link.collection,published:row.published,images:row.images||[]});}
    return{profile:partnerPublic(r.partner),items,commercialReady:false};
  });
  app.post('/v1/partners/logout',{preHandler:partnerGuard},async r=>{await store.transaction(tx=>{tx.remove('partner_sessions',bearer(r));});return{ok:true};});
  app.post('/v1/admin/partners/:id/resources',{preHandler:guard.admin(['admin']),schema:{body:s.object({collection:s.choice(['products','properties']),resource_id:s.uuid})}},async r=>store.transaction(async tx=>{
    const account=must(await tx.get('partner_accounts',r.params.id));if(account.role!==(r.body.collection==='products'?'seller':'host'))fail(400,'El recurso no corresponde al rol');must(await tx.get(r.body.collection,r.body.resource_id));
    const existing=await tx.get('partner_resources',key('partner-resource',r.body.collection+':'+r.body.resource_id));if(existing&&existing.account_id!==account.id)fail(409,'El recurso ya está asignado a otro socio');
    tx.put('partner_resources',key('partner-resource',r.body.collection+':'+r.body.resource_id),{account_id:account.id,...r.body,assigned_at:now()});auditDoc(tx,r.user.id,'partner.resource.assigned',account.id,r.body);return{ok:true};
  }));
  // The production customer remains the verified Firebase/Firestore account.
  app.get('/v1/service-catalogue',async()=>{
    const settings=await store.get('cleaning_settings','main');
    const available=settings?.enabled&&settings.pricing_confirmed&&settings.currency==='CAD';
    return{ready:Boolean(available),families:[{id:'home',name:{es:'Cuidado del hogar',en:'Home care'}}],items:available?[{id:'home-cleaning',family:'home',channels:['viilife'],name:{es:'Limpieza del hogar',en:'Home cleaning'},description:{es:'Elige tus visitas y horario preferido.',en:'Choose your visits and preferred schedule.'},images:['/assets/vii-hero-life.png'],href:'/viilife/limpieza',pricing:{kind:'fixed',basis:'hour',amount_minor:settings.hourly_minor}}]:[]};
  });
  app.get('/v1/experience/reviews',async()=>({count:0,average:null,items:[]}));
  const registered=async r=>{const guest=must(await store.get('guests',r.guest.id));if(!(guest.firebase_uid||guest.google_uid))fail(401,'Inicia sesión para guardar favoritos');};
  app.get('/v1/client/likes',{preHandler:[guard.guest,registered]},async r=>({items:await store.list('customer_likes',{where:[['guest_id','==',r.guest.id]],limit:100})}));
  app.put('/v1/client/likes',{preHandler:[guard.guest,registered],schema:{body:s.object({item_key:{type:'string',maxLength:150,pattern:'^(product|property|service):[a-zA-Z0-9-]+$'},liked:s.bool})}},async r=>{
    const doc=key('like',r.guest.id+':'+r.body.item_key);await store.transaction(async tx=>{if(r.body.liked)tx.put('customer_likes',doc,{guest_id:r.guest.id,item_key:r.body.item_key,created_at:now()});else tx.remove('customer_likes',doc);});return{ok:true};
  });
  const notifications=async guest=>{
    const rows=await store.list('checkouts',{where:[['guest_id','==',guest]],limit:100}),seen=await store.get('notification_seen',guest)||{};
    const groups={orders:rows,services:rows.filter(x=>x.kind==='cleaning'),agenda:rows.filter(x=>x.kind==='booking')};
    return Object.fromEntries(Object.entries(groups).map(([name,items])=>[name,{count:items.filter(x=>(x.updated_at||x.created_at)>(seen[name]||'')).length,latest:items.map(x=>x.updated_at||x.created_at).sort().at(-1)||''}]));
  };
  app.get('/v1/client/notifications',{preHandler:guard.guest},async r=>notifications(r.guest.id));
  app.put('/v1/client/notifications/seen',{preHandler:guard.guest,schema:{body:s.object({section})}},async r=>{const latest=(await notifications(r.guest.id))[r.body.section].latest;await store.transaction(async tx=>{const old=await tx.get('notification_seen',r.guest.id)||{};tx.put('notification_seen',r.guest.id,{...old,[r.body.section]:latest});});return{ok:true};});
}
