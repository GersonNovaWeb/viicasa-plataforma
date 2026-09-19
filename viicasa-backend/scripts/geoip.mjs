import {prepareGeolocation,geolocationSettings,locationPreference} from '../src/geolocation.js';
// Offline lookups after this preparation; no visitor address is sent to a service.
if(process.argv.includes('--update')){
  process.env.ILA_SKIP_INITIAL_RELOAD='true';
  const {updateDb}=await import('ip-location-api');
  await updateDb(geolocationSettings);
}
await prepareGeolocation();
const check=locationPreference({socket:{remoteAddress:'8.8.8.8'},headers:{}});
if(!check.geoAvailable)throw Error('Country database is not ready');
console.log('Country database ready. Local country lookup enabled; no FX conversion.');
