import {totp} from './security.mjs';

// Local helper for the enrollment screen. Takes the displayed demo secret; does
// not read the users table, run a server, or bypass the real verification route.
if(process.env.NODE_ENV==='production')throw Error('Demo helper is local only.');
const secret=process.argv[2];
if(!secret||!/^[A-Z2-7]{32}$/.test(secret)){
  console.log('Usage: npm run demo:totp -- SECRET_FROM_THE_DEMO_ENROLLMENT_SCREEN');
  process.exitCode=1;
}else console.log('Current demo TOTP code: '+totp(secret));
