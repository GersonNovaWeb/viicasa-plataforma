import { one } from './db.js';
import { id, hash, fail, dateRange, money, audit } from './lib.js';
import { checkoutNotice } from './notifications.js';

export async function releaseCheckout(tx, checkout, status) {
  if (checkout.status !== 'pending') return;
  if (checkout.kind === 'order') {
    const items = (await tx.query('SELECT * FROM order_items WHERE checkout_id=$1 ORDER BY variant_id', [checkout.id])).rows;
    for (const item of items) {
      await tx.query('UPDATE variants SET stock=stock+$2 WHERE id=$1', [item.variant_id,item.quantity]);
      await tx.query('INSERT INTO stock_movements(id,variant_id,delta,reason,checkout_id) VALUES($1,$2,$3,$4,$5)',
        [id(),item.variant_id,item.quantity,status,checkout.id]);
    }
  }
  await tx.query('UPDATE checkouts SET status=$2 WHERE id=$1', [checkout.id,status]);
}
export async function expireHolds(db) {
  return db.transaction(async tx => {
    const expired = (await tx.query(`SELECT * FROM checkouts WHERE status='pending' AND expires_at<=now()
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100`)).rows;
    // Stable variant locking order across the whole batch prevents deadlocks between expirations.
    if (expired.length) {
      await tx.query(`SELECT id FROM variants WHERE id IN (SELECT variant_id FROM order_items WHERE checkout_id=ANY($1::uuid[]))
        ORDER BY id FOR UPDATE`, [expired.map(x => x.id)]);
    }
    for (const row of expired) await releaseCheckout(tx, row, 'expired');
    return { expired: expired.length };
  });
}
export async function quote(tx, input, lock = false) {
  const property = await one(tx, `SELECT * FROM properties WHERE id=$1 AND published=true AND archived=false${lock ? ' FOR UPDATE' : ''}`, [input.property_id]);
  if (!property) fail(404, 'Propiedad no disponible');
  const nights = dateRange(input.check_in,input.check_out,property.timezone);
  if (nights < property.min_nights) fail(400, `Estancia mínima: ${property.min_nights} noches`);
  if (input.guests > property.capacity) fail(400, 'Se supera la capacidad de la propiedad');
  const busy = await one(tx, `SELECT b.checkout_id FROM bookings b JOIN checkouts c ON c.id=b.checkout_id
    WHERE b.property_id=$1 AND b.check_in<$3::date AND b.check_out>$2::date
    AND (c.status='confirmed' OR (c.status='pending' AND c.expires_at>now())) LIMIT 1`, [property.id,input.check_in,input.check_out]);
  const blocked = await one(tx, 'SELECT id FROM calendar_blocks WHERE property_id=$1 AND check_in<$3::date AND check_out>$2::date LIMIT 1', [property.id,input.check_in,input.check_out]);
  if (busy || blocked) fail(409, 'La propiedad no está disponible en esas fechas');
  const total = money(nights * property.nightly_minor + property.cleaning_minor);
  return { property_id: property.id, property_name: property.name, check_in: input.check_in, check_out: input.check_out,
    timezone: property.timezone, guests: input.guests, nights, nightly_minor: property.nightly_minor,
    cleaning_minor: property.cleaning_minor, total_minor: total, currency: property.currency,
    deposit_minor: Math.ceil(total * property.deposit_percent / 100), policies: property.policies,
    pricing_note: 'Importes finales configurados por el administrador; no incluye cálculo fiscal automático.' };
}
export async function existingCheckout(tx, guestId, key, input, kind) {
  await tx.query('SELECT id FROM guests WHERE id=$1 FOR UPDATE', [guestId]);
  const row = await one(tx, 'SELECT * FROM checkouts WHERE guest_id=$1 AND idempotency_key=$2', [guestId,key]);
  const requestHash = hash(JSON.stringify({ kind, input }));
  if (row && row.request_hash !== requestHash) fail(409, 'Esta clave de idempotencia ya se utilizó con otros datos');
  return { row, requestHash };
}
async function insertCheckout(tx, config, guestId, key, requestHash, kind, customer, total, due, currency, detail) {
  return one(tx, `INSERT INTO checkouts(id,guest_id,kind,idempotency_key,request_hash,customer_name,customer_email,customer_phone,
    total_minor,due_minor,currency,detail,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()+($13*interval '1 minute')) RETURNING *`,
    [id(),guestId,kind,key,requestHash,customer.name,customer.email.toLowerCase(),customer.phone,total,due,currency,
      JSON.stringify({ ...detail, consent: true, consent_recorded_at: new Date().toISOString() }),config.holdMinutes]);
}
export async function createBooking(db, config, guestId, key, input) {
  return db.transaction(async tx => {
    const { row, requestHash } = await existingCheckout(tx, guestId, key, input, 'booking');
    if (row) return publicCheckout(row);
    const estimate = await quote(tx, input, true);
    const checkout = await insertCheckout(tx,config,guestId,key,requestHash,'booking',input.customer,estimate.total_minor,
      input.pay === 'deposit' ? estimate.deposit_minor : estimate.total_minor,estimate.currency,{ ...estimate, pay: input.pay });
    await tx.query('INSERT INTO bookings(checkout_id,property_id,check_in,check_out,guests) VALUES($1,$2,$3,$4,$5)',
      [checkout.id,input.property_id,input.check_in,input.check_out,input.guests]);
    return publicCheckout(checkout);
  });
}
export async function createOrder(db, config, guestId, key, input) {
  await expireHolds(db);
  return db.transaction(async tx => {
    const { row, requestHash } = await existingCheckout(tx,guestId,key,input,'order');
    if (row) return publicCheckout(row);
    await tx.query(`SELECT id FROM products WHERE id IN(SELECT v.product_id FROM cart_items c JOIN variants v ON v.id=c.variant_id WHERE c.guest_id=$1)
      ORDER BY id FOR UPDATE`,[guestId]);
    const items = (await tx.query(`SELECT v.*, c.quantity, p.name AS product_name, p.published, p.archived FROM cart_items c
      JOIN variants v ON v.id=c.variant_id JOIN products p ON p.id=v.product_id
      WHERE c.guest_id=$1 ORDER BY v.id FOR UPDATE OF v`, [guestId])).rows;
    if (!items.length) fail(400, 'El carrito está vacío');
    if (items.length > 50) fail(400, 'Máximo 50 variantes por pedido');
    const currency = items[0].currency;
    let total = 0;
    for (const item of items) {
      if (!item.active || !item.published || item.archived) fail(409, 'Un producto del carrito ya no está disponible');
      if (item.currency !== currency) fail(400, 'No se pueden mezclar monedas en un pedido');
      if (item.stock < item.quantity) fail(409, `Inventario insuficiente: ${item.sku}`);
      total += item.price_minor * item.quantity;
    }
    const settings = await one(tx,'SELECT * FROM shop_settings WHERE currency=$1',[currency]);
    if (input.delivery==='shipping' && (!settings.shipping_enabled || !input.shipping_address)) fail(400,'Envío no habilitado o falta dirección');
    if (input.delivery==='pickup' && !settings.pickup_enabled) fail(400,'La recolección no está habilitada');
    const shipping = input.delivery==='shipping' ? settings.shipping_minor : 0;
    const subtotal = total;
    total += shipping;
    money(total);
    const detail = { delivery: input.delivery, subtotal_minor:subtotal, shipping_minor: shipping, shipping_address:input.delivery==='shipping'?input.shipping_address:null,
      pickup_instructions:input.delivery==='pickup'?settings.pickup_instructions:null, terms:settings.terms,note: input.note || '',
      items: items.map(v => ({ variant_id: v.id, sku: v.sku, name: `${v.product_name} · ${v.name}`, quantity: v.quantity, unit_minor: v.price_minor })) };
    const checkout = await insertCheckout(tx,config,guestId,key,requestHash,'order',input.customer,total,total,currency,detail);
    for (const item of detail.items) {
      await tx.query('UPDATE variants SET stock=stock-$2 WHERE id=$1', [item.variant_id,item.quantity]);
      await tx.query('INSERT INTO order_items(checkout_id,variant_id,quantity,unit_minor,name,sku) VALUES($1,$2,$3,$4,$5,$6)',
        [checkout.id,item.variant_id,item.quantity,item.unit_minor,item.name,item.sku]);
      await tx.query('INSERT INTO stock_movements(id,variant_id,delta,reason,checkout_id) VALUES($1,$2,$3,$4,$5)',
        [id(),item.variant_id,-item.quantity,'checkout_hold',checkout.id]);
    }
    await tx.query('DELETE FROM cart_items WHERE guest_id=$1', [guestId]);
    return publicCheckout(checkout);
  });
}
export function publicCheckout(row) {
  const { guest_id, idempotency_key, request_hash, ...safe } = row;
  return { ...safe, balance_minor: row.total_minor-row.due_minor };
}
export async function cancelCheckout(db, config, checkoutId, guestId, actorId = null) {
  return db.transaction(async tx => {
    const row = await one(tx, 'SELECT * FROM checkouts WHERE id=$1 FOR UPDATE', [checkoutId]);
    if (!row || (guestId && row.guest_id !== guestId)) fail(404, 'Operación no encontrada');
    if (row.status === 'cancelled') return publicCheckout(row);
    if (row.status !== 'pending') fail(409, 'Solo se puede cancelar una operación pendiente; los pagos confirmados requieren revisión y devolución');
    await releaseCheckout(tx,row,'cancelled');
    await checkoutNotice(tx,row,'cancelada',config);
    await audit(tx,actorId,'checkout.cancel',row.id);
    return publicCheckout({ ...row,status: 'cancelled' });
  });
}
