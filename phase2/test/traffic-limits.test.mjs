import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import {trafficBucket,trafficKey,storefrontLimits} from '../traffic-limits.mjs';
import {openPhase2Databases} from '../database.mjs';
import {seedPhase2} from '../bootstrap.mjs';
import {buildPhase2App} from '../app.mjs';
import {secretVault} from '../security.mjs';

test('traffic budgets use the socket IP, separate reads/writes/pages and normalize IPv6',()=>{
  const req={method:'GET',url:'/vii-feed.js?rev=1',ip:'127.0.0.1',headers:{'x-forwarded-for':'198.51.100.9'}};
  assert.equal(trafficBucket(req),'page');assert.equal(trafficKey(req),'127.0.0.1:page');
  assert.equal(trafficBucket({...req,url:'/api/products?limit=100'}),'read');
  assert.equal(trafficBucket({...req,url:'/v1/cart'}),'read');
  assert.equal(trafficBucket({...req,method:'POST',url:'/api/orders'}),'write');
  assert.equal(trafficKey({...req,ip:'2001:db8:1:2::1'}),trafficKey({...req,ip:'2001:db8:1:2::abcd'}));
});

test('all traffic remains bounded and explicit authentication limits stay independent',async t=>{
  const app=Fastify();t.after(()=>app.close());await app.register(rateLimit,storefrontLimits());
  app.get('/asset.js',()=>({ok:true}));app.get('/api/catalogue',()=>({ok:true}));app.post('/api/order',()=>({ok:true}));
  app.post('/api/login',{config:{rateLimit:{max:5,timeWindow:'5 minutes'}}},()=>({ok:true}));
  for(let i=0;i<1200;i++)assert.equal((await app.inject('/asset.js')).statusCode,200);
  assert.equal((await app.inject('/asset.js')).statusCode,429);
  for(let i=0;i<250;i++)assert.equal((await app.inject('/api/catalogue')).statusCode,200);
  const limited=await app.inject('/api/catalogue');assert.equal(limited.statusCode,429);assert.ok(Number(limited.headers['retry-after'])>0);
  assert.equal((await app.inject({url:'/api/catalogue',remoteAddress:'192.0.2.10'})).statusCode,200);
  assert.equal((await app.inject({url:'/api/order',method:'POST'})).statusCode,200);
  for(let i=0;i<5;i++)assert.equal((await app.inject({url:'/api/login',method:'POST'})).statusCode,200);
  assert.equal((await app.inject({url:'/api/login',method:'POST'})).statusCode,429);
  const inner=storefrontLimits({internal:true});assert.equal(inner.max({method:'POST',url:'/v1/checkouts'}),120);
});

test('repeated real page assets and catalogue calls do not lock navigation, login or the proxied backend',async t=>{
  const databases=await openPhase2Databases('',{memory:true});t.after(()=>databases.close());await seedPhase2(databases);
  const origin='http://127.0.0.1:3030',app=await buildPhase2App(databases,secretVault(Buffer.alloc(32,28)),{origin});t.after(()=>app.close());
  const assets=['/vii-ui.js','/vii-hero.js','/vii-final.css'];
  for(let i=0;i<90;i++)for(const url of assets)assert.equal((await app.inject(url)).statusCode,200,url);
  assert.equal((await app.inject('/shop')).statusCode,200);
  const config=await app.inject('/api/config');assert.equal(config.statusCode,200);assert.equal(config.headers['x-ratelimit-remaining'],'249');
  let cookie;
  for(let i=0;i<130;i++){
    const response=await app.inject({url:'/api/shop/settings?currency=CAD',headers:cookie?{cookie}:{}});
    assert.equal(response.statusCode,200,response.body);
    cookie||=[].concat(response.headers['set-cookie']||[]).map(x=>x.split(';')[0]).join('; ');
  }
  for(let i=0;i<12;i++)assert.equal((await app.inject({url:'/api/commercial/login',method:'POST',headers:{origin},payload:{email:'unknown@example.invalid',password:'Invalid-test-password-only'}})).statusCode,401);
  const blocked=await app.inject({url:'/api/commercial/login',method:'POST',headers:{origin},payload:{email:'unknown@example.invalid',password:'Invalid-test-password-only'}});
  assert.equal(blocked.statusCode,429);assert.equal(blocked.headers['x-ratelimit-limit'],'12');
  assert.equal((await app.inject('/viilife')).statusCode,200);
});
