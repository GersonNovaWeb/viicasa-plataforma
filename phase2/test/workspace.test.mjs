import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openPhase2Databases} from '../database.mjs';
import {seedPhase2,demoCredentials} from '../bootstrap.mjs';
import {buildPhase2App} from '../app.mjs';
import {secretVault,totp,sessionUser} from '../security.mjs';

test('persistent-shaped SQL demo: MFA, role isolation, CRM assignment, commissions, revocation and copied shop',async t=>{
  const databases=await openPhase2Databases('',{memory:true});t.after(()=>databases.close());
  const vault=secretVault(Buffer.alloc(32,4));await seedPhase2(databases);
  const app=await buildPhase2App(databases,vault,{testing:true});t.after(()=>app.close());
  const origin='http://127.0.0.1:3030';
  const call=(path,{method='GET',body,cookie,withOrigin=true,headers={}}={})=>app.inject({method,url:path.startsWith('/api/')?path:'/api/commercial'+path,headers:{...(cookie?{cookie}:{}),...(withOrigin?{origin}:{}),...headers},payload:body});
  const login=async credentials=>{
    const first=await call('/login',{method:'POST',body:credentials});assert.equal(first.statusCode,200,first.body);const challenge=first.json();assert.equal(challenge.setup,true);
    assert.equal((await call('/me')).statusCode,401);
    const verified=await call('/verify',{method:'POST',body:{challenge:challenge.challenge,code:totp(challenge.secret)}});assert.equal(verified.statusCode,200,verified.body);
    return{...verified.json(),cookie:verified.headers['set-cookie'].split(';')[0],secret:challenge.secret};
  };
  const admin=await login(demoCredentials.admin),seller=await login(demoCredentials.seller);
  await t.test('MFA secret not exposed to authenticated views; challenge replay and CSRF blocked',async()=>{
    assert.equal((await call('/me',{cookie:seller.cookie})).json().password_hash,undefined);
    assert.equal((await call('/users',{cookie:seller.cookie})).statusCode,403);
    assert.equal((await call('/leads',{method:'POST',withOrigin:false,cookie:seller.cookie,body:{}})).statusCode,403);
    const challenge=(await call('/login',{method:'POST',body:demoCredentials.seller})).json();
    assert.equal(challenge.secret,undefined);assert.equal(challenge.setup,false);
    const reused=await call('/verify',{method:'POST',body:{challenge:challenge.challenge,code:totp(seller.secret)}});assert.equal(reused.statusCode,401);
    // Backup is one use and retained only as a hash in the database.
    const recovered=await call('/verify',{method:'POST',body:{challenge:challenge.challenge,code:seller.recovery[0]}});assert.equal(recovered.statusCode,200);
    const second=(await call('/login',{method:'POST',body:demoCredentials.seller})).json();
    assert.equal((await call('/verify',{method:'POST',body:{challenge:second.challenge,code:seller.recovery[0]}})).statusCode,401);
  });
  const own=(await call('/leads',{cookie:seller.cookie})).json().items;
  assert.equal(own.length,3);
  const leadBody={name:'Private prospect',email:'private@example.invalid',phone:'',company:'',service:'home',stage:'new',priority:'normal',source:'Demo',notes:'Private'};
  const adminLead=(await call('/leads',{method:'POST',cookie:admin.cookie,body:leadBody})).json().id;
  await t.test('sellers cannot enumerate/update another owner or change commissions/global settings',async()=>{
    assert.equal((await call('/leads',{cookie:seller.cookie})).json().items.some(l=>l.id===adminLead),false);
    assert.equal((await call('/leads/'+adminLead,{method:'PUT',cookie:seller.cookie,body:leadBody})).statusCode,404);
    assert.equal((await call('/leads/'+adminLead+'/activities',{cookie:seller.cookie})).statusCode,404);
    assert.equal((await call('/rules/home',{method:'PUT',cookie:seller.cookie,body:{basis_points:10000,approved:true}})).statusCode,403);
    assert.equal((await call('/api/admin/products',{cookie:seller.cookie})).statusCode,403);
  });
  await t.test('admin assignment, activity and task are visible only to the assigned seller',async()=>{
    const assigned=await call('/leads/'+adminLead+'/assign',{method:'POST',cookie:admin.cookie,body:{owner_id:seller.user.id}});assert.equal(assigned.statusCode,200,assigned.body);
    assert.equal((await call('/leads',{cookie:seller.cookie})).json().items.length,4);
    const task=await call('/leads/'+adminLead+'/activities',{method:'POST',cookie:seller.cookie,body:{kind:'task',body:'Call prospect',due_at:'2026-11-01T12:00:00Z'}});assert.equal(task.statusCode,200,task.body);
    assert.equal((await call('/tasks',{cookie:seller.cookie})).json().items.length,1);
    assert.equal((await call('/activities/'+task.json().id+'/complete',{method:'POST',cookie:seller.cookie,body:{done:true}})).statusCode,200);
  });
  await t.test('commission calculated in cents; only admin can approve/pay after approved rule and paid sale',async()=>{
    const created=await call('/sales',{method:'POST',cookie:seller.cookie,body:{lead_id:adminLead,reference:'DEMO-'+randomUUID(),amount_minor:9999,status:'pending'}});assert.equal(created.statusCode,200,created.body);assert.equal(created.json().commission_minor,500);const id=created.json().id;
    assert.equal((await call('/sales/'+id+'/commission',{method:'POST',cookie:seller.cookie,body:{status:'approved'}})).statusCode,403);
    assert.equal((await call('/sales/'+id+'/commission',{method:'POST',cookie:admin.cookie,body:{status:'approved'}})).statusCode,409);
    await call('/sales/'+id+'/status',{method:'POST',cookie:admin.cookie,body:{status:'paid'}});
    assert.equal((await call('/sales/'+id+'/commission',{method:'POST',cookie:admin.cookie,body:{status:'approved'}})).statusCode,409);
    await call('/rules/home',{method:'PUT',cookie:admin.cookie,body:{basis_points:500,approved:true}});
    assert.equal((await call('/sales/'+id+'/commission',{method:'POST',cookie:admin.cookie,body:{status:'approved'}})).statusCode,200);
    assert.equal((await call('/sales/'+id+'/commission',{method:'POST',cookie:admin.cookie,body:{status:'paid'}})).statusCode,200);
    assert.equal((await call('/sales/'+id+'/commission',{method:'POST',cookie:admin.cookie,body:{status:'cancelled'}})).statusCode,409);
  });
  await t.test('shop samples persist, platform admin requires MFA; external events are explicitly local',async()=>{
    const products=await call('/api/products?limit=100');assert.equal(products.statusCode,200,products.body);assert.equal(products.json().items.length,4);
    assert.equal((await call('/api/admin/products',{cookie:admin.cookie})).statusCode,200);
    assert.equal((await call('/integrations',{cookie:seller.cookie})).statusCode,403);
    const event=await call('/integrations/shopify/simulate',{method:'POST',cookie:admin.cookie,body:{event:'order'}});assert.equal(event.statusCode,200);assert.equal(event.json().mode,'demo');
    await seedPhase2(databases);assert.equal((await call('/api/products?limit=100')).json().items.length,4);
    assert.equal((await databases.commercial.query('SELECT count(*)::integer AS n FROM commercial_sales')).rows[0].n,1);
  });
  await t.test('copied ViiShop purchases complete in demo and queue separate buyer/admin notices',async()=>{
    const response=await call('/api/products?limit=100'),guestCookie=response.headers['set-cookie'].split(';')[0];
    const product=(await call('/api/products/'+response.json().items[0].slug,{cookie:guestCookie})).json();
    const variant=product.variants[0];
    const cart=await call('/api/cart/items/'+variant.id,{method:'PUT',cookie:guestCookie,body:{quantity:2}});assert.equal(cart.statusCode,200,cart.body);
    const created=await call('/api/orders',{method:'POST',cookie:guestCookie,headers:{'idempotency-key':randomUUID()},body:{customer:{name:'Phase 2 Buyer',email:'buyer@example.invalid',phone:'+12505550123',consent:true},currency:'CAD',delivery:'pickup'}});assert.equal(created.statusCode,201,created.body);
    const checkout=created.json();assert.equal(checkout.total_minor,variant.prices.CAD*2);
    const payment=await call('/api/checkouts/'+checkout.id+'/payment',{method:'POST',cookie:guestCookie});assert.equal(payment.statusCode,200,payment.body);
    const confirm=await call('/api/admin/payments/'+checkout.id+'/simulate',{method:'POST',cookie:admin.cookie,body:{event_id:randomUUID(),outcome:'paid'}});assert.equal(confirm.statusCode,200,confirm.body);
    assert.equal((await call('/api/checkouts/'+checkout.id,{cookie:guestCookie})).json().status,'confirmed');
    const outbox=await databases.store.list('mail_outbox');
    const mail=outbox.find(m=>m.recipient==='buyer@example.invalid');assert.ok(mail);assert.equal(mail.receipt,undefined);assert.match(mail.body,/demonstration/i);
    assert.ok(outbox.some(m=>m.recipient==='team@example.invalid'));
    assert.equal((await databases.store.get('variants',variant.id)).stock,18);
  });
  await t.test('disabling a seller revokes all their sessions without losing sales',async()=>{
    const u=(await call('/users',{cookie:admin.cookie})).json().items.find(u=>u.id===seller.user.id);
    const result=await call('/users/'+u.id,{method:'PUT',cookie:admin.cookie,body:{name:u.name,email:u.email,phone:u.phone,role:u.role,goal_minor:u.goal_minor,active:false}});assert.equal(result.statusCode,200,result.body);
    assert.equal((await call('/me',{cookie:seller.cookie})).statusCode,401);
    assert.equal(await sessionUser(databases.commercial,seller.cookie.split('=')[1]),null);
    assert.equal((await databases.commercial.query('SELECT count(*)::integer AS n FROM commercial_sales')).rows[0].n,1);
  });
});
