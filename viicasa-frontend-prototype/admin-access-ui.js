export function adminPasswordForm(L,enabled){
  if(!enabled)return '';
  return `<form class="admin-access-form" id="admin-password-login"><h3>${L('Entrar con correo y contraseña','Sign in with email and password')}</h3><label>${L('Correo administrativo','Administrator email')}<input name="email" type="email" autocomplete="username" maxlength="254" required></label><label>${L('Contraseña','Password')}<input name="password" type="password" autocomplete="current-password" maxlength="128" required></label><button class="btn full">${L('Iniciar sesión','Sign in')}</button><p class="form-message" role="status" aria-live="polite"></p></form>`;
}

export function bindAdminPasswordLogin({api,L,onSuccess}){
  const form=document.querySelector('#admin-password-login');if(!form)return;
  form.onsubmit=async event=>{
    event.preventDefault();const button=form.querySelector('button'),message=form.querySelector('[role=status]');
    button.disabled=true;message.textContent=L('Verificando acceso…','Checking access…');
    try{const data=Object.fromEntries(new FormData(form));await api('/admin-login',{method:'POST',body:data});form.reset();await onSuccess();}
    catch(error){message.textContent=error.status===401?L('Correo o contraseña incorrectos.','Incorrect email or password.'):error.status===429?L('Demasiados intentos. Espera un minuto.','Too many attempts. Please wait a minute.'):L('No se pudo iniciar sesión. Comprueba los datos o vuelve a intentarlo.','Unable to sign in. Check your details or try again.');}
    finally{button.disabled=false;}
  };
}

export function bindAdminAccessTools({api,L,modal,notify,onPasswordChanged}){
  const create=document.querySelector('#admin-create-user');
  if(create)create.onclick=()=>{
    const dialog=modal(L('Crear acceso administrativo','Create administrator access'),`<p>${L('Esta cuenta tendrá permisos completos sobre propiedades, productos y pedidos. No crea un buzón de correo ni una cuenta de Google.','This account will have full access to properties, products and orders. It does not create an email mailbox or Google account.')}</p><form class="admin-access-form" id="admin-create-user-form"><label>${L('Nombre','Name')}<input name="name" value="Administración VIICASA" minlength="2" maxlength="120" required></label><label>${L('Correo','Email')}<input name="email" type="email" value="concierge@viicasa.com" autocomplete="off" maxlength="254" required></label><label>${L('Contraseña inicial (12 caracteres como mínimo)','Initial password (at least 12 characters)')}<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><label class="consent"><input name="confirm" type="checkbox" required>${L('Confirmo que autorizo acceso administrativo completo.','I authorise full administrator access.')}</label><button class="btn full">${L('Crear administrador','Create administrator')}</button><p class="form-message" role="status" aria-live="polite"></p></form>`);
    const form=dialog.querySelector('form');form.onsubmit=async event=>{
      event.preventDefault();const button=form.querySelector('button'),message=form.querySelector('[role=status]');button.disabled=true;
      const {name,email,password}=Object.fromEntries(new FormData(form));
      try{await api('/admin/users',{method:'POST',body:{name,email,password}});form.reset();dialog.close();notify(L('Administrador creado. Ya puede entrar desde /admin con correo y contraseña.','Administrator created. They can now sign in at /admin with email and password.'));}
      catch(error){message.textContent=error.status===409?L('Ese correo ya tiene una cuenta. No se modificó su contraseña ni su rol.','That email already has an account. Its password and role were not changed.'):L('No se pudo crear el administrador. Revisa los datos y tus permisos.','Unable to create the administrator. Check the details and your permissions.');}
      finally{button.disabled=false;}
    };
  };
  const change=document.querySelector('#admin-change-password');
  if(change)change.onclick=()=>{
    const dialog=modal(L('Cambiar contraseña administrativa','Change administrator password'),`<form class="admin-access-form" id="admin-change-password-form"><label>${L('Contraseña actual','Current password')}<input name="current_password" type="password" autocomplete="current-password" maxlength="128" required></label><label>${L('Nueva contraseña','New password')}<input name="new_password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><label>${L('Confirmar nueva contraseña','Confirm new password')}<input name="confirmation" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><button class="btn full">${L('Guardar y cerrar sesiones','Save and sign out all sessions')}</button><p class="form-message" role="status" aria-live="polite"></p></form>`);
    const form=dialog.querySelector('form');form.onsubmit=async event=>{
      event.preventDefault();const button=form.querySelector('button'),message=form.querySelector('[role=status]');
      const {current_password,new_password,confirmation}=Object.fromEntries(new FormData(form));
      if(new_password!==confirmation){message.textContent=L('Las contraseñas no coinciden.','The passwords do not match.');return;}
      button.disabled=true;
      try{await api('/admin/password',{method:'POST',body:{current_password,new_password}});form.reset();dialog.close();await onPasswordChanged();}
      catch{message.textContent=L('No se pudo cambiar la contraseña. Revisa la contraseña actual.','Unable to change the password. Check your current password.');}
      finally{button.disabled=false;}
    };
  };
}
