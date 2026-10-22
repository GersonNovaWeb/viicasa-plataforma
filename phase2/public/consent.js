import {loadApprovedTags,resetApprovedTags} from './analytics-external.js';
const lang=()=>document.documentElement.lang||localStorage.getItem('viicasa-phase2-language')||'en';
const L=(es,en)=>lang().startsWith('es')?es:en;
let preferences,box;
const pageId=crypto.randomUUID();
const section=location.pathname.startsWith('/viilife')?'viilife':location.pathname.startsWith('/shop')||location.pathname==='/coleccion'?'viishop':location.pathname.startsWith('/viiconcierge')||location.pathname.startsWith('/propiedades')?'viiconcierge':['/cliente','/cuenta'].includes(location.pathname)?'account':'home';
async function call(path,method='GET',body){const r=await fetch(path,{method,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(L('No se pudieron guardar las preferencias. Inténtalo de nuevo.','Unable to save preferences. Please try again.'));return r.json();}
async function pageView(){if(preferences.statistics&&preferences.journal_enabled&&!preferences.gpc)try{await call('/api/measurement/events','POST',{event_id:pageId,name:'page_view',section});}catch{/* Optional measurement never blocks a service page. */}}
function open(){
  box.hidden=false;
  const notice=preferences.external_enabled?L('Con tu permiso, los eventos de navegación y compra pueden compartirse con Google para estadísticas y Meta para marketing. No enviamos datos del formulario desde el servidor. Las etiquetas del navegador usan la configuración aprobada en el aviso. Puedes retirar el permiso; no recupera datos ya enviados.','With permission, browsing and purchase events may be shared with Google for statistics and Meta for marketing. Our server does not send form contact fields. Browser tags use the configuration approved in the notice. You can withdraw permission; data already sent cannot be recalled.'):L('La medición opcional permanece local; los proveedores externos están desactivados.','Optional measurement stays local; external providers are disabled.');
  box.innerHTML=`<h2 id="privacy-title">${L('Tus preferencias de privacidad','Your privacy preferences')}</h2><p>${L('Las cookies necesarias conservan el acceso, carrito y estas preferencias.','Necessary cookies maintain sign-in, cart and these preferences.')} ${notice}</p>${!preferences.policy_approved?`<p>${L('Aviso de privacidad pendiente de aprobación: la medición opcional no está disponible.','Privacy notice awaiting approval: optional measurement is unavailable.')}</p>`:''}${preferences.gpc?`<p>${L('Se respeta la señal de privacidad global de tu navegador.','Your browser’s global privacy signal is respected.')}</p>`:''}<form id="privacy-form"><label><input type="checkbox" name="statistics" ${preferences.statistics?'checked':''} ${!preferences.policy_approved||preferences.gpc?'disabled':''}>${L('Permitir estadísticas opcionales','Allow optional statistics')}</label><label><input type="checkbox" name="marketing" ${preferences.marketing?'checked':''} ${!preferences.policy_approved||preferences.gpc?'disabled':''}>${L('Permitir marketing opcional','Allow optional marketing')}</label><div class="privacy-actions"><button type="button" id="necessary-only">${L('Solo necesarias','Necessary only')}</button><button type="submit">${L('Guardar selección','Save selection')}</button></div><p id="privacy-error" role="alert" hidden></p></form><p><a href="/privacidad">${L('Leer el aviso de privacidad','Read the privacy notice')}</a></p>`;
  const save=async(statistics,marketing)=>{
    box.querySelectorAll('button').forEach(b=>b.disabled=true);
    try{preferences=await call('/api/privacy/preferences','PUT',{statistics,marketing,policy_version:preferences.policy_version});box.hidden=true;await pageView();if(!preferences.statistics||!preferences.marketing)resetApprovedTags();else await loadApprovedTags();}
    catch(e){const error=box.querySelector('#privacy-error');error.textContent=e.message;error.hidden=false;}
    finally{box.querySelectorAll('button').forEach(b=>b.disabled=false);}
  };
  box.querySelector('#necessary-only').onclick=()=>save(false,false);
  box.querySelector('#privacy-form').onsubmit=e=>{e.preventDefault();save(box.querySelector('[name=statistics]').checked,box.querySelector('[name=marketing]').checked);};
}
try{
  preferences=await call('/api/privacy/preferences');
  const button=document.createElement('button');button.className='privacy-preferences';button.type='button';button.textContent=L('Privacidad','Privacy');button.setAttribute('aria-controls','privacy-choice');button.onclick=open;
  box=document.createElement('aside');box.id='privacy-choice';box.className='privacy-choice';box.setAttribute('aria-labelledby','privacy-title');box.hidden=true;
  document.body.append(button,box);
  new MutationObserver(()=>{button.textContent=L('Privacidad','Privacy');if(!box.hidden){const statistics=box.querySelector('[name=statistics]')?.checked,marketing=box.querySelector('[name=marketing]')?.checked;open();box.querySelector('[name=statistics]').checked=Boolean(statistics);box.querySelector('[name=marketing]').checked=Boolean(marketing);}}).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
  if(preferences.gpc&&(!preferences.chosen||preferences.requires_gpc_reset))preferences=await call('/api/privacy/preferences','PUT',{statistics:false,marketing:false,policy_version:preferences.policy_version});
  if(!preferences.chosen)open();else{await pageView();await loadApprovedTags();}
}catch{/* No preferences request succeeded: fail closed, without measurement. */}
