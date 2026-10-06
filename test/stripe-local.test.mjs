import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripeLocalConfig} from '../viicasa-frontend-prototype/stripe-local-config.mjs';

// Fabricated values. Never load the user's secret file or call payment APIs.
const fixture={STRIPE_SECRET_KEY:'sk_test_'+'a'.repeat(24),STRIPE_WEBHOOK_SECRET:'whsec_'+'b'.repeat(32)};
test('local Stripe settings force sandbox and local Firestore despite extra deployment values',()=>{
  const config=stripeLocalConfig({...fixture,PLATFORM_MODE:'live',NODE_ENV:'production',FIREBASE_MODE:'live',FIREBASE_PROJECT_ID:'viicasa',SITE_URL:'https://example.com',PORT:'80',MAIL_MODE:'smtp',FIREBASE_SERVICE_ACCOUNT_JSON:'not-a-credential'});
  assert.equal(config.PLATFORM_MODE,'demo');assert.equal(config.NODE_ENV,'development');
  assert.equal(config.PAYMENT_PROVIDER,'stripe');assert.equal(config.FIREBASE_MODE,'emulator');
  assert.equal(config.FIREBASE_PROJECT_ID,'demo-viicasa-platform');
  assert.equal(config.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8088');
  assert.equal(config.SITE_URL,'http://127.0.0.1:3015');assert.equal(config.PORT,'3015');
  assert.equal(config.MAIL_MODE,'outbox');assert.equal(config.FIREBASE_SERVICE_ACCOUNT_JSON,undefined);
});
test('rejects missing, public, live and malformed secret keys without exposing their value',()=>{
  for(const value of [undefined,'','pk_test_'+'a'.repeat(24),'sk_live_'+'a'.repeat(24),'sk_test_TU_CLAVE','sk_test_'+('a'.repeat(24))+'\nsecret']){
    assert.throws(()=>stripeLocalConfig({...fixture,STRIPE_SECRET_KEY:value}),error=>{
      assert.match(error.message,/STRIPE_SECRET_KEY/);
      if(value)assert.ok(!error.message.includes(value));return true;
    });
  }
});
test('rejects missing or malformed webhook secrets',()=>{
  for(const value of [undefined,'','whsec_TU_SECRETO','whsec_resto de la clave',fixture.STRIPE_SECRET_KEY]){
    assert.throws(()=>stripeLocalConfig({...fixture,STRIPE_WEBHOOK_SECRET:value}),/STRIPE_WEBHOOK_SECRET/);
  }
});
test('accepts two syntactically valid test values',()=>{
  const config=stripeLocalConfig(fixture);
  assert.equal(config.STRIPE_SECRET_KEY,fixture.STRIPE_SECRET_KEY);
  assert.equal(config.STRIPE_WEBHOOK_SECRET,fixture.STRIPE_WEBHOOK_SECRET);
});
test('ordinary npm run dev remains independent of Stripe keys',async()=>{
  const source=await readFile(new URL('../viicasa-frontend-prototype/dev-local.mjs',import.meta.url),'utf8');
  assert.match(source,/PAYMENT_PROVIDER='demo'/);assert.doesNotMatch(source,/readFile|parseEnv|loadEnvFile/);
});
