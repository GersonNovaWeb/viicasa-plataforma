import {test} from 'node:test';
import assert from 'node:assert/strict';
import {memoryStore} from './helpers/memory-store.mjs';
import {attachGuestPurchases} from '../viicasa-backend/src/customer-registration.js';
import {hash,token} from '../viicasa-backend/src/lib.js';
import {key,afterMinutes} from '../viicasa-backend/src/firestore-store.js';
test('optional verified account claims only matching purchases from the owned anonymous session',async()=>{
  const store=memoryStore(),secret=token(),user={uid:'verified',email:'buyer@example.invalid',email_verified:true};
  await store.set('guests','anonymous',{expires_at:afterMinutes(30)});await store.set('guest_tokens',hash(secret),{guest_id:'anonymous'});await store.set('guests','registered',{firebase_uid:user.uid});await store.set('platform_accounts',key('google',user.uid),{guest_id:'registered'});
  for(const[id,guest_id,email]of [['matching','anonymous',user.email],['other-email','anonymous','other@example.invalid'],['other-session','other',user.email]])await store.set('checkouts',id,{guest_id,customer_email:email});
  assert.equal((await attachGuestPurchases(store,user,token())).attached,0);assert.equal((await attachGuestPurchases(store,{...user,email_verified:false},secret)).attached,0);
  assert.equal((await attachGuestPurchases(store,user,secret)).attached,1);assert.equal((await store.get('checkouts','matching')).guest_id,'registered');assert.equal((await store.get('checkouts','other-email')).guest_id,'anonymous');assert.equal((await store.get('checkouts','other-session')).guest_id,'other');assert.equal((await attachGuestPurchases(store,user,secret)).attached,0);
});
