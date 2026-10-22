import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {generateKeyPair,exportJWK,exportPKCS8,createLocalJWKSet,SignJWT} from 'jose';
import {openPhase2Databases} from '../database.mjs';
import {seedPhase2,demoCredentials} from '../bootstrap.mjs';
import {buildPhase2App} from '../app.mjs';
import {secretVault} from '../security.mjs';
import {identityConfiguration,identityProviderGateway,validateIdentityClaims} from '../identity-provider.mjs';

const googleEnv={PHASE2_GOOGLE_ENABLED:'true',PHASE2_GOOGLE_CLIENT_ID:'google-fixture-client',PHASE2_GOOGLE_CLIENT_SECRET:'fixture-private-client-secret'},origin='http://127.0.0.1:3030';
async function fixture(t,{apple=false}={}){
  const dbs=await openPhase2Databases('',{memory:true});t.after(()=>dbs.close());await seedPhase2(dbs);
  const keys=await generateKeyPair('RS256'),jwk=await exportJWK(keys.publicKey);jwk.kid='fixture-rsa';jwk.alg='RS256';
  const appleKey=await generateKeyPair('ES256',{extractable:true}),privateApple=await exportPKCS8(appleKey.privateKey);
  const site=apple?'https://demo.example.invalid':origin,environment={...googleEnv,...(apple?{PHASE2_APPLE_ENABLED:'true',PHASE2_APPLE_SERVICE_ID:'apple-fixture-service',PHASE2_APPLE_TEAM_ID:'fixture-team',PHASE2_APPLE_KEY_ID:'fixture-key',PHASE2_APPLE_PRIVATE_KEY:privateApple}:{})},configuration=identityConfiguration(environment,site);
  let claim={sub:'subject-one',email:'social@example.invalid',email_verified:true,name:'Demo Customer'},activeNonce,activeProvider='google',capturedTokenRequest;
  const gateway=identityProviderGateway(configuration,{keySets:{google:createLocalJWKSet({keys:[jwk]}),apple:createLocalJWKSet({keys:[jwk]})},fetcher:async(url,options)=>{
    capturedTokenRequest={url,body:Object.fromEntries(options.body)};
    const issuer=activeProvider==='google'?'https://accounts.google.com':'https://appleid.apple.com',client=configuration[activeProvider].clientId;
    const jwt=await new SignJWT({nonce:activeNonce,...claim}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer(issuer).setAudience(client).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
    return{ok:true,json:async()=>({id_token:jwt})};
  }});
  const app=await buildPhase2App(dbs,secretVault(Buffer.alloc(32,9)),{testing:true,origin:site,connectionEnvironment:environment,identityGateway:gateway});t.after(()=>app.close());
  const call=(path,{method='GET',cookie,body,headers={}}={})=>app.inject({url:path,method,headers:{origin:site,...(cookie?{cookie}:{}),...headers},payload:body});
  const start=async(provider='google',intent='signin',cookie)=>{const response=await call('/api/client/auth/'+provider+'/start',{method:'POST',cookie,body:{intent,consent:true}});assert.equal(response.statusCode,200,response.body);const authorization=new URL(response.json().authorization_url);activeNonce=authorization.searchParams.get('nonce');activeProvider=provider;return{state:authorization.searchParams.get('state'),cookie:response.headers['set-cookie'].split(';')[0],authorization};};
  const callback=(flow,provider='google',options={})=>provider==='google'?call('/auth/google/callback?code=fixture-code&state='+flow.state,{cookie:flow.cookie,...options}):call('/auth/apple/callback',{method:'POST',cookie:flow.cookie,body:new URLSearchParams({state:flow.state,code:'fixture-code',user:JSON.stringify({name:{firstName:'Apple',lastName:'Reader'},email:'untrusted@example.invalid'})}).toString(),headers:{'content-type':'application/x-www-form-urlencoded',origin:'https://appleid.apple.com'},...options});
  const session=response=>{const cookies=[response.headers['set-cookie']].flat();return cookies.find(c=>c.startsWith('vc2_client='))?.split(';')[0];};
  const customer=async email=>{const registered=await call('/api/client/register',{method:'POST',body:{email,name:'Password Customer',password:'Customer-Demo-2026!'}});const mail=(await dbs.commercial.query("SELECT body FROM commercial_mail WHERE recipient=$1 AND subject LIKE '%Verify your email%' ORDER BY created_at DESC LIMIT 1",[email])).rows[0];const verified=await call('/api/client/verify',{method:'POST',body:{challenge:registered.json().challenge,code:mail.body.match(/code is (\d{6})/)[1]}});assert.equal(verified.statusCode,200,verified.body);return session(verified);};
  return{...dbs,app,call,start,callback,session,customer,configuration,setClaims:v=>{claim=v;},getCapture:()=>capturedTokenRequest};
}

test('provider configuration is opt-in; Apple requires HTTPS domain, strict JWT claims reject replay/issuer/audience/unverified mail',()=>{
  const cfg=identityConfiguration({...googleEnv,PHASE2_APPLE_ENABLED:'true',PHASE2_APPLE_SERVICE_ID:'service',PHASE2_APPLE_TEAM_ID:'team',PHASE2_APPLE_KEY_ID:'key-id',PHASE2_APPLE_PRIVATE_KEY:'fixture-private-key'},origin);assert.equal(cfg.google.enabled,true);assert.equal(cfg.apple.reason,'requires_https_domain');
  assert.equal(identityConfiguration({},origin).google.enabled,false);
  const claims={iss:'https://accounts.google.com',aud:'client',sub:'subject',iat:100,exp:200,nonce:'nonce',email:'verified@example.invalid',email_verified:true};
  assert.equal(validateIdentityClaims('google',claims,{clientId:'client',nonce:'nonce',now:150}).email,'verified@example.invalid');
  for(const bad of [{nonce:'different'},{email_verified:false},{aud:'other'},{iss:'https://attacker.invalid'},{exp:140}])assert.throws(()=>validateIdentityClaims('google',{...claims,...bad},{clientId:'client',nonce:'nonce',now:150}));
});

test('Google code flow creates verified customer only, uses PKCE/browser state and welcomes once; replay and nonce mismatch fail',async t=>{
  const f=await fixture(t),flow=await f.start();assert.equal(flow.authorization.hostname,'accounts.google.com');assert.equal(flow.authorization.searchParams.get('code_challenge_method'),'S256');
  assert.equal((await f.callback(flow,'google',{cookie:''})).headers.location,'/cliente?auth_error=browser_mismatch');
  const completed=await f.callback(flow);assert.equal(completed.statusCode,303);const cookie=f.session(completed);assert.ok(cookie);
  const profile=(await f.call('/api/client/me',{cookie})).json().profile;assert.equal(profile.email_verified,true);assert.equal(profile.login_provider,'google');assert.equal(profile.password_enabled,false);
  assert.equal((await f.call('/api/commercial/me',{cookie})).statusCode,401);assert.equal((await f.callback(flow)).headers.location,'/cliente?auth_error=flow_expired');
  const captured=f.getCapture();assert.equal(captured.url,'https://oauth2.googleapis.com/token');assert.ok(captured.body.code_verifier);assert.equal(captured.body.client_secret,googleEnv.PHASE2_GOOGLE_CLIENT_SECRET);
  const another=await f.start();const again=await f.callback(another);assert.equal((await f.call('/api/client/me',{cookie:f.session(again)})).json().profile.id,profile.id);
  assert.equal((await f.commercial.query('SELECT count(*)::integer AS n FROM commercial_mail WHERE dedupe=$1',['customer-welcome:'+profile.id])).rows[0].n,1);
  const invalid=await f.start();f.setClaims({sub:'bad',email:'bad@example.invalid',email_verified:true,nonce:'wrong'});assert.equal((await f.callback(invalid)).headers.location,'/cliente?auth_error=provider_failed');
  assert.equal((await f.commercial.query("SELECT count(*)::integer AS n FROM customer_accounts WHERE email='bad@example.invalid'")).rows[0].n,0);
});

test('matching email is not auto-linked; explicit current-account linking keeps identity and revocation blocks pending callback',async t=>{
  const f=await fixture(t),passwordCookie=await f.customer('existing@example.invalid');const before=(await f.call('/api/client/me',{cookie:passwordCookie})).json().profile;
  f.setClaims({sub:'existing-google',email:'existing@example.invalid',email_verified:true,name:'External Name'});
  const conflict=await f.start();assert.equal((await f.callback(conflict)).headers.location,'/cliente?auth_error=link_required');
  const link=await f.start('google','link',passwordCookie),linked=await f.callback(link);assert.equal(linked.headers.location,'/cliente?auth_success=google');const social=f.session(linked);
  const after=(await f.call('/api/client/me',{cookie:social})).json().profile;assert.equal(after.id,before.id);assert.equal(after.name,before.name);assert.equal(after.email,before.email);
  const identities=await f.call('/api/client/auth/identities',{cookie:social});assert.equal(identities.json().items[0].provider,'google');assert.ok(!identities.body.includes('existing-google'));
  const unlink=await f.call('/api/client/auth/identities/google',{method:'DELETE',cookie:social,body:{}});assert.equal(unlink.statusCode,200,unlink.body);assert.equal((await f.call('/api/client/me',{cookie:passwordCookie})).statusCode,401);
  const signIn=await f.call('/api/client/login',{method:'POST',body:{email:'existing@example.invalid',password:'Customer-Demo-2026!'}}),newCookie=f.session(signIn),pending=await f.start('google','link',newCookie);
  await f.call('/api/client/logout',{method:'POST',cookie:newCookie,body:{}});assert.equal((await f.callback(pending)).headers.location,'/cliente?auth_error=provider_failed');
});

test('Apple form_post uses browser-bound Secure cookie, signed client secret and verified JWT email rather than unsigned user field',async t=>{
  const f=await fixture(t,{apple:true});f.setClaims({sub:'apple-subject',email:'private@privaterelay.appleid.com',email_verified:'true',is_private_email:'true'});
  const flow=await f.start('apple');assert.equal(flow.authorization.searchParams.get('response_mode'),'form_post');
  const completed=await f.callback(flow,'apple');assert.equal(completed.headers.location,'/cliente?auth_success=apple');const cookie=f.session(completed),profile=(await f.call('/api/client/me',{cookie})).json().profile;
  assert.equal(profile.email,'private@privaterelay.appleid.com');assert.equal(profile.name,'Apple Reader');assert.equal(profile.login_provider,'apple');
  const request=f.getCapture();assert.equal(request.url,'https://appleid.apple.com/auth/token');assert.equal(request.body.client_secret.split('.').length,3);assert.ok(!request.body.client_secret.includes('PRIVATE KEY'));
  assert.equal((await f.call('/api/client/auth/identities/apple',{method:'DELETE',cookie,body:{}})).statusCode,409);
  const replay=await f.callback(flow,'apple');assert.equal(replay.headers.location,'/cliente?auth_error=flow_expired');
});
