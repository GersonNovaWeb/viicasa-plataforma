import {createRemoteJWKSet,jwtVerify,importPKCS8,SignJWT} from 'jose';
import {createHash} from 'node:crypto';
import {fail} from '../viicasa-backend/src/lib.js';

const endpoints={google:{authorization:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',keys:'https://www.googleapis.com/oauth2/v3/certs',issuer:['https://accounts.google.com','accounts.google.com']},apple:{authorization:'https://appleid.apple.com/auth/authorize',token:'https://appleid.apple.com/auth/token',keys:'https://appleid.apple.com/auth/keys',issuer:'https://appleid.apple.com'}};
export function identityConfiguration(env,origin){
  const url=new URL(origin),local=['localhost','127.0.0.1','[::1]'].includes(url.hostname),google={clientId:env.PHASE2_GOOGLE_CLIENT_ID,secret:env.PHASE2_GOOGLE_CLIENT_SECRET},apple={clientId:env.PHASE2_APPLE_SERVICE_ID,teamId:env.PHASE2_APPLE_TEAM_ID,keyId:env.PHASE2_APPLE_KEY_ID,privateKey:env.PHASE2_APPLE_PRIVATE_KEY?.replace(/\\n/g,'\n')};
  const ready=value=>typeof value==='string'&&value.length>3&&!/REPLACE|PLACEHOLDER|YOUR_|<|>/i.test(value);
  google.reason=env.PHASE2_GOOGLE_ENABLED!=='true'?'disabled':!ready(google.clientId)||!ready(google.secret)?'missing_credentials':url.protocol!=='https:'&&!local?'requires_https':null;
  apple.reason=env.PHASE2_APPLE_ENABLED!=='true'?'disabled':![apple.clientId,apple.teamId,apple.keyId,apple.privateKey].every(ready)?'missing_credentials':url.protocol!=='https:'||local||!url.hostname.includes('.')||/^[\d.]+$/.test(url.hostname)?'requires_https_domain':null;
  return{google:{...google,enabled:!google.reason,callback:new URL('/auth/google/callback',origin).href},apple:{...apple,enabled:!apple.reason,callback:new URL('/auth/apple/callback',origin).href}};
}
export function validateIdentityClaims(provider,claims,{clientId,nonce,now=Math.floor(Date.now()/1000)}){
  const validIssuer=provider==='google'?['https://accounts.google.com','accounts.google.com'].includes(claims.iss):claims.iss==='https://appleid.apple.com';
  if(!validIssuer||claims.aud!==clientId||claims.azp&&claims.azp!==clientId||!Number.isInteger(claims.exp)||claims.exp<=now||!Number.isInteger(claims.iat)||claims.iat>now+30||claims.nonce!==nonce||typeof claims.sub!=='string'||!claims.sub.length||claims.sub.length>255)fail(401,'Provider identity could not be verified.');
  if(![true,'true'].includes(claims.email_verified)||typeof claims.email!=='string'||claims.email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email))fail(401,'The provider must supply a verified email.');
  return{subject:claims.sub,email:claims.email.toLowerCase(),name:typeof claims.name==='string'?claims.name.slice(0,120):'',privateEmail:[true,'true'].includes(claims.is_private_email)};
}
export function identityProviderGateway(configuration,{fetcher=fetch,keySets={}}={}){
  const keys={};
  return{
    authorize(provider,{state,nonce,verifier}){
      const c=configuration[provider],url=new URL(endpoints[provider].authorization);url.search=new URLSearchParams({client_id:c.clientId,redirect_uri:c.callback,response_type:provider==='apple'?'code id_token':'code',scope:provider==='apple'?'name email':'openid email profile',state,nonce,...(provider==='apple'?{response_mode:'form_post'}:{code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',prompt:'select_account'})}).toString();return url.href;
    },
    async exchange(provider,{code,nonce,verifier}){
      const c=configuration[provider];let secret=c.secret;
      if(provider==='apple'){
        const key=await importPKCS8(c.privateKey,'ES256');secret=await new SignJWT({}).setProtectedHeader({alg:'ES256',kid:c.keyId}).setIssuer(c.teamId).setSubject(c.clientId).setAudience('https://appleid.apple.com').setIssuedAt().setExpirationTime('5m').sign(key);
      }
      let response;try{response=await fetcher(endpoints[provider].token,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,client_id:c.clientId,client_secret:secret,redirect_uri:c.callback,...(provider==='google'?{code_verifier:verifier}:{})}),signal:AbortSignal.timeout(15000),redirect:'error'});}catch{fail(502,'Unable to contact the identity provider. Start sign-in again.');}
      if(!response.ok)fail(401,'The provider rejected sign-in. Start again.');let body;try{body=await response.json();}catch{fail(401,'Invalid provider response.');}
      if(typeof body.id_token!=='string'||body.id_token.length>16384)fail(401,'Missing provider identity token.');
      if(!keys[provider])keys[provider]=keySets[provider]||createRemoteJWKSet(new URL(endpoints[provider].keys),{timeoutDuration:10000});
      let payload;try{({payload}=await jwtVerify(body.id_token,keys[provider],{issuer:endpoints[provider].issuer,audience:c.clientId,algorithms:['RS256'],requiredClaims:['sub','iat','exp','nonce','email','email_verified'],clockTolerance:30}));}catch{fail(401,'Provider identity token is invalid.');}
      // Access/refresh tokens are deliberately discarded: this login requests no
      // Gmail, Drive or Apple account access beyond identity.
      return validateIdentityClaims(provider,payload,{clientId:c.clientId,nonce});
    },
  };
}
