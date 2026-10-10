// Explicit isolated mode. Never loads .env or the user's Stripe credentials.
process.env.PLATFORM_MODE='demo';
process.env.NODE_ENV='development';
process.env.PAYMENT_PROVIDER='demo';
const port=Number(process.env.PORT||3015);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid local PORT');
process.env.SITE_URL=`http://127.0.0.1:${port}`;
process.env.PORT=String(port);
await import('./server.mjs');
