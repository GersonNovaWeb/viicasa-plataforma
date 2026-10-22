import {randomUUID} from 'node:crypto';
import {fail} from '../viicasa-backend/src/lib.js';
import * as s from '../viicasa-backend/src/schemas.js';
import {snapshotHash} from './agreement-content.mjs';
import {queueCommercialMail} from './mail.mjs';
import {brandedMail} from '../viicasa-backend/src/platform-mail.js';
import {guestCustomerSchema,buyerRef,buyerId} from './guest-checkout.mjs';
import {channelBreakdownSchema,orderBreakdown,priceChannel,channelPolicy,registerChannelPricing} from './channel-pricing.mjs';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
const log=(tx,resource,action,detail={})=>tx.query('INSERT INTO channel_activity(id,resource,action,detail) VALUES($1,$2,$3,$4)',[randomUUID(),resource,action,JSON.stringify(detail)]);
const text=(v,max,min=1)=>typeof v==='string'&&v.trim().length>=min&&v.length<=max;
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const external=s.str(160),revision=s.int(1),images=s.array({type:'string',maxLength:2000,pattern:'^(https://[^\\s]+|/assets/[a-zA-Z0-9._-]+)$'},10);
export const channelProductSchema=s.object({external_id:external,slug:s.slug,name:s.str(200),description:s.str(10000,0),category:s.str(120),images,published:s.bool,source_revision:revision,variants:s.array(s.object({external_id:external,sku:s.str(100),name:s.str(160),price_minor:s.int(1),currency:{const:'CAD'},active:s.bool}),100)});
export const channelInventorySchema=s.object({external_id:external,quantity:s.int(0,1000000),source_revision:revision});
export const channelOrderSchema=s.object({external_id:external,source_revision:revision,customer_email:s.email,currency:{const:'CAD'},total_minor:s.int(1),status:s.choice(['paid','cancelled','refunded']),fulfillment:s.choice(['unfulfilled','fulfilled']),lines:s.array(s.object({external_variant_id:external,name:s.str(200),quantity:s.int(1,99),unit_minor:s.int(1)}),100),breakdown:channelBreakdownSchema},['external_id','source_revision','customer_email','currency','total_minor','status','fulfillment','lines']);
export const channelEnvelopeSchema=s.object({event_id:external,kind:s.choice(['product','inventory','order']),payload:{type:'object'}});
function validateEnvelope(e){
  if(!e||!text(e.event_id,160)||!['product','inventory','order'].includes(e.kind)||!e.payload||!text(e.payload.external_id,160)||!integer(e.payload.source_revision,1,99999999))fail(400,'Invalid normalised commerce event.');
  const p=e.payload;
  const schema={product:channelProductSchema,inventory:channelInventorySchema,order:channelOrderSchema}[e.kind];
  if(Object.keys(e).some(k=>!['event_id','kind','payload'].includes(k))||Object.keys(p).some(k=>!Object.hasOwn(schema.properties,k)))fail(400,'Unexpected commerce event fields.');
  if(e.kind==='inventory'){if(!integer(p.quantity,0,1000000))fail(400,'Invalid inventory quantity.');return;}
  if(e.kind==='product'){
    if(!text(p.name,200)||!text(p.slug,100)||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.slug)||!text(p.description,10000,0)||!text(p.category,120)||typeof p.published!=='boolean'||!Array.isArray(p.images)||p.images.length>10||p.images.some(i=>!text(i,2000)||! /^(https:\/\/[^\s]+|\/assets\/[a-zA-Z0-9._-]+)$/.test(i))||!Array.isArray(p.variants)||p.variants.length<1||p.variants.length>100)fail(400,'Invalid catalogue snapshot.');
    const ids=new Set(),skus=new Set();for(const v of p.variants){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!Object.hasOwn(channelProductSchema.properties.variants.items.properties,k))||!text(v.external_id,160)||!text(v.sku,100)||!text(v.name,160)||v.currency!=='CAD'||!integer(v.price_minor,1,99999999)||typeof v.active!=='boolean'||ids.has(v.external_id)||skus.has(v.sku))fail(400,'Invalid or duplicated product variant.');ids.add(v.external_id);skus.add(v.sku);}return;
  }
  if(!text(p.customer_email,254)||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.customer_email)||p.currency!=='CAD'||!integer(p.total_minor,1,99999999)||!['paid','cancelled','refunded'].includes(p.status)||!['unfulfilled','fulfilled'].includes(p.fulfillment)||!Array.isArray(p.lines)||p.lines.length<1||p.lines.length>100||p.lines.some(l=>!l||typeof l!=='object'||Array.isArray(l)||!text(l.external_variant_id,160)||!text(l.name,200)||!integer(l.quantity,1,99)||!integer(l.unit_minor,1,99999999)))fail(400,'Invalid order snapshot.');
  if(p.lines.some(l=>Object.keys(l).some(k=>!Object.hasOwn(channelOrderSchema.properties.lines.items.properties,k))))fail(400,'Unexpected order line fields.');
  orderBreakdown(p.lines,p.breakdown,p.total_minor);
}
async function inventory(tx,id,quantity,sourceRevision){
  const v=await one(tx,'SELECT * FROM channel_variants WHERE external_id=$1 FOR UPDATE',[id]);if(!v)return{rejected:true,reason:'variant_not_mapped'};
  if(sourceRevision<=v.inventory_revision)return{ignored:true,reason:'stale_inventory'};
  await tx.query('UPDATE channel_variants SET stock=$2,inventory_revision=$3 WHERE id=$1',[v.id,quantity,sourceRevision]);await log(tx,v.id,'inventory.snapshot',{previous:v.stock,quantity,source_revision:sourceRevision});return{applied:true,id:v.id};
}
async function applyEvent(tx,e,{source='admin_demo',config={},origin='http://127.0.0.1:3030'}={}){
  const p=e.payload;
  if(e.kind==='inventory')return inventory(tx,p.external_id,p.quantity,p.source_revision);
  if(e.kind==='product'){
    const old=await one(tx,'SELECT * FROM channel_products WHERE external_id=$1 FOR UPDATE',[p.external_id]);if(old&&p.source_revision<=old.source_revision)return{ignored:true,reason:'stale_product',id:old.id};
    const id=old?.id||randomUUID();
    if(await one(tx,'SELECT id FROM channel_products WHERE slug=$1 AND id<>$2',[p.slug,id]))return{rejected:true,reason:'slug_conflict'};
    for(const v of p.variants){const taken=(await tx.query('SELECT product_id,external_id FROM channel_variants WHERE external_id=$1 OR sku=$2',[v.external_id,v.sku])).rows;if(taken.some(t=>t.product_id!==id||t.external_id!==v.external_id))return{rejected:true,reason:'variant_or_sku_conflict'};}
    if(old)await tx.query('UPDATE channel_products SET slug=$2,name=$3,description=$4,category=$5,images=$6,published=$7,source_revision=$8,updated_at=now() WHERE id=$1',[id,p.slug,p.name,p.description,p.category,JSON.stringify(p.images),p.published,p.source_revision]);
    else await tx.query('INSERT INTO channel_products(id,external_id,slug,name,description,category,images,published,source_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,p.external_id,p.slug,p.name,p.description,p.category,JSON.stringify(p.images),p.published,p.source_revision]);
    await tx.query('UPDATE channel_variants SET active=false WHERE product_id=$1',[id]);
    for(const v of p.variants)await tx.query('INSERT INTO channel_variants(id,product_id,external_id,sku,name,price_minor,currency,active) VALUES($1,$2,$3,$4,$5,$6,\'CAD\',$7) ON CONFLICT(external_id) DO UPDATE SET sku=EXCLUDED.sku,name=EXCLUDED.name,price_minor=EXCLUDED.price_minor,active=EXCLUDED.active',[randomUUID(),id,v.external_id,v.sku,v.name,v.price_minor,v.active]);
    if(source==='verified_adapter')await tx.query('UPDATE channel_products SET source_published=$2,published=$2 AND NOT local_hidden AND NOT archived WHERE id=$1',[id,p.published]);
    await log(tx,id,'catalogue.snapshot',{source_revision:p.source_revision});return{applied:true,id};
  }
  const old=await one(tx,'SELECT * FROM channel_orders WHERE external_id=$1 FOR UPDATE',[p.external_id]);if(old&&p.source_revision<=old.source_revision)return{ignored:true,reason:'stale_order',id:old.id};
  if(old&&(old.customer_email!==p.customer_email.toLowerCase()||Number(old.total_minor)!==p.total_minor||snapshotHash(old.snapshot.lines)!==snapshotHash(p.lines)||snapshotHash(orderBreakdown(old.snapshot.lines,old.snapshot.breakdown,Number(old.total_minor)))!==snapshotHash(orderBreakdown(p.lines,p.breakdown,p.total_minor))))return{rejected:true,reason:'immutable_order_changed',id:old.id};
  if(old&&(['cancelled','refunded'].includes(old.status)&&p.status!==old.status||old.fulfillment==='fulfilled'&&p.fulfillment!=='fulfilled'))return{rejected:true,reason:'order_state_regression',id:old.id};
  const id=old?.id||randomUUID();
  if(old)await tx.query('UPDATE channel_orders SET source_revision=$2,status=$3,fulfillment=$4,updated_at=now() WHERE id=$1',[id,p.source_revision,p.status,p.fulfillment]);
  else await tx.query('INSERT INTO channel_orders(id,external_id,source_revision,customer_email,currency,total_minor,snapshot,status,fulfillment) VALUES($1,$2,$3,$4,\'CAD\',$5,$6,$7,$8)',[id,p.external_id,p.source_revision,p.customer_email.toLowerCase(),p.total_minor,JSON.stringify(p),p.status,p.fulfillment]);
  // Imported order events never subtract stock. Absolute inventory events are the
  // source of truth; doing both would deduct the same Shopify sale twice.
  await log(tx,id,'order.snapshot',{status:p.status,fulfillment:p.fulfillment,inventory_adjusted:false});
  const verified=source==='verified_adapter';
  const notice=brandedMail({subject:'[PHASE 2 TEST] ViiShop order '+p.status,title:'Your ViiShop order',kicker:'VII · VIISHOP',paragraphs:[verified?'Shopify reports your order status as '+p.status+'. This email reflects the store record; contact VII with any questions.':'Your demonstration order status is '+p.status+'. This preview does not confirm a real payment or delivery.'],details:[['Reference',p.external_id],['Total',(p.total_minor/100).toFixed(2)+' CAD']],actionUrl:new URL('/cliente',origin).href,testNote:verified?'Phase 2 integration review. Store payment settings determine whether the transaction is a test.':'Shopify review simulation. No goods, money or refunds are processed.'});
  const delivery_scope=source==='verified_adapter'&&config.channelMailEnabled?'standard':'preview';
  await queueCommercialMail(tx,'channel-order:'+id+':'+p.status,p.customer_email,{...notice,delivery_scope});
  if(config.adminEmail)await queueCommercialMail(tx,'channel-order:'+id+':'+p.status+':admin',config.adminEmail,{...notice,delivery_scope});
  return{applied:true,id};
}
// Adapter boundary only. Provider authentication MUST precede this call. There
// is deliberately no public generic webhook and no outbound Shopify API request.
export async function ingestChannelEvent(db,event,context={}){
  validateEnvelope(event);if(!['admin_demo','verified_adapter'].includes(context.source||'admin_demo'))fail(403,'Unverified commerce source.');
  return db.transaction(async tx=>{
    // Persistent global import lock also serialises first-time IDs and SKU claims.
    await tx.query("INSERT INTO phase2_settings(key,value) VALUES('channel_import_lock','{}') ON CONFLICT(key) DO NOTHING");await tx.query("SELECT key FROM phase2_settings WHERE key='channel_import_lock' FOR UPDATE");
    if((context.source||'admin_demo')==='admin_demo'){
      const remote=event.payload.external_id.startsWith('gid://shopify/')||Boolean((await tx.query("SELECT 1 FROM channel_products WHERE external_id=$1 AND provider='shopify' UNION SELECT 1 FROM channel_variants v JOIN channel_products p ON p.id=v.product_id WHERE v.external_id=$1 AND p.provider='shopify'",[event.payload.external_id])).rows.length);
      if(remote)fail(409,'Imported Shopify resources are read-only in the demo tools. Change the authorised source store.');
    }
    const hash=snapshotHash(event),prior=await one(tx,'SELECT * FROM channel_events WHERE external_event_id=$1',[event.event_id]);if(prior){if(prior.payload_hash!==hash)fail(409,'Event ID reused with different data.');return{...prior.result,duplicate:true};}
    const result=await applyEvent(tx,event,context);await tx.query('INSERT INTO channel_events(id,external_event_id,kind,payload_hash,payload,status,result,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),event.event_id,event.kind,hash,JSON.stringify(event),result.rejected?'rejected':result.ignored?'ignored':'applied',JSON.stringify(result),context.source||'admin_demo']);return result;
  });
}
async function variants(db,productId){return(await db.query("SELECT v.*,coalesce((SELECT sum(h.quantity) FROM channel_holds h WHERE h.variant_id=v.id AND h.status='active'),0)::integer AS held FROM channel_variants v WHERE v.product_id=$1 ORDER BY v.name",[productId])).rows.map(v=>({...v,price_minor:Number(v.price_minor),available:Math.max(0,v.stock-v.held)}));}
async function catalogue(db,publicOnly=false){const items=(await db.query("SELECT * FROM channel_products WHERE ($1::boolean=false OR published AND NOT archived) ORDER BY created_at DESC LIMIT 200",[publicOnly])).rows;return Promise.all(items.map(async p=>({...p,channel:p.provider==='shopify'?'shopify':'shopify_demo',variants:(await variants(db,p.id)).filter(v=>!publicOnly||v.active)})));}
async function expire(tx,checkout,status){
  if(checkout.status!=='open')return;
  await tx.query('UPDATE channel_checkouts SET status=$2 WHERE id=$1',[checkout.id,status]);await tx.query("UPDATE channel_holds SET status='released' WHERE checkout_id=$1 AND status='active'",[checkout.id]);
}
export async function expireChannelCheckouts(db){const rows=(await db.query("SELECT id FROM channel_checkouts WHERE status='open' AND expires_at<=now() LIMIT 100")).rows;for(const r of rows)await db.transaction(async tx=>{const c=await one(tx,'SELECT * FROM channel_checkouts WHERE id=$1 FOR UPDATE',[r.id]);if(c?.status==='open'&&new Date(c.expires_at)<=new Date())await expire(tx,c,'expired');});return{considered:rows.length};}

export async function registerShopChannel(app,{db,adminGuard,customerGuard,config,origin,guestAccess}){
  registerChannelPricing(app,{db,adminGuard});
  const route=(method,url,body,handler)=>app.route({method,url:'/api/commercial/shop-channel'+url,...(body?{schema:{body}}:{}),preHandler:adminGuard,handler});
  route('GET','/catalogue',null,async()=>({items:await catalogue(db)}));
  route('GET','/events',null,async()=>({items:(await db.query('SELECT id,external_event_id,kind,status,result,created_at FROM channel_events ORDER BY created_at DESC LIMIT 100')).rows}));
  route('GET','/orders',null,async()=>({items:(await db.query('SELECT * FROM channel_orders ORDER BY created_at DESC LIMIT 100')).rows.map(r=>({...r,total_minor:Number(r.total_minor)}))}));
  route('GET','/checkouts',null,async()=>({items:(await db.query('SELECT * FROM channel_checkouts ORDER BY created_at DESC LIMIT 100')).rows.map(r=>({...r,total_minor:Number(r.total_minor)}))}));
  route('POST','/events/demo',channelEnvelopeSchema,async r=>ingestChannelEvent(db,r.body,{source:'admin_demo',config,origin}));
  route('POST','/examples',s.object({confirm:{const:true}}),async()=>{
    const fixtures=[['woven-cushion','Woven Cushion · Shopify Demo','Textiles','shop.png',7900],['ceramic-bowl','Ceramic Bowl · Shopify Demo','Decor','objects.png',4900]],results=[];
    for(const [slug,name,category,image,price]of fixtures){const externalId='demo-shopify-'+slug;if(await one(db,'SELECT id FROM channel_products WHERE external_id=$1',[externalId]))continue;
      results.push(await ingestChannelEvent(db,{event_id:'example-product-'+slug,kind:'product',payload:{external_id:externalId,slug:'channel-'+slug,name,description:'Fictional product for the Shopify channel review. No merchandise is delivered.',category,images:['/assets/'+image],published:true,source_revision:1,variants:[{external_id:externalId+'-natural',sku:'CHANNEL-'+slug.toUpperCase()+'-NATURAL',name:'Natural',currency:'CAD',price_minor:price,active:true},{external_id:externalId+'-sand',sku:'CHANNEL-'+slug.toUpperCase()+'-SAND',name:'Sand',currency:'CAD',price_minor:price+1000,active:true}]}},{source:'admin_demo',config,origin}));
      for(const color of ['natural','sand'])await ingestChannelEvent(db,{event_id:'example-inventory-'+slug+'-'+color,kind:'inventory',payload:{external_id:externalId+'-'+color,quantity:8,source_revision:1}},{source:'admin_demo'});
    }return{created:results.length};
  });
  route('POST','/products/:id/visibility',s.object({published:s.bool,archived:s.bool}),async r=>db.transaction(async tx=>{const p=await one(tx,'SELECT * FROM channel_products WHERE id=$1 FOR UPDATE',[r.params.id]);if(!p)fail(404,'Product not found.');const published=r.body.published&&!r.body.archived&&(p.provider!=='shopify'||p.source_published===true);await tx.query('UPDATE channel_products SET published=$2,archived=$3,local_hidden=$4 WHERE id=$1',[p.id,published,r.body.archived,p.provider==='shopify'&&!r.body.published]);await log(tx,p.id,'visibility.update',r.body);return{ok:true};}));
  route('POST','/checkouts/:id/simulate-paid',s.object({}),async r=>db.transaction(async tx=>{
    const c=await one(tx,'SELECT * FROM channel_checkouts WHERE id=$1 FOR UPDATE',[r.params.id]);if(!c)fail(404,'Checkout not found.');if(c.status==='paid')return{ok:true,duplicate:true};if(c.status!=='open'||new Date(c.expires_at)<=new Date())fail(409,'Checkout no longer accepts completion.');
    const holds=(await tx.query("SELECT * FROM channel_holds WHERE checkout_id=$1 AND status='active' ORDER BY variant_id",[c.id])).rows;if(!holds.length)fail(409,'No active inventory hold.');
    for(const h of holds){const v=await one(tx,'SELECT * FROM channel_variants WHERE id=$1 FOR UPDATE',[h.variant_id]);const all=(await tx.query("SELECT coalesce(sum(quantity),0)::integer AS n FROM channel_holds WHERE variant_id=$1 AND status='active'",[v.id])).rows[0].n;if(v.stock<all)fail(409,'Source inventory changed. Resolve the stock conflict first.');await inventory(tx,v.external_id,v.stock-h.quantity,v.inventory_revision+1);}
    await tx.query("UPDATE channel_holds SET status='consumed' WHERE checkout_id=$1",[c.id]);await tx.query("UPDATE channel_checkouts SET status='paid' WHERE id=$1",[c.id]);
    const order={external_id:'DEMO-CHANNEL-'+c.id,source_revision:1,customer_email:c.snapshot.customer.email,currency:'CAD',total_minor:Number(c.total_minor),status:'paid',fulfillment:'unfulfilled',lines:c.snapshot.lines.map(l=>({external_variant_id:l.external_id,name:l.name,quantity:l.quantity,unit_minor:l.unit_minor})),...(c.snapshot.breakdown?{breakdown:c.snapshot.breakdown}:{})};
    const result=await applyEvent(tx,{kind:'order',payload:order},{source:'admin_demo',config,origin});await tx.query('UPDATE channel_orders SET checkout_id=$2 WHERE id=$1',[result.id,c.id]);return{ok:true,order_id:result.id};
  }));
  app.get('/api/shop-channel/catalogue',async()=>({items:await catalogue(db,true)}));
  app.get('/api/shop-channel/products/:slug',async r=>{const p=await one(db,'SELECT * FROM channel_products WHERE slug=$1 AND published AND NOT archived',[r.params.slug]);if(!p)fail(404,'Product not found.');return{...p,channel:p.provider==='shopify'?'shopify':'shopify_demo',variants:(await variants(db,p.id)).filter(v=>v.active)};});
  const client=(method,path,body,handler)=>app.route({method,url:'/api/client/shop-channel'+path,...(body?{schema:{body}}:{}),preHandler:customerGuard,handler});
  const buyerClient=(method,path,body,handler)=>app.route({method,url:'/api/client/shop-channel'+path,schema:{body},preHandler:path==='/quote'?async()=>{}:guestAccess.buyerGuard,config:{rateLimit:{max:20,timeWindow:'1 minute'}},handler});
  const cartSchema=s.object({lines:{...s.array(s.object({variant_id:s.uuid,quantity:s.int(1,99)}),30),minItems:1},shipping_option:s.str(60,0),discount_code:s.str(80,0),pricing_revision:s.int(0)},['lines']);
  buyerClient('POST','/quote',cartSchema,async r=>{
    if(new Set(r.body.lines.map(l=>l.variant_id)).size!==r.body.lines.length)fail(400,'Variants must be unique.');
    const lines=[];for(const l of r.body.lines){const v=await one(db,'SELECT v.* FROM channel_variants v JOIN channel_products p ON p.id=v.product_id WHERE v.id=$1 AND v.active AND p.published AND NOT p.archived',[l.variant_id]);if(!v)fail(409,'Variant not available.');lines.push({quantity:l.quantity,unit_minor:Number(v.price_minor)});}
    const p=await channelPolicy(db);if(r.body.pricing_revision!==undefined&&r.body.pricing_revision!==p.revision)fail(409,'Pricing changed. Refresh first.');return{...priceChannel(lines,p,r.body),currency:'CAD',quote_only:true};
  });
  client('GET','/checkouts',null,async r=>({items:(await db.query('SELECT * FROM channel_checkouts WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100',[r.customer.id])).rows.map(c=>({...c,total_minor:Number(c.total_minor)}))}));
  buyerClient('POST','/checkouts',s.object({idempotency_key:s.uuid,consent:{const:true},customer:guestCustomerSchema,lines:{...s.array(s.object({variant_id:s.uuid,quantity:s.int(1,99)}),30),minItems:1},shipping_option:s.str(60,0),discount_code:s.str(80,0),pricing_revision:s.int(0),expected_total_minor:s.int(1)},['idempotency_key','consent','lines']),async r=>db.transaction(async tx=>{
    const input={lines:[...r.body.lines].sort((a,b)=>a.variant_id.localeCompare(b.variant_id)),consent:true,shipping_option:r.body.shipping_option||'',discount_code:(r.body.discount_code||'').trim().toUpperCase(),pricing_revision:r.body.pricing_revision??null,expected_total_minor:r.body.expected_total_minor??null};
    const legacyInput=r.body.shipping_option===undefined&&r.body.discount_code===undefined&&r.body.pricing_revision===undefined&&r.body.expected_total_minor===undefined,hash=snapshotHash({...(!r.customer.guest&&legacyInput?{lines:input.lines,consent:true}:input),...(r.customer.guest?{customer:{name:r.customer.name,email:r.customer.email}}:{})});if(new Set(input.lines.map(l=>l.variant_id)).size!==input.lines.length)fail(400,'Variants must be unique.');
    await tx.query('SELECT id FROM '+(r.customer.guest?'guest_buyers':'customer_accounts')+' WHERE id=$1 FOR UPDATE',[r.customer.id]);const previous=await one(tx,'SELECT * FROM channel_checkouts WHERE buyer_ref=$1 AND idempotency_key=$2',[buyerRef(r.customer),r.body.idempotency_key]);if(previous){if(previous.payload_hash!==hash)fail(409,'Checkout key reused with different items.');return{id:previous.id,status:previous.status};}
    const lines=[];for(const line of input.lines){const v=await one(tx,'SELECT * FROM channel_variants WHERE id=$1 FOR UPDATE',[line.variant_id]);if(!v?.active)fail(409,'Variant not available.');const p=await one(tx,'SELECT * FROM channel_products WHERE id=$1',[v.product_id]);if(p.provider==='shopify')fail(409,'Use the external Shopify checkout; no local stock holds are allowed for this source.');if(!p.published||p.archived)fail(409,'Product not available.');const held=(await tx.query("SELECT coalesce(sum(quantity),0)::integer AS n FROM channel_holds WHERE variant_id=$1 AND status='active'",[v.id])).rows[0].n;if(v.stock-held<line.quantity)fail(409,'Insufficient stock.');lines.push({variant_id:v.id,external_id:v.external_id,sku:v.sku,name:p.name+' · '+v.name,quantity:line.quantity,unit_minor:Number(v.price_minor)});}
    await tx.query('SELECT pg_advisory_xact_lock(73182011)');const policy=await channelPolicy(tx);if(input.pricing_revision!==null&&input.pricing_revision!==policy.revision)fail(409,'Pricing changed. Refresh before preparing the order.');
    const calculation=priceChannel(lines,policy,input),total=calculation.breakdown.total_minor,id=randomUUID();
    if(r.body.expected_total_minor!==undefined&&r.body.expected_total_minor!==total)fail(409,'The quote amount changed. Review the updated price before creating the order.');
    await tx.query("INSERT INTO channel_checkouts(id,customer_id,buyer_ref,idempotency_key,payload_hash,snapshot,total_minor,currency,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'CAD',now()+interval '30 minutes')",[id,buyerId(r.customer),buyerRef(r.customer),r.body.idempotency_key,hash,JSON.stringify({customer:{name:r.customer.name,email:r.customer.email},lines,...calculation,consent_recorded_at:new Date().toISOString(),demo:true,delivery:'No delivery - demonstration only'}),total]);
    for(const line of lines)await tx.query("INSERT INTO channel_holds(checkout_id,variant_id,quantity,status) VALUES($1,$2,$3,'active')",[id,line.variant_id,line.quantity]);await guestAccess.confirmation(tx,'channel',id,r.customer);return{id,total_minor:total,...calculation,currency:'CAD',status:'open',payment:'demo_only',checkout_url:null,guest:!!r.customer.guest};
  }));
  client('POST','/checkouts/:id/cancel',s.object({}),async r=>db.transaction(async tx=>{const c=await one(tx,'SELECT * FROM channel_checkouts WHERE id=$1 AND customer_id=$2 FOR UPDATE',[r.params.id,r.customer.id]);if(!c)fail(404,'Checkout not found.');if(c.status==='paid')fail(409,'Paid demo order cannot be cancelled as an unpaid checkout.');await expire(tx,c,'cancelled');return{ok:true};}));
  client('GET','/orders',null,async r=>({items:(await db.query('SELECT * FROM channel_orders WHERE customer_email=$1 ORDER BY created_at DESC LIMIT 100',[r.customer.email])).rows.map(o=>({...o,total_minor:Number(o.total_minor)}))}));
}
