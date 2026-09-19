import Stripe from 'stripe';
import { one } from './db.js';
import { id, fail, audit } from './lib.js';
import { releaseCheckout } from './commerce.js';
import { checkoutNotice } from './notifications.js';

export function paymentGateway(config) {
  if (config.paymentProvider === 'stripe') {
    const stripe = new Stripe(config.stripeKey, { maxNetworkRetries: 2, timeout: 15000 });
    return {
      provider: 'stripe',
      async create(payment, checkout) {
        const session = await stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card'],
          client_reference_id: checkout.id, customer_email: checkout.customer_email,
          metadata: { checkout_id: checkout.id, payment_id: payment.id },
          line_items: [{ quantity: 1, price_data: { currency: payment.currency.toLowerCase(), unit_amount: payment.amount_minor,
            product_data: { name: `VIICASA · ${checkout.kind === 'booking' ? 'Reservación' : 'Pedido'} ${checkout.id}` } } }],
          success_url: `${config.siteUrl.replace(/\/$/, '')}/pago/resultado?checkout=${checkout.id}`,
          cancel_url: `${config.siteUrl.replace(/\/$/, '')}/pago/cancelado?checkout=${checkout.id}`,
          expires_at: Math.floor(new Date(payment.expires_at).valueOf()/1000),
        }, { idempotencyKey: `viicasa-${payment.id}` });
        return { reference: session.id, url: session.url };
      },
      verify(raw, signature) {
        try { return stripe.webhooks.constructEvent(raw, signature, config.stripeWebhookSecret); }
        catch { fail(400, 'Firma de webhook inválida'); }
      },
    };
  }
  return { provider: config.paymentProvider, async create(payment) {
    if (config.production || config.paymentProvider !== 'demo') fail(503, 'La pasarela de pagos aún no está configurada');
    return { reference: `demo_${payment.id}`, url: null };
  } };
}

export async function startPayment(db, config, gateway, guestId, checkoutId) {
  if (config.paymentProvider === 'disabled') fail(503, 'La pasarela de pagos aún no está configurada');
  const { payment, checkout } = await db.transaction(async tx => {
    const checkout = await one(tx,'SELECT * FROM checkouts WHERE id=$1 FOR UPDATE',[checkoutId]);
    if (!checkout || checkout.guest_id !== guestId) fail(404,'Operación no encontrada');
    if(checkout.kind==='booking')await tx.query(`SELECT p.id FROM properties p JOIN bookings b ON b.property_id=p.id
      WHERE b.checkout_id=$1 FOR UPDATE OF p`,[checkoutId]);
    if (checkout.status !== 'pending' || new Date(checkout.expires_at) <= new Date()) fail(409,'La operación ya no admite pagos');
    let payment = await one(tx,'SELECT * FROM payments WHERE checkout_id=$1',[checkoutId]);
    if (payment) {
      if (payment.provider !== config.paymentProvider) fail(409,'Esta operación pertenece a otra pasarela');
      if (new Date(payment.expires_at) <= new Date()) fail(409,'El intento de pago venció; crea una nueva operación');
      if (payment.status === 'failed' && payment.provider === 'demo') {
        payment = await one(tx,"UPDATE payments SET status='open' WHERE id=$1 RETURNING *",[payment.id]);
      }
      return { payment, checkout };
    }
    // Stripe only permits session expirations at least 30 minutes in the future.
    const paymentExpiry = gateway.provider === 'stripe' ? new Date(Date.now()+35*60000) : new Date(checkout.expires_at);
    const holdExpiry = gateway.provider === 'stripe' ? new Date(paymentExpiry.valueOf()+2*60000) : paymentExpiry;
    await tx.query('UPDATE checkouts SET expires_at=$2 WHERE id=$1',[checkoutId,holdExpiry]);
    payment = await one(tx,`INSERT INTO payments(id,checkout_id,provider,status,amount_minor,currency,expires_at)
      VALUES($1,$2,$3,'creating',$4,$5,$6) RETURNING *`,[id(),checkoutId,gateway.provider,checkout.due_minor,checkout.currency,paymentExpiry]);
    return { payment, checkout };
  });
  if (payment.reference) return publicPayment(payment);
  let session;
  try { session = await gateway.create(payment,checkout); }
  catch (error) {
    if (error.statusCode) throw error;
    // Keep the same persisted idempotency key for retries after ambiguous provider timeouts.
    fail(502,'No se pudo iniciar el pago; reintenta sobre esta misma operación');
  }
  const saved = await one(db,`UPDATE payments SET reference=$2,checkout_url=$3,
    status=CASE WHEN status='creating' THEN 'open' ELSE status END WHERE id=$1 RETURNING *`,[payment.id,session.reference,session.url]);
  return publicPayment(saved);
}
export function publicPayment(row) {
  return { id: row.id, checkout_id: row.checkout_id, provider: row.provider, status: row.status,
    amount_minor: row.amount_minor, currency: row.currency, checkout_url: row.checkout_url, expires_at: row.expires_at };
}

