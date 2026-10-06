import {fail} from './lib.js';

export const socialProviderIds={google:'google.com',apple:'apple.com',facebook:'facebook.com'};
export function enabledSocialProviders(env,demo){
  const ready=!demo&&Boolean(env.FIREBASE_WEB_API_KEY);
  return {google:ready,apple:ready&&env.AUTH_APPLE_ENABLED==='true',facebook:ready&&env.AUTH_FACEBOOK_ENABLED==='true'};
}
// Claims must already have passed Firebase Admin verifyIdToken/verifySessionCookie.
export function validateSocialIdentity(user,enabled,{fresh=false,expectedProvider,now=Date.now()/1000}={}){
  const provider=user?.firebase?.sign_in_provider;
  const name=Object.keys(socialProviderIds).find(k=>socialProviderIds[k]===provider);
  if(!name||!enabled[name]||(expectedProvider&&provider!==expectedProvider))fail(401,'Proveedor de acceso no habilitado');
  if(typeof user.uid!=='string'||!user.uid)fail(401,'Identidad inválida');
  if(typeof user.email!=='string'||!user.email.trim())fail(401,'Comparte un correo electrónico desde tu proveedor para continuar');
  if(user.email_verified!==true)fail(401,'Verifica tu correo electrónico antes de iniciar sesión');
  if(fresh&&(!Number.isFinite(user.auth_time)||now-user.auth_time>300||user.auth_time>now+60))fail(401,'Vuelve a iniciar sesión para continuar');
  return provider;
}
export function isAllowedGoogleAdmin(user,emails=''){
  return user?.firebase?.sign_in_provider==='google.com'&&user.email_verified===true&&typeof user.email==='string'
    &&emails.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean).includes(user.email.toLowerCase());
}
