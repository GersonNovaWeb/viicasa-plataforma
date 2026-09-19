import {isIP} from 'node:net';
import {fileURLToPath} from 'node:url';

export const currencyForCountry = country => country === 'CA' ? 'CAD' : 'USD';
export const normalizeIp = ip => String(ip||'').replace(/^::ffff:/i,'');
// Trust only explicitly configured proxy addresses, walking XFF right-to-left.
export function clientIp(request, trusted = []) {
  let ip=normalizeIp(request.socket.remoteAddress);
  const hops=String(request.headers['x-forwarded-for']||'').split(',').map(x=>normalizeIp(x.trim()));
  while(trusted.includes(ip)&&hops.length){const next=hops.pop();if(!isIP(next))break;ip=next;}
  return isIP(ip)?ip:null;
}
export const geolocationSettings={fields:'country',ipLocationDb:'user',autoUpdate:false,silent:true,
  dataDir:fileURLToPath(new URL('../data/geoip',import.meta.url)),
  tmpDataDir:fileURLToPath(new URL('../data/geoip-download',import.meta.url))};
let lookup, pending;
export function prepareGeolocation() {
  return pending ??= (async()=>{
    process.env.ILA_SKIP_INITIAL_RELOAD='true';
    const geo=await import('ip-location-api');
    await geo.reload(geolocationSettings);
    lookup=geo.lookup;
  })();
}
export function locationPreference(request, trusted = []) {
  const ip=clientIp(request,trusted);
  let country=null;
  try{country=ip&&lookup?.(ip)?.country||null;}catch{/* Country is a suggestion, never an authorization decision. */}
  return {country,suggestedCurrency:currencyForCountry(country),geoAvailable:!!lookup};
}