export async function settlePayment(db, config, event) {
  return db.transaction(async tx => {
    const initial = await one(tx,'SELECT * FROM payments WHERE reference=$1 AND provider=$2',[event.reference,event.provider]);
    if (!initial) fail(503,'Pago aún no identificado; reintentar webhook');
    // All payment mutations acquire checkout first, then payment.
    const checkout = await one(tx,'SELECT * FROM checkouts WHERE id=$1 FOR UPDATE',[initial.checkout_id]);
    // Coordinate confirmation/hold extension with new bookings, including expiry-boundary races.
    if(checkout.kind==='booking')await tx.query(`SELECT p.id FROM properties p JOIN bookings b ON b.property_id=p.id
      WHERE b.checkout_id=$1 FOR UPDATE OF p`,[checkout.id]);
    const payment = await one(tx,'SELECT * FROM payments WHERE id=$1 FOR UPDATE',[initial.id]);
    const duplicate = await one(tx,'SELECT * FROM payment_events WHERE provider=$1 AND event_id=$2',[event.provider,event.id]);
    if (duplicate) {
      if (duplicate.payment_id !== payment.id || duplicate.outcome !== event.outcome) fail(409,'Evento de pago inconsistente');
      return { received: true, duplicate: true };
    }
    if (event.amount !== payment.amount_minor || event.currency.toUpperCase() !== payment.currency) fail(409,'El importe o la moneda no coinciden con el pago');
    if (!['paid','failed','expired'].includes(event.outcome)) fail(400,'Estado de pago inválido');
    await tx.query('INSERT INTO payment_events(provider,event_id,payment_id,outcome) VALUES($1,$2,$3,$4)',[event.provider,event.id,payment.id,event.outcome]);
    if (payment.status === 'paid') return { received: true, ignored: true };
    if (event.outcome === 'paid') {
      await tx.query("UPDATE payments SET status='paid' WHERE id=$1",[payment.id]);
      if (checkout.status === 'pending' && new Date(checkout.expires_at)>new Date()) {
        await tx.query("UPDATE checkouts SET status='confirmed' WHERE id=$1",[checkout.id]);
        await checkoutNotice(tx,checkout,'confirmado',config);
      } else {
        // Never confirm a late payment after its inventory/dates may have been released.
        await releaseCheckout(tx,checkout,'expired');
        await tx.query("UPDATE checkouts SET status='payment_review' WHERE id=$1",[checkout.id]);
        await checkoutNotice(tx,checkout,'pago recibido en revisión',config);
      }
    } else if (event.outcome === 'expired') {
      await tx.query("UPDATE payments SET status='expired' WHERE id=$1",[payment.id]);
      await releaseCheckout(tx,checkout,'expired');
      await checkoutNotice(tx,checkout,'pago vencido',config);
    } else {
      await tx.query("UPDATE payments SET status='failed' WHERE id=$1",[payment.id]);
      await checkoutNotice(tx,checkout,'pago rechazado',config);
    }
    await audit(tx,null,`payment.${event.outcome}`,payment.id,{ provider: event.provider, event_id: event.id });
    return { received: true };
  });
}

export async function stripeWebhook(db, config, gateway, raw, signature) {
  const event = gateway.verify(raw,signature);
  const session = event.data.object;
  const types = { 'checkout.session.completed': 'paid', 'checkout.session.async_payment_succeeded': 'paid',
    'checkout.session.expired': 'expired', 'checkout.session.async_payment_failed': 'failed' };
  const outcome = types[event.type];
  if (!outcome || (outcome === 'paid' && session.payment_status !== 'paid')) return { received: true, ignored: true };
  return settlePayment(db,config,{ provider: 'stripe', id: event.id, reference: session.id, outcome,
    amount: session.amount_total, currency: session.currency || '' });
}
