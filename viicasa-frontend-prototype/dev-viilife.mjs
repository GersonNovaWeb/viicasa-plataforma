import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
// Read only SMTP fields. Never import live Firebase, Stripe or general MAIL_MODE.
const allowed=['SMTP_HOST','SMTP_PORT','SMTP_SECURE','SMTP_USER','SMTP_PASSWORD','MAIL_FROM','VIILIFE_DEMO_MAIL_MODE'];
for(const name of ['.env','.env.viilife-demo.local']){
  try{const values=parseEnv(await readFile(new URL('../'+name,import.meta.url),'utf8'));for(const field of allowed)if(values[field]!==undefined)process.env[field]=values[field];}
  catch(error){if(error.code!=='ENOENT')throw Error('Unable to read local ViiLife mail configuration');}
}
process.env.VIILIFE_MODE='demo';
console.log('ViiLife demo: no charges; any outgoing demo mail is restricted to gerson@novaweb-agency.com.');
await import('./dev-local.mjs');
