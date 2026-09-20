import {test} from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {demoProperties,demoCatalogId} from '../src/demo-properties.js';
import {buildApp} from '../src/app.js';
import {configFromEnv} from '../src/config.js';
import {key,afterMinutes} from '../src/firestore-store.js';
import {saveCatalog} from '../src/firestore-catalog.js';
import {createBooking} from '../src/firestore-commerce.js';
import {hash,token} from '../src/lib.js';

test('four versioned demo properties include bilingual content and bundled images',async()=>{
  const rows=demoProperties();assert.equal(rows.length,4);
  assert.deepEqual(rows.map(p=>p.rates.USD.nightly_minor),[39000,28000,21000,53000]);
  assert.deepEqual(rows.map(p=>p.rates.CAD.nightly_minor),[54000,38000,29000,73000]);
  for(const row of rows){
    assert.equal(row.is_demo,true);assert.equal(row.published,true);
    assert.match(row.name,/Demo/);assert.match(row.description,/\n\[EN\]\n/);
    assert.equal(row.images.length,3);
    for(const image of row.images)await access(new URL('../../viicasa-frontend-prototype'+image,import.meta.url));
  }
  rows[0].name='Changed';assert.notEqual(demoProperties()[0].name,'Changed');
});

test('demo installation through the API in an isolated Firestore emulator',{skip:!process.env.TEST_FIRESTORE_HOST},async t=>{
  const config=configFromEnv({DATABASE_DRIVER:'firestore',FIREBASE_MODE:'emulator',FIREBASE_PROJECT_ID:'demo-catalog-'+randomUUID().slice(0,8),FIRESTORE_EMULATOR_HOST:process.env.TEST_FIRESTORE_HOST,PAYMENT_PROVIDER:'demo'});
  const app=await buildApp(config,{logger:false,testing:true}),store=app.store;
  t.after(()=>app.close());
  const secrets={};
  for(const role of ['admin','catalog','support','viewer']){
    const uid=randomUUID(),secret=token();secrets[role]=secret;
    await store.set('users',uid,{email:role+'@example.invalid',role,name:role,active:true,auth_version:1});
    await store.set('sessions',hash(secret),{user_id:uid,auth_version:1,expires_at:afterMinutes(5)});
  }
  const install=(secret,body={confirm:true},api=app)=>api.inject({method:'POST',url:'/v1/admin/demo-properties',headers:secret?{authorization:'Bearer '+secret}:{},payload:body});
  const expect=(response,status)=>{assert.equal(response.statusCode,status,response.body);return response.json();};
  await t.test('only admin can explicitly confirm installation',async()=>{
    expect(await install(),401);
    for(const role of ['catalog','support','viewer'])expect(await install(secrets[role]),403);
    expect(await install(secrets.admin,{confirm:false}),400);
    expect(await install(secrets.admin,{confirm:true,is_demo:false}),400);
    assert.equal(await store.count('properties'),0);
  });
  const original=await saveCatalog(store,'test-admin','properties',{...demoProperties()[0],name:'Existing real listing',is_demo:false});
  await store.set('cs_accounts','keep',{name:'Landing must remain unchanged'});
  await t.test('concurrent installs create only missing properties without overwriting real data',async()=>{
    const results=await Promise.all([install(secrets.admin),install(secrets.admin)]);
    const outputs=results.map(r=>expect(r,200));
    assert.equal(outputs.reduce((total,r)=>total+r.created.length,0),3);
    assert.equal(await store.count('properties'),4);
    assert.equal((await store.get('properties',original.id)).name,'Existing real listing');
    assert.equal((await store.get('properties',original.id)).is_demo,false);
    assert.equal((await store.get('cs_accounts','keep')).name,'Landing must remain unchanged');
    assert.equal(await store.count('products'),0);assert.equal(await store.count('checkouts'),0);
    assert.equal(await store.count('audit_log'),4);
  });
  const ledger=await store.get('system',demoCatalogId),villaId=ledger.installed['villa-oliva'];
  let villa=await store.get('properties',villaId);
  await t.test('bundled photos can be retained in the normal admin editor',async()=>{
    const fields=Object.keys((await import('../src/firestore-schemas.js')).propertyBody.properties);
    const body=Object.fromEntries(fields.filter(f=>f in villa).map(f=>[f,villa[f]]));
    body.name='Villa edited by admin';body.slug='villa-edited';body.nightly_minor=31000;
    const result=await app.inject({method:'PUT',url:'/v1/admin/properties/'+villa.id,headers:{authorization:'Bearer '+secrets.admin},payload:body});
    expect(result,200);villa=await store.get('properties',villaId);
    assert.equal(villa.is_demo,true);assert.deepEqual(villa.images,demoProperties()[1].images);
  });
  await t.test('repeated installation preserves edits, renamed slugs and archived records',async()=>{
    await store.set('properties',villaId,{...villa,archived:true,published:false});
    const result=expect(await install(secrets.admin),200);
    assert.equal(result.created.length,0);assert.equal(result.skipped.length,4);
    const kept=await store.get('properties',villaId);
    assert.equal(kept.name,'Villa edited by admin');assert.equal(kept.nightly_minor,31000);
    assert.equal(kept.archived,true);assert.equal(kept.slug,'villa-edited');
    assert.equal(await store.get('unique_keys',key('properties-slug','villa-oliva')),null);
  });
  await t.test('demo properties cannot create bookings in production',async()=>{
    await store.set('properties',villaId,{...villa,published:true,archived:false});
    await assert.rejects(createBooking(store,{...config,production:true},'guest',randomUUID(),{property_id:villaId}),error=>error.statusCode===409);
    assert.equal(await store.count('checkouts'),0);assert.equal(await store.count('occupancy'),0);
  });
  await t.test('live installation requires disabled payments',async()=>{
    const liveApp=await buildApp({...config,production:true,paymentProvider:'stripe'},{store,logger:false,testing:true,gateway:{}});
    try{expect(await install(secrets.admin,{confirm:true},liveApp),409);}finally{await liveApp.close();}
    assert.equal(await store.count('properties'),4);
  });
});
