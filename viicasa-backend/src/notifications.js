import nodemailer from 'nodemailer';
import { id } from './lib.js';

export async function enqueue(tx, key, recipient, subject, body) {
  await tx.query(`INSERT INTO mail_outbox(id,dedupe_key,recipient,subject,body) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(dedupe_key) DO NOTHING`, [id(),key,recipient,subject,body]);
}
export async function checkoutNotice(tx, checkout, status, config) {
  const label = checkout.kind === 'booking' ? 'Reservación' : 'Pedido';
  const subject = `VIICASA · ${label} ${status}`;
  const body = `${label}: ${checkout.id}\nEstado: ${status}\nCliente: ${checkout.customer_name}\nTotal: ${(checkout.total_minor / 100).toFixed(2)} ${checkout.currency}\nImporte de este pago: ${(checkout.due_minor / 100).toFixed(2)} ${checkout.currency}\nDetalle: ${JSON.stringify(checkout.detail, null, 2)}`;
  await enqueue(tx, `${checkout.id}:${status}:customer`, checkout.customer_email, subject, body);
  await enqueue(tx, `${checkout.id}:${status}:admin`, config.adminEmail, subject, body);
}
export async function deliverMail(db, config, transport) {
  if (config.mailMode !== 'smtp') return { mode: 'outbox', sent: 0 };
  const mailer = transport || nodemailer.createTransport({ ...config.smtp, connectionTimeout: 10000, socketTimeout: 30000 });
  let sent = 0, failed = 0;
  for (let i = 0; i < 50; i++) {
    const message = await db.transaction(async tx => {
      const result = await tx.query(`SELECT * FROM mail_outbox WHERE sent_at IS NULL AND attempts<10 AND next_attempt<=now()
        AND (locked_until IS NULL OR locked_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`);
      const row = result.rows[0];
      if (row) await tx.query(`UPDATE mail_outbox SET locked_until=now()+interval '2 minutes', attempts=attempts+1 WHERE id=$1`, [row.id]);
      return row;
    });
    if (!message) break;
    try {
      await mailer.sendMail({ from: config.mailFrom, to: message.recipient, subject: message.subject, text: message.body,
        messageId: `<${message.id}@viicasa.mail>` });
      await db.query('UPDATE mail_outbox SET sent_at=now(),locked_until=NULL,last_error=NULL WHERE id=$1', [message.id]);
      sent++;
    } catch {
      // SMTP credentials and server responses must not leak through the administrative API.
      await db.query(`UPDATE mail_outbox SET locked_until=NULL,last_error='SMTP delivery failed',
        next_attempt=now()+($2*interval '1 minute') WHERE id=$1`, [message.id, Math.min(60, 2 ** message.attempts)]);
      failed++;
    }
  }
  if (!transport && mailer.close) mailer.close();
  return { mode: 'smtp', sent, failed };
}
