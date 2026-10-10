export function emailLoginForm(L,enabled){
  if(!enabled)return '';
  return `<details class="cleaning-card"><summary>${L('Entrar o registrarme con correo','Sign in or register with email')}</summary><form id="email-login-form"><label>${L('Correo electrónico','Email')}<input name="email" type="email" required maxlength="254" autocomplete="email"></label><label>${L('Contraseña','Password')}<input name="password" type="password" required maxlength="128" autocomplete="current-password"></label><label id="email-name-field" hidden>${L('Nombre completo','Full name')}<input name="name" maxlength="120" minlength="2" autocomplete="name"></label><label class="checkbox"><input type="checkbox" name="create">${L('Crear una cuenta nueva','Create a new account')}</label><label id="email-consent-field" class="checkbox" hidden><input type="checkbox" name="consent">${L('Acepto las condiciones y el aviso de privacidad.','I agree to the terms and privacy notice.')} <a href="/privacidad">${L('Consultar','Read')}</a></label><div class="action-row"><button type="submit" class="btn">${L('Continuar','Continue')}</button><button type="button" class="btn outline" id="email-reset">${L('Olvidé mi contraseña','Forgot password')}</button></div><p role="status" aria-live="polite" id="email-status"></p></form></details>`;
}
export function bindEmailLogin({api,L,settings,lang}){
  const f=document.querySelector('#email-login-form');if(!f)return;
  const status=f.querySelector('#email-status'),buttons=[...f.querySelectorAll('button')];let busy=false;
  f.elements.create.onchange=()=>{const create=f.elements.create.checked;document.querySelector('#email-name-field').hidden=!create;document.querySelector('#email-consent-field').hidden=!create;f.elements.name.required=create;f.elements.consent.required=create;f.elements.password.minLength=create?12:1;f.elements.password.autocomplete=create?'new-password':'current-password';};
  async function run(reset=false){
    if(busy)return;if(reset?!f.elements.email.reportValidity():!f.reportValidity())return;
    busy=true;buttons.forEach(b=>b.disabled=true);status.textContent=L('Procesando…','Working…');let auth,sdk;
    try{
      const [app,authSdk]=await Promise.all([import('https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js'),import('https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js')]);sdk=authSdk;
      auth=sdk.getAuth(app.getApps()[0]||app.initializeApp(settings.firebase));auth.languageCode=lang;await sdk.setPersistence(auth,sdk.inMemoryPersistence);
      const email=f.elements.email.value.trim(),password=f.elements.password.value;
      const action={url:location.origin+'/cuenta'};
      if(reset){await sdk.sendPasswordResetEmail(auth,email,action);status.textContent=L('Si la dirección permite recuperar acceso, recibirás un enlace. Revisa correo y spam.','If this address supports account recovery, you will receive a link. Check your inbox and spam.');return;}
      const create=f.elements.create.checked;
      const result=create?await sdk.createUserWithEmailAndPassword(auth,email,password):await sdk.signInWithEmailAndPassword(auth,email,password);
      if(create)await sdk.updateProfile(result.user,{displayName:f.elements.name.value.trim()});
      if(!result.user.emailVerified){await sdk.sendEmailVerification(result.user,action);status.textContent=L('Verifica tu correo con el enlace enviado y después inicia sesión. Aún no se ha abierto una sesión en VIICASA.','Verify your email using the link we sent, then sign in. No VIICASA session has been opened yet.');return;}
      await api('/auth/social',{method:'POST',body:{idToken:await result.user.getIdToken(true)}});await sdk.signOut(auth);auth=null;location.reload();
    }catch(error){
      const generic=L('No se pudo completar el acceso. Revisa tus datos o utiliza Google o Apple si ya tenías cuenta.','Unable to sign in. Check your details, or use Google or Apple if you already have an account.');
      status.textContent=reset&&['auth/user-not-found','auth/invalid-credential'].includes(error.code)?L('Si la dirección permite recuperar acceso, recibirás un enlace.','If this address supports account recovery, you will receive a link.'):error.code==='auth/operation-not-allowed'?L('El acceso por correo debe activarse en Firebase.','Email sign-in must be enabled in Firebase.'):error.code==='auth/weak-password'?L('Usa una contraseña más segura (mínimo 12 caracteres para una cuenta nueva).','Use a stronger password (at least 12 characters for a new account).'):error.code==='auth/too-many-requests'?L('Demasiados intentos. Espera antes de volver a intentar.','Too many attempts. Please wait before trying again.'):generic;
    }finally{if(auth&&sdk)await sdk.signOut(auth).catch(()=>{});f.elements.password.value='';busy=false;buttons.forEach(b=>b.disabled=false);}
  }
  f.onsubmit=e=>{e.preventDefault();void run();};f.querySelector('#email-reset').onclick=()=>void run(true);
}
