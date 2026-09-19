// Explicit isolated mode. Never loads .env or the user's Stripe credentials.
process.env.PLATFORM_MODE='demo';
process.env.NODE_ENV='development';
process.env.PAYMENT_PROVIDER='demo';
process.env.SITE_URL='http://127.0.0.1:3015';
process.env.PORT='3015';
await import('./server.mjs');
