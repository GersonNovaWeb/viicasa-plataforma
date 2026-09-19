import {id,hash,fail,dateRange,money} from './lib.js';
import {now,afterMinutes,key,must,auditDoc} from './firestore-store.js';
import {propertyRate,variantRate} from './pricing.js';

export const safeCheckout=row=>{
  const {guest_id,request_hash,idempotency_key,...safe}=row;
  return {...safe,balance_minor:row.total_minor-row.due_minor};
};
export function nightsBetween(start,end){
  const dates=[];for(let t=Date.parse(start);t<Date.parse(end);t+=86400000)dates.push(new Date(t).toISOString().slice(0,10));return dates;
}
const occupancyId=(propertyId,date)=>`${propertyId}_${date}`;
export const isOccupied=row=>row && (row.kind==='block'||row.status==='confirmed'||(row.status==='pending'&&row.expires_at>now()));
async function loadNights(tx,propertyId,start,end){
  const dates=nightsBetween(start,end);
  const rows=[];for(const date of dates)rows.push(await tx.get('occupancy',occupancyId(propertyId,date)));
  return {dates,rows};
}
export async function quote(tx,input){
  const p=must(await tx.get('properties',input.property_id),'Propiedad no disponible');
  if(!p.published||p.archived)fail(404,'Propiedad no disponible');
  const nights=dateRange(input.check_in,input.check_out,p.timezone);
  if(nights<p.min_nights)fail(400,`Estancia mínima: ${p.min_nights} noches`);
  if(input.guests>p.capacity)fail(400,'Se supera la capacidad de la propiedad');
  const occupied=await loadNights(tx,p.id,input.check_in,input.check_out);
  if(occupied.rows.some(isOccupied))fail(409,'La propiedad no está disponible en esas fechas');
  const rate=propertyRate(p,input.currency);
  const total=money(nights*rate.nightly_minor+rate.cleaning_minor);
  return{property_id:p.id,property_name:p.name,check_in:input.check_in,check_out:input.check_out,timezone:p.timezone,
    guests:input.guests,nights,...rate,total_minor:total,
    deposit_minor:Math.ceil(total*p.deposit_percent/100),policies:p.policies,
    pricing_note:'Importes finales configurados por el administrador; no incluye cálculo fiscal automático.'};
}
async function prior(tx,guestId,idempotencyKey,input,kind){
  const guest=must(await tx.get('guests',guestId),'Sesión no encontrada');
  if(guest.expires_at<=now())fail(401,'Sesión expirada');
  const index=key('checkout',`${guestId}:${idempotencyKey}`),saved=await tx.get('idempotency',index);
  const requestHash=hash(JSON.stringify({kind,input}));
  if(saved && saved.request_hash!==requestHash)fail(409,'Esta clave de idempotencia ya se utilizó con otros datos');
  return{index,requestHash,row:saved?must(await tx.get('checkouts',saved.checkout_id)):null};
}
function checkoutRecord(config,guestId,idempotencyKey,requestHash,kind,customer,total,due,currency,detail){
  return{id:id(),guest_id:guestId,idempotency_key:idempotencyKey,request_hash:requestHash,kind,status:'pending',
    customer_name:customer.name,customer_email:customer.email.toLowerCase(),customer_phone:customer.phone,
    currency,total_minor:total,due_minor:due,detail:{...detail,consent:true,consent_recorded_at:now()},
    created_at:now(),expires_at:afterMinutes(config.holdMinutes)};
}
function saveCheckout(tx,c,index){
  tx.create('checkouts',c.id,c);tx.create('idempotency',index,{checkout_id:c.id,request_hash:c.request_hash});
}
export async function createBooking(store,config,guestId,idempotencyKey,input){
  return store.transaction(async tx=>{
    const saved=await prior(tx,guestId,idempotencyKey,input,'booking');if(saved.row)return safeCheckout(saved.row);
    const estimate=await quote(tx,input);
    const c=checkoutRecord(config,guestId,idempotencyKey,saved.requestHash,'booking',input.customer,estimate.total_minor,
      input.pay==='deposit'?estimate.deposit_minor:estimate.total_minor,estimate.currency,{...estimate,pay:input.pay});
    saveCheckout(tx,c,saved.index);
    // One deterministic document per property/night. Competing reservations read and write the same documents.
    for(const date of nightsBetween(input.check_in,input.check_out))tx.put('occupancy',occupancyId(input.property_id,date),{
      property_id:input.property_id,date,kind:'booking',checkout_id:c.id,status:'pending',expires_at:c.expires_at});
    return safeCheckout(c);
  });
}
export async function cartItems(store,guestId,currency){
  const cart=await store.get('carts',guestId),items=[];
  for(const entry of cart?.items||[]){
    const v=await store.get('variants',entry.variant_id);if(!v)continue;
    const p=await store.get('products',v.product_id);if(!p)continue;
    let rate;try{rate={...variantRate(v,currency),price_available:true};}catch{rate={price_minor:null,currency,price_available:false};}
    items.push({variant_id:v.id,sku:v.sku,name:v.name,...rate,stock:v.stock,active:v.active,
      quantity:entry.quantity,product_name:p.name,published:p.published,archived:p.archived});
  }return{items};
}
export async function setCart(store,guestId,variantId,quantity){
  return store.transaction(async tx=>{
    const cart=await tx.get('carts',guestId)||{id:guestId,items:[]};
    if(quantity){
      const v=must(await tx.get('variants',variantId),'Producto no disponible'),p=must(await tx.get('products',v.product_id));
      if(!v.active||!p.published||p.archived)fail(404,'Producto no disponible');
    }
    cart.items=cart.items.filter(x=>x.variant_id!==variantId);
    if(quantity)cart.items.push({variant_id:variantId,quantity});
    if(cart.items.length>50)fail(400,'Máximo 50 variantes por carrito');
    cart.items.sort((a,b)=>a.variant_id.localeCompare(b.variant_id));tx.put('carts',guestId,cart);
    return{variant_id:variantId,quantity};
  });
}
function movement(tx,variant,delta,reason,checkoutId=null,actor=null){
  const mid=id();tx.create('stock_movements',mid,{variant_id:variant.id,delta,reason,checkout_id:checkoutId,actor_id:actor,created_at:now()});
}
export async function createOrder(store,config,guestId,idempotencyKey,input){
  await expireHolds(store);
  return store.transaction(async tx=>{
    const saved=await prior(tx,guestId,idempotencyKey,input,'order');if(saved.row)return safeCheckout(saved.row);
    const cart=await tx.get('carts',guestId);if(!cart?.items.length)fail(400,'El carrito está vacío');
    const items=[];let total=0,currency=null;
    for(const line of cart.items){
      const v=must(await tx.get('variants',line.variant_id),'Variante no encontrada'),p=must(await tx.get('products',v.product_id));
      if(!v.active||!p.published||p.archived)fail(409,'Un producto del carrito ya no está disponible');
      if(v.stock<line.quantity)fail(409,`Inventario insuficiente: ${v.sku}`);
      const rate=variantRate(v,input.currency);
      if(currency && currency!==rate.currency)fail(400,'No se pueden mezclar monedas en un pedido');
      currency=rate.currency;total+=rate.price_minor*line.quantity;
      items.push({variant_id:v.id,sku:v.sku,name:`${p.name} · ${v.name}`,quantity:line.quantity,unit_minor:rate.price_minor});
    }
    const settings=must(await tx.get('shop_settings',currency));
    if(input.delivery==='shipping'&&(!settings.shipping_enabled||!input.shipping_address))fail(400,'Envío no habilitado o falta dirección');
    if(input.delivery==='pickup'&&!settings.pickup_enabled)fail(400,'La recolección no está habilitada');
    const shipping=input.delivery==='shipping'?settings.shipping_minor:0,subtotal=total;total=money(total+shipping);
    const detail={delivery:input.delivery,subtotal_minor:subtotal,shipping_minor:shipping,shipping_address:input.delivery==='shipping'?input.shipping_address:null,
      pickup_instructions:input.delivery==='pickup'?settings.pickup_instructions:null,terms:settings.terms,note:input.note||'',items};
    const c=checkoutRecord(config,guestId,idempotencyKey,saved.requestHash,'order',input.customer,total,total,currency,detail);
    for(const line of items){const v=await tx.get('variants',line.variant_id);tx.put('variants',v.id,{...v,stock:v.stock-line.quantity});movement(tx,v,-line.quantity,'checkout_hold',c.id);}
    saveCheckout(tx,c,saved.index);tx.put('carts',guestId,{id:guestId,items:[]});return safeCheckout(c);
  });
}
export async function updateOccupancy(tx,checkout,status,expiry=checkout.expires_at){
  const d=checkout.detail;if(checkout.kind!=='booking')return true;
  const {dates,rows}=await loadNights(tx,d.property_id,d.check_in,d.check_out);
  if(rows.some(row=>!row||row.checkout_id!==checkout.id))return false;
  for(let i=0;i<dates.length;i++)tx.put('occupancy',occupancyId(d.property_id,dates[i]),{...rows[i],status,expires_at:expiry});
  return true;
}
export async function release(tx,c,status){
  if(c.status!=='pending')return;
  if(c.kind==='order')for(const line of c.detail.items){
    const v=must(await tx.get('variants',line.variant_id));tx.put('variants',v.id,{...v,stock:v.stock+line.quantity});movement(tx,v,line.quantity,status,c.id);
  }
  if(c.kind==='booking'){
    const d=c.detail,{dates,rows}=await loadNights(tx,d.property_id,d.check_in,d.check_out);
    for(let i=0;i<dates.length;i++)if(rows[i]?.checkout_id===c.id)tx.remove('occupancy',occupancyId(d.property_id,dates[i]));
  }
  tx.put('checkouts',c.id,{...c,status});
}
export async function expireHolds(store){
  const candidates=await store.list('checkouts',{where:[['status','==','pending'],['expires_at','<=',now()]],order:[['expires_at','asc']],limit:100});
  let expired=0;
  for(const candidate of candidates)expired+=await store.transaction(async tx=>{
    const c=await tx.get('checkouts',candidate.id);if(!c||c.status!=='pending'||c.expires_at>now())return 0;
    await release(tx,c,'expired');return 1;
  });return{expired};
}
export async function enqueue(tx,dedupe,recipient,subject,body){
  const mailId=key('mail',dedupe);if(await tx.get('mail_outbox',mailId))return;
  tx.create('mail_outbox',mailId,{recipient,subject,body,status:'pending',attempts:0,next_attempt:now(),created_at:now(),lease_token:null});
}
export async function notice(tx,c,status,config){
  const label=c.kind==='booking'?'Reservación':'Pedido',subject=`VIICASA · ${label} ${status}`;
  const body=`${label}: ${c.id}\nEstado: ${status}\nCliente: ${c.customer_name}\nTotal: ${(c.total_minor/100).toFixed(2)} ${c.currency}\nImporte del pago: ${(c.due_minor/100).toFixed(2)} ${c.currency}\nDetalle: ${JSON.stringify(c.detail,null,2)}`;
  await enqueue(tx,`${c.id}:${status}:customer`,c.customer_email,subject,body);
  await enqueue(tx,`${c.id}:${status}:admin`,config.adminEmail,subject,body);
}
export async function cancelCheckout(store,config,checkoutId,guestId,actor=null){
  return store.transaction(async tx=>{
    const c=must(await tx.get('checkouts',checkoutId),'Operación no encontrada');
    if(guestId&&c.guest_id!==guestId)fail(404,'Operación no encontrada');
    if(c.status==='cancelled')return safeCheckout(c);
    if(c.status!=='pending')fail(409,'Solo se cancelan operaciones pendientes; las confirmadas requieren revisión y devolución');
    await release(tx,c,'cancelled');await notice(tx,c,'cancelada',config);auditDoc(tx,actor,'checkout.cancel',c.id);
    return safeCheckout({...c,status:'cancelled'});
  });
}
export async function blockCalendar(store,actor,propertyId,input){
  return store.transaction(async tx=>{
    const p=must(await tx.get('properties',propertyId));dateRange(input.check_in,input.check_out,p.timezone);
    const {dates,rows}=await loadNights(tx,p.id,input.check_in,input.check_out);
    if(rows.some(isOccupied))fail(409,'Existen reservas o bloqueos en esas fechas');
    const b={id:id(),property_id:propertyId,...input};tx.create('calendar_blocks',b.id,b);
    dates.forEach(date=>tx.put('occupancy',occupancyId(p.id,date),{property_id:p.id,date,kind:'block',block_id:b.id}));
    auditDoc(tx,actor,'calendar.block',b.id);return b;
  });
}
export async function unblockCalendar(store,actor,blockId){
  await store.transaction(async tx=>{
    const b=must(await tx.get('calendar_blocks',blockId));
    const {dates,rows}=await loadNights(tx,b.property_id,b.check_in,b.check_out);
    dates.forEach((date,i)=>{if(rows[i]?.block_id===b.id)tx.remove('occupancy',occupancyId(b.property_id,date));});
    tx.remove('calendar_blocks',b.id);auditDoc(tx,actor,'calendar.unblock',b.id);
  });
}
export async function calendar(store,propertyId,from,to){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||to<=from||Date.parse(to)-Date.parse(from)>366*86400000)fail(400,'Rango inválido, máximo un año');
  const blocks=new Set(),bookings=new Set();
  for(const date of nightsBetween(from,to)){
    const row=await store.get('occupancy',occupancyId(propertyId,date));if(!isOccupied(row))continue;
    if(row.kind==='block')blocks.add(row.block_id);else bookings.add(row.checkout_id);
  }
  return{blocks:await Promise.all([...blocks].map(k=>store.get('calendar_blocks',k))),bookings:await Promise.all([...bookings].map(async k=>{
    const c=must(await store.get('checkouts',k)),d=c.detail;
    return{checkout_id:c.id,property_id:propertyId,check_in:d.check_in,check_out:d.check_out,guests:d.guests,status:c.status};
  }))};
}
