// Contact data belongs to a checkout, not a newly created or verified account.
export async function installGuestBuyer({form,L,esc}){
  const response=await fetch('/api/guest/buyer'),data=await response.json();
  if(!response.ok)throw Error(data.error||'Unable to prepare checkout.');
  if(data.profile){form.insertAdjacentHTML('afterbegin',`<p class="quiet">${esc(data.profile.name)} · ${esc(data.profile.email)}</p>`);return()=>({});}
  form.insertAdjacentHTML('afterbegin',`<fieldset class="guest-contact"><legend>${L('Continúa como invitado','Continue as a guest')}</legend><p class="quiet">${L('No necesitas crear una cuenta. Enviaremos las novedades y un enlace privado a este correo.','No account needed. We will email updates and a private order link to this address.')}</p><label>${L('Nombre completo','Full name')}<input name="guest_name" autocomplete="name" required minlength="2" maxlength="120"></label><label>${L('Correo electrónico','Email address')}<input name="guest_email" type="email" autocomplete="email" required maxlength="254"></label><small>${L('¿Ya tienes cuenta?','Already have an account?')} <a href="/cliente">${L('Iniciar sesión (opcional)','Sign in (optional)')}</a></small></fieldset>`);
  return()=>({customer:{name:form.elements.guest_name.value.trim(),email:form.elements.guest_email.value.trim().toLowerCase()}});
}
