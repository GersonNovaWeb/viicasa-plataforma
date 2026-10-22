import {randomUUID} from 'node:crypto';
import {reconcilePayment} from '../viicasa-backend/src/firestore-payments.js';
import {token,hash,fail} from '../viicasa-backend/src/lib.js';
import * as s from '../viicasa-backend/src/schemas.js';
import {cookieValue} from './api.mjs';
import {authenticatedCustomer,customerProfile} from './customer-auth.mjs';
import {safeCheckout} from '../viicasa-backend/src/firestore-commerce.js';
import {startPayment} from '../viicasa-backend/src/firestore-payments.js';
import {queueCommercialMail,serviceMail} from './mail.mjs';

const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const expiry=days=>new Date(Date.now()+days*86400000).toISOString();
export const guestCustomerSchema=s.object({name:s.str(120,2),email:s.email});
const validCustomer=c=>c&&typeof c.name==='string'&&c.name.trim().length>=2&&c.name.length<=120&&typeof c.email==='string'&&c.email.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email);
export const buyerRef=u=>(u.guest?'guest:':'customer:')+u.id;
export const buyerId=u=>u.guest?null:u.id;
export function guestCheckout({app,db,store,vault,origin,config,customerGuard,gateway}){
  const secure=origin.startsWith('https:'),cookie=(name,value,seconds)=>`${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure?'; Secure':''}`;
  const setCookie=(reply,value)=>reply.header('Set-Cookie',[].concat(reply.getHeader('Set-Cookie')||[],value));
  const originGuard=async r=>{if(r.headers.origin!==origin)fail(403,'Request origin is not allowed.');};
  const buyerGuard=async(r,reply)=>{
    const user=await authenticatedCustomer(db,cookieValue(r,'vc2_client'));
    if(user){r.customer=user;return;}
    const contact=r.body?.customer;if(!validCustomer(contact))fail(401,'Continue as a guest with your name and email, or sign in.');
    let secret=cookieValue(r,'vc2_buyer'),guest=secret&&await one(db,'SELECT id FROM guest_buyers WHERE token_hash=$1 AND expires_at>now()',[hash(secret)]);
    if(!guest){secret=token();guest={id:randomUUID()};await db.query('INSERT INTO guest_buyers(id,token_hash,expires_at) VALUES($1,$2,$3)',[guest.id,hash(secret),expiry(30)]);setCookie(reply,cookie('vc2_buyer',secret,2592000));}
    // A guest identity is NOT a customer account and is never email-verified here.
    r.customer={id:guest.id,guest:true,name:contact.name.trim(),email:contact.email.trim().toLowerCase()};
  };
  const sqlLink=async(tx,kind,id,customer)=>{
    if(!customer.guest)return new URL('/cliente',origin).href;
    let saved=await one(tx,'SELECT * FROM guest_order_links WHERE kind=$1 AND resource_id=$2',[kind,id]);
    if(!saved||new Date(saved.expires_at)<=new Date()){
      const secret='s_'+token();saved={token_hash:hash(secret),secret_cipher:vault.seal(secret),expires_at:expiry(30)};
      await tx.query('INSERT INTO guest_order_links(kind,resource_id,owner_ref,email,token_hash,secret_cipher,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(kind,resource_id) DO UPDATE SET token_hash=excluded.token_hash,secret_cipher=excluded.secret_cipher,expires_at=excluded.expires_at',[kind,id,buyerRef(customer),customer.email,saved.token_hash,saved.secret_cipher,saved.expires_at]);
    }
    return new URL('/pedido#access='+vault.open(saved.secret_cipher),origin).href;
  };
  const platformLink=async(tx,checkout)=>{
    const guest=await tx.get('guests',checkout.guest_id);
    if(guest?.customer_account)return new URL('/cuenta#viilife-orders',origin).href;
    let link=await tx.get('guest_order_links',checkout.id);
    if(!link||link.expires_at<=new Date().toISOString()){
      const secret='p_'+token();link={id:checkout.id,token_hash:hash(secret),secret_cipher:vault.seal(secret),expires_at:expiry(30)};
      tx.put('guest_order_links',checkout.id,link);tx.put('guest_order_link_index',link.token_hash,{checkout_id:checkout.id});
    }
    return new URL('/pedido#access='+vault.open(link.secret_cipher),origin).href;
  };
  // Called within the platform transaction before each customer notice, including
  // approval and Stripe confirmation. It never grants access based on an email.
  config.guestOrderLink=platformLink;
  config.checkoutReturnPath=async checkout=>{
    const guest=await store.get('guests',checkout.guest_id);
    return guest?.customer_account?null:'/pedido?reference='+checkout.id;
  };
  const checkedLink=async secret=>{
    if(typeof secret!=='string'||!/^[ps]_[A-Za-z0-9_-]{43}$/.test(secret))fail(404,'Order access is invalid or expired.');
    if(secret.startsWith('s_')){
      const link=await one(db,'SELECT * FROM guest_order_links WHERE token_hash=$1 AND expires_at>now()',[hash(secret)]);if(!link)fail(404,'Order access is invalid or expired.');return{kind:link.kind,id:link.resource_id,email:link.email};
    }
    const index=await store.get('guest_order_link_index',hash(secret)),link=index&&await store.get('guest_order_links',index.checkout_id);
    if(!link||link.token_hash!==hash(secret)||link.expires_at<=new Date().toISOString())fail(404,'Order access is invalid or expired.');
    const c=await store.get('checkouts',link.id);if(!c)fail(404,'Order access is invalid or expired.');return{kind:'platform',id:link.id,email:c.customer_email};
  };
  const grant=async r=>{
    const secret=cookieValue(r,'vc2_order'),g=secret&&await one(db,'SELECT * FROM guest_order_grants WHERE token_hash=$1 AND expires_at>now()',[hash(secret)]);if(!g)fail(401,'Open the private order link from your email.');return{kind:g.kind,id:g.resource_id};
  };
  const sessionForCheckout=async(reply,id,seconds=900)=>{
    const secret=token();await db.query('INSERT INTO guest_order_grants(token_hash,kind,resource_id,expires_at) VALUES($1,$2,$3,$4)',[hash(secret),'platform',id,new Date(Date.now()+seconds*1000).toISOString()]);setCookie(reply,cookie('vc2_order',secret,seconds));
  };
  const resource=async g=>{
    if(g.kind==='platform'){const c=await store.get('checkouts',g.id);if(!c)fail(404,'Order not found.');return{kind:g.kind,order:safeCheckout(c),email:c.customer_email};}
    if(['contract','invoice'].includes(g.kind)){
      const table=g.kind==='contract'?'service_contracts':'service_invoices',c=await one(db,`SELECT * FROM ${table} WHERE id=$1`,[g.id]);if(!c||c.status==='draft')fail(404,'Document not found.');
      return{kind:g.kind,order:g.kind==='contract'?{id:c.id,status:c.status,snapshot:c.snapshot,snapshot_hash:c.snapshot_hash,acceptance:c.acceptance}:{id:c.id,status:c.status,total_minor:Number(c.total_minor),number:c.number,currency:'CAD',due_date:c.due_date},email:c.customer_email};
    }
    if(g.kind==='channel'){const c=await one(db,'SELECT * FROM channel_checkouts WHERE id=$1',[g.id]);if(!c)fail(404,'Order not found.');return{kind:g.kind,order:{id:c.id,status:c.status,total_minor:Number(c.total_minor),currency:c.currency,snapshot:c.snapshot,expires_at:c.expires_at},email:c.snapshot.customer.email};}
    if(g.kind==='enquiry'){const row=await one(db,'SELECT q.id,q.details,q.created_at,l.stage,l.email FROM client_service_requests q JOIN crm_leads l ON l.id=q.lead_id WHERE q.id=$1',[g.id]);if(!row)fail(404,'Request not found.');return{kind:g.kind,order:row,email:row.email};}
    const c=await one(db,'SELECT status,sealed_result FROM shopify_carts WHERE id=$1',[g.id]),link=await one(db,'SELECT email FROM guest_order_links WHERE kind=$1 AND resource_id=$2',['shopify',g.id]);if(!c||!link)fail(404,'Checkout not found.');return{kind:g.kind,order:{id:g.id,status:c.status,...(c.status==='ready'?JSON.parse(vault.open(c.sealed_result)):{} )},email:link.email};
  };
  // A document capability is valid for exactly one agreement/invoice, never an
  // email-wide customer session. Lists and all other account actions stay guarded.
  const documentGuard=kind=>async(r,reply)=>{
    if(cookieValue(r,'vc2_order')){
      let g;try{g=await grant(r);}catch{/* A verified account can still access its own document. */}
      if(g?.kind===kind&&g.id===r.params.id){const row=await resource(g);r.customer={id:null,actor_id:g.id,guest:true,email:row.email};
        if(r.method==='POST'&&r.url.endsWith('/payment')){const secret=cookieValue(r,'vc2_order');await db.query("UPDATE guest_order_grants SET expires_at=now()+interval '1 hour' WHERE token_hash=$1",[hash(secret)]);setCookie(reply,cookie('vc2_order',secret,3600));}return;}
    }
    await customerGuard(r);
  };
  const documentLink=(tx,kind,c)=>sqlLink(tx,kind,c.id,{id:c.id,guest:true,email:c.customer_email});
  config.guestDocumentLink=documentLink;
  app.addHook('onSend',async(r,reply,payload)=>{if(r.url.startsWith('/api/guest/')||r.url.split('?')[0]==='/pedido'||r.url.startsWith('/api/client/contracts/')||r.url.startsWith('/api/client/invoices/'))reply.header('Cache-Control','private, no-store').header('Referrer-Policy','no-referrer');return payload;});
  app.get('/api/guest/buyer',async r=>{const user=await authenticatedCustomer(db,cookieValue(r,'vc2_client'));return{profile:user?customerProfile(user):null,guest_checkout:true};});
  app.post('/api/guest/access',{preHandler:originGuard,schema:{body:s.object({access:s.str(45,45)})},config:{rateLimit:{max:15,timeWindow:'5 minutes'}}},async(r,reply)=>{
    const g=await checkedLink(r.body.access),secret=token();await db.query("INSERT INTO guest_order_grants(token_hash,kind,resource_id,expires_at) VALUES($1,$2,$3,now()+interval '15 minutes')",[hash(secret),g.kind,g.id]);reply.header('Set-Cookie',cookie('vc2_order',secret,900));return{ok:true,reference:g.id};
  });
  app.get('/api/guest/order',{schema:{querystring:s.object({reference:s.uuid},[])}},async r=>{const g=await grant(r);if(r.query.reference&&r.query.reference!==g.id)fail(409,'Another order was opened in this browser. Reopen this order from its email link.');const row=await resource(g),user=await authenticatedCustomer(db,cookieValue(r,'vc2_client'));return{...row,can_claim:Boolean(!['contract','invoice'].includes(g.kind)&&user&&user.email===row.email),account_optional:true};});
  app.post('/api/guest/order/reconcile',{preHandler:originGuard,schema:{body:s.object({reference:s.uuid})},config:{rateLimit:{max:10,timeWindow:'5 minutes'}}},async r=>{
    const g=await grant(r);if(g.id!==r.body.reference||g.kind!=='platform')fail(409,'Reopen this order from its private link.');
    const c=await store.get('checkouts',g.id);if(!c)fail(404,'Order not found.');
    await reconcilePayment(store,config,gateway,c.guest_id,c.id);return{ok:true};
  });
  app.post('/api/guest/order/payment',{preHandler:originGuard,schema:{body:s.object({reference:s.uuid})},config:{rateLimit:{max:10,timeWindow:'5 minutes'}}},async(r,reply)=>{
    const g=await grant(r);if(g.id!==r.body.reference)fail(409,'Order access changed. Reopen the private link before paying.');if(g.kind!=='platform')fail(409,'This entry is a service enquiry or a simulated/external checkout, not a Stripe payment.');
    const c=await store.get('checkouts',g.id);if(!c)fail(404,'Order not found.');
    const result=await startPayment(store,config,gateway,c.guest_id,c.id);await sessionForCheckout(reply,c.id,3600);return result;
  });
  app.post('/api/guest/order/claim',{preHandler:[originGuard,customerGuard],schema:{body:s.object({consent:{const:true},reference:s.uuid})}},async r=>{
    const g=await grant(r);if(g.id!==r.body.reference)fail(409,'Order access changed. Reopen the private link before linking this order.');const row=await resource(g);if(row.email!==r.customer.email)fail(403,'Verify the same email used for this order before linking it.');
    if(['contract','invoice'].includes(g.kind))return{ok:true,account_url:'/cliente'}; // Verified email already owns these documents; no merge required.
    if(g.kind==='platform')await store.transaction(async tx=>{const c=await tx.get('checkouts',g.id);if(!c||c.customer_email!==r.customer.email)fail(409,'Order changed.');tx.put('checkouts',g.id,{...c,guest_id:r.customer.id});tx.remove('guest_order_links',g.id);});
    else await db.transaction(async tx=>{const table={channel:'channel_checkouts',enquiry:'client_service_requests',shopify:'shopify_carts'}[g.kind];await tx.query(`UPDATE ${table} SET customer_id=$2 WHERE id=$1`,[g.id,r.customer.id]);await tx.query('DELETE FROM guest_order_links WHERE kind=$1 AND resource_id=$2',[g.kind,g.id]);});
    await db.query('DELETE FROM guest_order_grants WHERE kind=$1 AND resource_id=$2',[g.kind,g.id]);return{ok:true,account_url:g.kind==='platform'?'/cuenta':'/cliente'};
  });
  const confirmation=async(tx,kind,id,customer)=>{
    const actionUrl=await sqlLink(tx,kind,id,customer);
    if(customer.guest)await queueCommercialMail(tx,'guest-access:'+kind+':'+id,customer.email,serviceMail({subject:'Your private VII order link',title:'Your order, without an account',paragraphs:[`Hello ${customer.name},`,'Use this private link to review this order or request. Creating an account is optional. Do not forward this link.'],actionUrl,actionLabel:'View my order'}));
    return actionUrl;
  };
  return{buyerGuard,sqlLink,confirmation,platformLink,sessionForCheckout,documentGuard,documentLink};
}
