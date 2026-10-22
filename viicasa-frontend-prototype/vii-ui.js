// Small, shared storefront primitives. No fabricated reviews, savings or availability.
const paths={search:'m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',heart:'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 22l8.8-9.6a5.5 5.5 0 0 0 0-7.8Z',share:'M12 16V2m-5 5 5-5 5 5M5 11H3v11h18V11h-2',bag:'M3 8h18l-2 13H5L3 8Zm4 0 5-6 5 6',orders:'M5 3h14v18H5zM8 8h8M8 12h8M8 16h5',services:'m12 3 9 6v12H3V9l9-6Zm-3 18v-8h6v8',calendar:'M4 5h16v16H4zM8 2v6m8-6v6M4 10h16',close:'m5 5 14 14M5 19 19 5',back:'m15 4-8 8 8 8'};
export const viiIcon=name=>'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+(paths[name]||paths.bag)+'"/></svg>';
export function accountNavigation(L,{likes=false}={}){
  return '<nav class="vii-account-nav" aria-label="'+L('Tu espacio Vii','Your Vii space')+'">'+[['/cuenta?tab=orders','orders',L('Pedidos','Orders')],['/cliente?tab=services','services',L('Servicios','Services')],['/cliente?tab=agenda','calendar',L('Agenda','Schedule')],['/?likes=1','heart',L('Me gusta','Likes')]].map(([href,icon,label])=>'<a href="'+href+'" data-account-section="'+(icon==='calendar'?'agenda':icon)+'" aria-label="'+label+'" title="'+label+'" '+(likes&&icon==='heart'?'aria-current="page"':'')+'>'+viiIcon(icon)+'<span>'+label+'</span></a>').join('')+'</nav>';
}
export function mountDetailHeader({brand,href,L}){
  document.body.dataset.viiDetail=brand==='ViiShop'?'shop':brand==='ViiConcierge'?'viiconcierge':'checkout';
  const header=document.querySelector('.header');if(!header||header.querySelector('.vii-mobile-detail-back'))return;
  const back=document.createElement('a');back.className='vii-mobile-detail-back';back.href=href;back.innerHTML=viiIcon('back')+'<span>'+brand+'</span>';back.setAttribute('aria-label',L('Volver a ','Back to ')+brand);header.prepend(back);
}
export function mountPublicMenu({L,esc,signedIn=false}){
  const toggle=document.querySelector('#menu-toggle');if(!toggle||toggle.dataset.viiMenu)return;
  toggle.dataset.viiMenu='true';
  toggle.addEventListener('click',event=>{
    event.preventDefault();event.stopImmediatePropagation();
    const menu=document.createElement('dialog');menu.className='vii-menu';menu.setAttribute('aria-label',L('Menú de Vii','Vii menu'));
    menu.innerHTML='<div class="vii-dialog-heading"><h2>'+L('Menú','Menu')+'</h2><button type="button" data-close aria-label="'+L('Cerrar menú','Close menu')+'">'+viiIcon('close')+'</button></div><nav>'+[['/cliente',L('Cuenta','Account')],['/?likes=1',L('Me gusta','Likes')],['/equipo',L('Socios','Partners')],['/socios/solicitar',L('Colabora con nosotros','Partner with us')],['/privacidad',L('Privacidad y condiciones','Privacy & terms')]].map(([href,label])=>'<a href="'+href+'">'+label+'<span>›</span></a>').join('')+'</nav><div class="vii-menu-languages"><span>'+L('Idioma','Language')+'</span><button type="button" data-menu-lang="en">English</button><button type="button" data-menu-lang="es">Español</button></div><a class="vii-menu-account" href="/cliente">'+(signedIn?L('Mi cuenta','My account'):L('Iniciar sesión / Crear cuenta','Sign in / Create account'))+'</a>';
    document.body.append(menu);toggle.setAttribute('aria-expanded','true');menu.showModal();menu.querySelector('[data-close]').onclick=()=>menu.close();
    menu.querySelectorAll('[data-menu-lang]').forEach(button=>button.onclick=()=>{try{localStorage.setItem('vii-language',button.dataset.menuLang);localStorage.setItem('viicasa-prototype-language',button.dataset.menuLang);localStorage.setItem('viicasa-phase2-language',button.dataset.menuLang);}catch{}location.reload();});
    menu.addEventListener('close',()=>{toggle.setAttribute('aria-expanded','false');menu.remove();toggle.focus({preventScroll:true});},{once:true});
  },{capture:true});
}
