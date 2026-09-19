import { randomBytes, randomUUID, createHash, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCb);
export const id = () => randomUUID();
export const token = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export function fail(statusCode, message) { throw Object.assign(new Error(message), { statusCode }); }
export async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt}$${key.toString('hex')}`;
}
export async function passwordMatches(password, encoded) {
  const [, salt, value] = encoded.split('$');
  const expected = Buffer.from(value, 'hex');
  const actual = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export const bearer = request => {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization || '');
  if (!match) fail(401, 'Se requiere un token Bearer válido');
  return hash(match[1]);
};
export async function audit(tx, actorId, action, resourceId, detail = {}) {
  await tx.query('INSERT INTO audit_log(id,actor_id,action,resource_id,detail) VALUES($1,$2,$3,$4,$5)', [id(), actorId, action, resourceId, JSON.stringify(detail)]);
}
export function dateRange(checkIn, checkOut, timeZone = 'America/Mexico_City') {
  for (const text of [checkIn, checkOut]) {
    const d = new Date(`${text}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(d.valueOf()) || d.toISOString().slice(0, 10) !== text) fail(400, 'Fecha inválida');
  }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const nights = (Date.parse(checkOut) - Date.parse(checkIn)) / 86400000;
  if (checkIn < today || nights < 1 || nights > 90 || Date.parse(checkIn) > Date.now() + 730 * 86400000) fail(400, 'Estancia inválida: de 1 a 90 noches, hasta dos años de anticipación');
  return nights;
}
export function money(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 99999999) fail(400, 'Importe fuera de rango');
  return value;
}
