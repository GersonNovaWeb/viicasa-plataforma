import { resolve } from 'node:path';

export function configFromEnv(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const integer = (key, fallback, min, max) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Configuración inválida: ${key}`);
    return value;
  };
  const config = {
    production, host: env.HOST || '127.0.0.1', port: integer('PORT', 3001, 1, 65535),
    driver: env.DATABASE_DRIVER || 'firestore',
    firebaseMode: env.FIREBASE_MODE || 'emulator',
    firebaseProjectId: env.FIREBASE_PROJECT_ID || (env.FIREBASE_MODE==='live'?'viicasa':'demo-viicasa'),
    firestoreEmulatorHost: env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080',
    firebaseStorageBucket: env.FIREBASE_STORAGE_BUCKET || 'viicasa.firebasestorage.app',
    databaseUrl: env.DATABASE_URL, databaseSsl: env.DATABASE_SSL === 'true',
    dataDir: resolve(env.DATA_DIR || './data/postgres'), mediaDir: resolve(env.MEDIA_DIR || './data/media'),
    siteUrl: env.PUBLIC_SITE_URL || 'http://localhost:3000',
    origins: (env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map(x => x.trim()),
    adminEmail: env.ADMIN_EMAIL || 'admin@example.com',
    paymentProvider: env.PAYMENT_PROVIDER || (production ? 'disabled' : 'demo'),
    stripeKey: env.STRIPE_SECRET_KEY, stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
    holdMinutes: integer('HOLD_MINUTES', 30, 5, 120), sessionHours: integer('SESSION_HOURS', 8, 1, 24),
    mailMode: env.MAIL_MODE || 'outbox', mailFrom: env.MAIL_FROM || 'VIICASA <no-reply@example.com>',
    smtp: { host: env.SMTP_HOST, port: integer('SMTP_PORT', 587, 1, 65535), secure: env.SMTP_SECURE === 'true',
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined },
    trustProxy: env.TRUST_PROXY === 'true' ? 1 : false,
  };
  if (!['pglite', 'postgres','firestore'].includes(config.driver)) throw new Error('DATABASE_DRIVER inválido');
  if(config.driver==='firestore') {
    if(!['emulator','live'].includes(config.firebaseMode))throw new Error('FIREBASE_MODE inválido');
    if(config.firebaseMode==='emulator' && (!config.firebaseProjectId.startsWith('demo-') || !/^(127\.0\.0\.1|localhost):\d+$/.test(config.firestoreEmulatorHost)))throw new Error('Emulador requiere proyecto demo- y dirección local');
    if(config.firebaseMode==='live' && (env.FIRESTORE_EMULATOR_HOST || config.firebaseProjectId.startsWith('demo-')))throw new Error('No mezclar proyecto real y emulador');
  }
  if (!['disabled', 'demo', 'stripe'].includes(config.paymentProvider)) throw new Error('PAYMENT_PROVIDER inválido');
  if (!['outbox', 'smtp'].includes(config.mailMode)) throw new Error('MAIL_MODE inválido');
  if (config.driver === 'postgres' && !config.databaseUrl) throw new Error('Falta DATABASE_URL');
  if (config.paymentProvider === 'stripe' && (!config.stripeKey || !config.stripeWebhookSecret)) throw new Error('Faltan credenciales de Stripe');
  if (config.mailMode === 'smtp' && !config.smtp.host) throw new Error('Falta SMTP_HOST');
  for (const value of [config.siteUrl, ...config.origins]) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (production && url.protocol !== 'https:')) throw new Error('URL de sitio/origen inválida');
  }
  if (production && (config.driver === 'pglite' || config.paymentProvider === 'demo' || (config.driver==='firestore' && config.firebaseMode!=='live'))) throw new Error('Producción requiere base remota y prohíbe emuladores/pagos demo');
  return config;
}
