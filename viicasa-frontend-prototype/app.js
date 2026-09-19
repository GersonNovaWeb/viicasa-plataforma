const $ = s => document.querySelector(s);
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let lang = 'es';
try {lang = localStorage.getItem('viicasa-prototype-language') === 'en' ? 'en' : 'es';} catch { /* Storage may be unavailable. */ }
let page = location.pathname.slice(1) || 'viiconcierge';
if (!['shop','viiconcierge','viilife'].includes(page)) page = 'viiconcierge';
let active = 0, paused = reduced.matches, observer;
const copy = {
  es:{account:'Mi cuenta',label:'Descubre',prototype:'Prototipo de diseño · Fase 01',next:'Sigue explorando',restart:'Volver al inicio',pause:'Ⅱ Pausar movimiento',play:'▷ Activar movimiento',detail:'Ver propuesta',shop:'Explorar la colección',service:'Descubrir el servicio',close:'Cerrar',loginTitle:'Bienvenido a casa.',loginText:'Un espacio para tus favoritos, tus compras y todo lo que hace tu hogar.',google:'Continuar con Google',loginNote:'Acceso y creación de cuenta con Google. En este prototipo no se inicia sesión ni se guardan datos.',demo:'Vista de diseño. Imágenes y contenido de referencia; catálogo, precios y alcance por confirmar. No se realizan compras ni solicitudes.',detailAction:'Me interesa',thanks:'Así continuará tu experiencia',thanksText:'En la plataforma conectaremos este paso al detalle del producto o a la solicitud del servicio. Esta vista no envía información.',media:'Fotografía de referencia · Video pendiente',about:'Nuestra filosofía',aboutTitle:'El arte de habitar.',aboutText:'Objetos con intención. Espacios que inspiran. Cuidado que se siente. Tres maneras de vivir VIICASA.',sound:'Activar sonido',mute:'Silenciar',videoPause:'Pausar video',videoPlay:'Reproducir video'},
  en:{account:'My account',label:'Discover',prototype:'Design prototype · Phase 01',next:'Keep exploring',restart:'Back to the beginning',pause:'Ⅱ Pause motion',play:'▷ Enable motion',detail:'View concept',shop:'Explore the collection',service:'Discover the service',close:'Close',loginTitle:'Welcome home.',loginText:'A place for your favourites, your purchases and everything that makes a home.',google:'Continue with Google',loginNote:'Sign in or create an account with Google. This prototype does not sign you in or save personal data.',demo:'Design preview. Reference imagery and copy; catalogue, prices and scope to be confirmed. No purchases or requests are submitted.',detailAction:'I’m interested',thanks:'Your experience continues here',thanksText:'In the platform, this step will lead to the product details or service enquiry. This preview does not send information.',media:'Reference photograph · Video pending',about:'Our philosophy',aboutTitle:'The art of being home.',aboutText:'Objects with intention. Spaces that inspire. Care you can feel. Three ways to experience VIICASA.',sound:'Enable sound',mute:'Mute',videoPause:'Pause video',videoPlay:'Play video'}
};
// Add approved local .mp4/.webm paths to video when client media is available.
// No remote stock footage or real customer/property claims are substituted.
const scenes = {
  viiconcierge:[
    {image:'interior.png',video:null,tone:'home',es:['ViiConcierge · Presentación del hogar','Cada espacio.','Su mejor versión.','Una mirada cuidadosa. Una atmósfera extraordinaria. Tu hogar, presentado con intención.','01 / EL ESPACIO','La primera impresión empieza mucho antes de abrir la puerta.'],en:['ViiConcierge · Home presentation','Every space.','At its finest.','A thoughtful eye. An extraordinary atmosphere. Your home, presented with intention.','01 / THE SPACE','The first impression begins long before the door opens.']},
    {image:'bedroom.png',video:null,tone:'bedroom',es:['ViiConcierge · Los detalles','Nada al azar.','Todo en su lugar.','Texturas, luz y pequeños gestos que transforman la manera de percibir un espacio.','02 / LA MIRADA','Una presentación que respeta la personalidad de tu hogar.'],en:['ViiConcierge · The details','Nothing by chance.','Everything in place.','Texture, light and small gestures that transform the way a space feels.','02 / THE PERSPECTIVE','A presentation that honours the character of your home.']},
    {image:'exterior.png',video:null,tone:'home',es:['ViiConcierge · Tu proyecto','Tu hogar tiene','una historia.','Conversemos sobre tu espacio y la impresión que quieres dejar.','03 / LA CONVERSACIÓN','Cada proyecto comienza escuchando.'],en:['ViiConcierge · Your project','Your home has','a story.','Let’s talk about your space and the impression you want to leave.','03 / THE CONVERSATION','Every project begins by listening.']}
  ],
  shop:[
    {image:'objects.png',video:null,tone:'objects',es:['ViiShop · Objetos con intención','Lo extraordinario,','en lo cotidiano.','Una selección para vivir entre texturas naturales, formas honestas y detalles que importan.','01 / LA SELECCIÓN','Menos objetos. Más significado.'],en:['ViiShop · Objects with intention','Extraordinary,','every day.','A selection for a life of natural textures, honest forms and meaningful details.','01 / THE EDIT','Fewer objects. More meaning.']},
    {image:'shop.png',video:null,tone:'objects',es:['ViiShop · Rituales de casa','Pequeños gestos.','Grandes sensaciones.','Piezas para acompañar los momentos tranquilos de tu día.','02 / LOS RITUALES','El lujo de disfrutar lo sencillo.'],en:['ViiShop · Home rituals','Small gestures.','Lasting feelings.','Pieces to accompany the quieter moments of your day.','02 / THE RITUALS','The luxury of enjoying simple things.']},
    {image:'bedroom.png',video:null,tone:'bedroom',es:['ViiShop · Texturas','Una forma más suave','de terminar el día.','Descubre el lenguaje de los textiles y los tonos que hacen sentir en casa.','03 / LAS TEXTURAS','Una propuesta de colección, por descubrir.'],en:['ViiShop · Textures','A softer way','to end the day.','Discover the language of textiles and tones that feel like home.','03 / THE TEXTURES','A collection concept, waiting to be discovered.']}
  ],
  viilife:[
    {image:'life.png',video:null,tone:'home',es:['ViiLife · Limpieza del hogar','Más tiempo','para vivir.','El cuidado de tu hogar, pensado para que puedas dedicarte a lo que realmente importa.','01 / EL EQUILIBRIO','Un hogar cuidado. Una vida más ligera.'],en:['ViiLife · Home cleaning','More time','for living.','Thoughtful home care, so you can focus on what truly matters.','01 / THE BALANCE','A cared-for home. A lighter life.']},
    {image:'bedroom.png',video:null,tone:'bedroom',es:['ViiLife · Cuidado de ropa','La calma está','en los detalles.','Lavado y cuidado de ropa y textiles para acompañar el ritmo de tu hogar.','02 / EL CUIDADO','Lo cotidiano también merece atención.'],en:['ViiLife · Laundry care','Calm lives','in the details.','Laundry and textile care that fits the rhythm of your home.','02 / THE CARE','Everyday things deserve attention too.']},
    {image:'interior.png',video:null,tone:'home',es:['ViiLife · Preparación del hogar','Llegar. Respirar.','Sentirte en casa.','Orden y preparación para encontrar tus espacios listos para disfrutar.','03 / LA BIENVENIDA','El placer de volver a un hogar preparado.'],en:['ViiLife · Home preparation','Arrive. Breathe.','Feel at home.','Thoughtful preparation, so your spaces are ready to enjoy.','03 / THE WELCOME','The pleasure of coming home to a space that is ready.']}
  ]
};
const t = key => copy[lang][key];
const feed = $('#feed'), dialog = $('#detail');
function setMediaState(){
  document.body.classList.toggle('paused',paused);
  $('#motion').textContent=t(paused?'play':'pause');
  $('#motion').setAttribute('aria-pressed',String(paused));
  document.querySelectorAll('video').forEach(v=>{if(Number(v.dataset.index)===active&&!paused&&!v.dataset.userPaused){v.play().catch(()=>{});}else v.pause();});
}
function activate(index){
  active=index;
  document.querySelectorAll('.scene').forEach((s,i)=>s.classList.toggle('active',i===index));
  document.querySelectorAll('#dots button').forEach((b,i)=>b.setAttribute('aria-current',String(i===index)));
  $('#next').innerHTML=`${t(index===2?'restart':'next')} <span aria-hidden="true">${index===2?'↑':'↓'}</span>`;
  setMediaState();
}
function go(index){document.querySelectorAll('.scene')[index].scrollIntoView({behavior:reduced.matches?'instant':'smooth',block:'start'});}
function show(markup){$('#detail-content').innerHTML=markup;$('#close').ariaLabel=t('close');dialog.setAttribute('aria-label', $('#detail-content h2').textContent);dialog.showModal();document.querySelectorAll('video').forEach(v=>v.pause());document.body.classList.add('paused');}
function detail(index){const s=scenes[page][index], c=s[lang];show(`<div class="detail-label">${c[0]}</div><h2>${c[1]} ${c[2]}</h2><p>${c[3]}</p><img src="/assets/${s.image}" alt="${c[0]}"><button class="primary" id="interest">${t('detailAction')} <span>↗</span></button><p class="demo-note">${t('demo')}</p>`);$('#interest').onclick=()=>{$('#detail-content').innerHTML=`<div class="detail-label">VIICASA</div><h2>${t('thanks')}</h2><p>${t('thanksText')}</p><p class="demo-note">${t('demo')}</p>`;$('#close').focus();};}
function render(){
  observer?.disconnect();document.documentElement.lang=lang;document.title=`${{shop:'ViiShop',viilife:'ViiLife',viiconcierge:'ViiConcierge'}[page]} — VIICASA`;
  $('#navigation').innerHTML=['shop','viiconcierge','viilife'].map(p=>`<a href="/${p}" ${p===page?'aria-current="page"':''}>${{shop:'ViiShop',viiconcierge:'ViiConcierge',viilife:'ViiLife'}[p]}</a>`).join('');
  $('#navigation').ariaLabel=lang==='es'?'Servicios':'Services';$('.rail').ariaLabel=lang==='es'?'Secciones':'Sections';$('.skip').textContent=lang==='es'?'Ir al contenido':'Skip to content';feed.ariaLabel=lang==='es'?'Explorar servicios':'Explore services';$('#account').textContent=t('account');$('#rail-label').textContent=t('label');$('#prototype').textContent=t('prototype');
  document.querySelectorAll('[data-language]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.language===lang)));
  feed.innerHTML=scenes[page].map((s,i)=>{const c=s[lang];return `<section class="scene" data-tone="${s.tone}" aria-labelledby="title-${i}"><div class="visual"><img src="/assets/${s.image}" alt="" ${i===0?'fetchpriority="high"':'loading="lazy"'}>${s.video?`<video data-index="${i}" src="${s.video}" poster="/assets/${s.image}" muted loop playsinline preload="none" aria-label="${c[0]}"></video>`:''}</div><div class="scene-copy"><p class="eyebrow">${c[0]}</p><${i===0?'h1':'h2'} id="title-${i}">${c[1]}<br><em>${c[2]}</em></${i===0?'h1':'h2'}><p class="description">${c[3]}</p><div class="cta-row"><button class="primary" data-detail="${i}">${t(page==='shop'?'shop':'service')}<span aria-hidden="true">↗</span></button><button class="text-link" data-about>${t('about')}</button></div></div><div class="scene-caption"><strong>${c[4]}</strong>${c[5]}</div>${s.video?`<div class="media-buttons"><button data-video-pause="${i}">${t('videoPause')}</button><button data-sound="${i}">${t('sound')}</button></div>`:''}</section>`;}).join('');
  $('#dots').innerHTML=scenes[page].map((_,i)=>`<button aria-label="${lang==='es'?'Sección':'Section'} ${i+1}" data-go="${i}">0${i+1}</button>`).join('');
  document.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>go(Number(b.dataset.go)));
  document.querySelectorAll('[data-detail]').forEach(b=>b.onclick=()=>detail(Number(b.dataset.detail)));
  document.querySelectorAll('[data-about]').forEach(b=>b.onclick=()=>show(`<div class="detail-label">VIICASA</div><h2>${t('aboutTitle')}</h2><p>${t('aboutText')}</p><p class="demo-note">${t('media')}</p>`));
  document.querySelectorAll('video').forEach(v=>{v.muted=true;v.onplay=()=>{const b=document.querySelector(`[data-video-pause="${v.dataset.index}"]`);if(b)b.textContent=t('videoPause');};v.onpause=()=>{const b=document.querySelector(`[data-video-pause="${v.dataset.index}"]`);if(b)b.textContent=t('videoPlay');};v.onerror=()=>{v.hidden=true;};});
  document.querySelectorAll('[data-sound]').forEach(b=>b.onclick=()=>{const v=document.querySelector(`video[data-index="${b.dataset.sound}"]`);v.muted=!v.muted;b.textContent=t(v.muted?'sound':'mute');});
  document.querySelectorAll('[data-video-pause]').forEach(b=>b.onclick=()=>{const v=document.querySelector(`video[data-index="${b.dataset.videoPause}"]`);if(v.paused){delete v.dataset.userPaused;v.play().catch(()=>{});}else{v.dataset.userPaused='true';v.pause();}});
  activate(active);feed.scrollTo({top:document.querySelectorAll('.scene')[active].offsetTop,behavior:'instant'});
  observer=new IntersectionObserver(entries=>{for(const e of entries){if(e.isIntersecting&&e.intersectionRatio>=.5)activate([...feed.children].indexOf(e.target));}},{root:feed,threshold:[.5,.7]});[...feed.children].forEach(s=>observer.observe(s));
}
document.querySelectorAll('[data-language]').forEach(b=>b.onclick=()=>{lang=b.dataset.language;try{localStorage.setItem('viicasa-prototype-language',lang);}catch{/* optional storage */}render();});
$('#account').onclick=()=>{show(`<div class="detail-label">VIICASA · ${t('account')}</div><h2>${t('loginTitle')}</h2><p>${t('loginText')}</p><button class="primary google" id="google"><b aria-hidden="true">G</b>${t('google')}</button><p class="demo-note" id="login-note">${t('loginNote')}</p>`);$('#google').onclick=()=>{$('#login-note').setAttribute('role','status');$('#login-note').textContent=t('loginNote');$('#login-note').style.fontWeight='600';};};
$('#close').onclick=()=>dialog.close();dialog.addEventListener('close',setMediaState);
$('#next').onclick=()=>go((active+1)%3);$('#motion').onclick=()=>{paused=!paused;setMediaState();};
feed.addEventListener('keydown',e=>{if(e.target!==feed)return;if(['ArrowDown','PageDown','ArrowUp','PageUp','Home','End'].includes(e.key)){e.preventDefault();go(e.key==='Home'?0:e.key==='End'?2:Math.min(2,Math.max(0,active+(['ArrowDown','PageDown'].includes(e.key)?1:-1))));}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)document.querySelectorAll('video').forEach(v=>v.pause());else if(!dialog.open)setMediaState();});
reduced.addEventListener('change',()=>{paused=reduced.matches;setMediaState();});
render();
