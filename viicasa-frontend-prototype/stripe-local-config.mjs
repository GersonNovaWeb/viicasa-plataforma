// Only these two values may come from the private local file.
// Never inherit deployment settings, a live key or a remote Firestore project.
export function stripeLocalConfig(values){
  const secret=values.STRIPE_SECRET_KEY?.trim();
  const webhook=values.STRIPE_WEBHOOK_SECRET?.trim();
  if(!/^sk_test_[A-Za-z0-9]{16,}$/.test(secret||''))throw new Error('Completa STRIPE_SECRET_KEY con una clave sk_test_ del sandbox en .env.stripe.local. No se permiten claves de producción.');
  if(!/^whsec_[A-Za-z0-9]{16,}$/.test(webhook||''))throw new Error('Completa STRIPE_WEBHOOK_SECRET con el secreto whsec_ de stripe listen en .env.stripe.local.');
  return {
    PLATFORM_MODE:'demo',NODE_ENV:'development',PAYMENT_PROVIDER:'stripe',
    SITE_URL:'http://127.0.0.1:3015',PORT:'3015',HOST:'127.0.0.1',
    DATABASE_DRIVER:'firestore',FIREBASE_MODE:'emulator',
    FIREBASE_PROJECT_ID:'demo-viicasa-platform',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8088',
    MAIL_MODE:'outbox',STRIPE_SECRET_KEY:secret,STRIPE_WEBHOOK_SECRET:webhook,
  };
}
