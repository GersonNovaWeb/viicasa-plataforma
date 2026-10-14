import {hash,fail} from '../viicasa-backend/src/lib.js';

const tokenPattern=/^[A-Za-z0-9_-]{43}$/;
export const adminPasswordEnabled=(env,demo)=>!demo&&env.ADMIN_PASSWORD_ENABLED!=='false';

// The backend owns passwords, roles, revocation and login throttling. Only a
// secure server cookie reaches the browser; never return its bearer token.
export async function passwordAdminLogin(app,input,{remoteAddress,previousSecret}={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['email','password'].includes(k)))fail(400,'Datos inválidos');
  const response=await app.inject({method:'POST',url:'/v1/auth/login',remoteAddress:remoteAddress||'127.0.0.1',payload:input});
  if(response.statusCode!==200){
    const status=response.statusCode;
    fail(status,status===429?'Demasiados intentos. Espera un minuto.':status===401?'Credenciales incorrectas':status===400?'Datos inválidos':'Acceso no disponible');
  }
  const data=response.json();
  const identity=await app.inject({method:'GET',url:'/v1/auth/me',headers:{authorization:`Bearer ${data.token}`}});
  if(identity.statusCode!==200){
    await app.store.transaction(tx=>tx.remove('sessions',hash(data.token)));
    fail(403,'Acceso administrativo denegado');
  }
  if(tokenPattern.test(previousSecret||''))await app.store.transaction(tx=>tx.remove('sessions',hash(previousSecret)));
  return {secret:data.token,expiresIn:data.expires_in};
}

export async function adminCookieSecret(app,secret){
  if(!tokenPattern.test(secret||''))return null;
  const result=await app.inject({method:'GET',url:'/v1/auth/me',headers:{authorization:`Bearer ${secret}`}});
  return result.statusCode===200?secret:null;
}
