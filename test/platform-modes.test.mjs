import {test} from 'node:test';
import assert from 'node:assert/strict';
import {platformModes} from '../viicasa-frontend-prototype/platform-modes.mjs';
import {configFromEnv} from '../viicasa-backend/src/config.js';

test('hosted platform defaults to real customer flow, never the demo recipient',()=>{
  assert.deepEqual(platformModes({NODE_ENV:'production'}),{demo:false,viilifeMode:'live'});
  assert.deepEqual(platformModes({PLATFORM_MODE:'live'}),{demo:false,viilifeMode:'live'});
  assert.throws(()=>platformModes({PLATFORM_MODE:'live',VIILIFE_MODE:'demo'}),/VIILIFE_MODE=live/);
});
test('explicit local demos and isolated Stripe tests remain possible',()=>{
  assert.deepEqual(platformModes({PLATFORM_MODE:'demo'}),{demo:true,viilifeMode:'demo'});
  assert.deepEqual(platformModes({PLATFORM_MODE:'demo',VIILIFE_MODE:'live'}),{demo:true,viilifeMode:'live'});
  assert.throws(()=>platformModes({PLATFORM_MODE:'typo'}),/Invalid/);
});
test('Stripe defaults to test-only and rejects live keys without explicit live opt-in',()=>{
  const env={DATABASE_DRIVER:'firestore',FIREBASE_MODE:'live',PAYMENT_PROVIDER:'stripe',STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',VIILIFE_MODE:'live'};
  assert.equal(configFromEnv(env).stripeMode,'test');
  assert.throws(()=>configFromEnv({...env,STRIPE_SECRET_KEY:'sk_live_fixture'}),/STRIPE_MODE/);
  assert.throws(()=>configFromEnv({...env,STRIPE_MODE:'live'}),/STRIPE_MODE/);
  assert.equal(configFromEnv({...env,STRIPE_MODE:'live',STRIPE_SECRET_KEY:'sk_live_fixture'}).stripeMode,'live');
});
