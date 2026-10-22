// The same published catalogue powers the mixed home and all three brand feeds.
import {installFeedControls} from './feed-controls.js';
import {accountNavigation,mountPublicMenu,viiIcon} from './vii-ui.js';
import {openIntent} from './vii-intent.js';
import {tileMarkup} from './vii-tiles.js';
import {stayPreferences,stayHref} from './vii-stay.js';
import {viiHeroMarkup,mountViiHero} from './vii-hero.js';
import {sampleProductGallery} from './sample-product-gallery.js';
import {waitlistMarkup,bindWaitlists,mountLaunchUI} from './launch-ui.js';
export const brandPath={home:'/',shop:'/shop',viilife:'/viilife',viiconcierge:'/viiconcierge'};
export const interleave=groups=>Array.from({length:Math.max(0,...groups.map(x=>x.length))},(_,i)=>groups.map(x=>x[i]).filter(Boolean)).flat();
export function cadProductSummary(variants=[]){
  const priced=(Array.isArray(variants)?variants:[]).filter(v=>v&&v.active!==false).map(v=>({stock:v.stock,price:v.prices?.CAD??(v.currency==='CAD'?v.price_minor:null)})).filter(v=>Number.isSafeInteger(v.price)&&v.price>0);
  return{amount:priced.length?Math.min(...priced.map(v=>v.price)):null,available:priced.some(v=>v.stock>0)};
}
export function restoreFeedFilters(value){
  const text=key=>typeof value?.[key]==='string'?value[key].slice(0,200):'';
  const bound=key=>value?.[key]!==''&&value?.[key]!=null&&Number.isFinite(Number(value[key]))&&Number(value[key])>=0?String(value[key]):'';
  return{q:text('q'),category:text('category'),sort:['price','newest'].includes(value?.sort)?value.sort:'recommended',available:value?.available===true,min:bound('min'),max:bound('max'),...stayPreferences(value)};
}
export function filterTiles(items,{q='',category='',available=false,sort='recommended',min='',max='',guests=1}={}){
  const needle=q.trim().toLocaleLowerCase();
  const result=items.filter(x=>(!needle||(x.title+' '+x.description+' '+x.category).toLocaleLowerCase().includes(needle))&&(!category||x.category===category)&&(!available||x.available)&&(!x.key?.startsWith('property:')||!x.capacity||x.capacity>=guests)&&(min===''||x.amount!==null&&x.amount>=Number(min)*100)&&(max===''||x.amount!==null&&x.amount<=Number(max)*100));
  if(sort==='price')result.sort((a,b)=>(a.amount??Infinity)-(b.amount??Infinity));
  if(sort==='newest')result.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
  return result;
}
const hasFilters=f=>Boolean(f.q||f.category||f.available||f.min||f.max||f.checkIn||f.checkOut||f.guests>1);
const feedCleanups=new WeakMap();
export async function prepareViiFeed({api,pathname}){
  const brand=pathname==='/shop'?'shop':pathname==='/viilife'?'viilife':pathname==='/viiconcierge'?'viiconcierge':null;
  const requested=[!brand||brand==='shop',!brand||brand==='viiconcierge',!brand||brand==='viilife'||brand==='viiconcierge'];
  const sources=await Promise.allSettled(['/products?limit=100','/properties?limit=100','/service-catalogue'].map((path,index)=>requested[index]?api(path):Promise.resolve(null)));
  const products=sources[0].value?.items||[],properties=sources[1].value?.items||[],services=sources[2].value?.items||[];
  // Bounded hydration supplies real CAD prices, not invented placeholder amounts.
  for(let start=0;start<Math.min(products.length,12);start+=4)await Promise.all(products.slice(start,start+4).map(async p=>{if(p.variants)return;try{p.variants=(await api('/products/'+encodeURIComponent(p.slug))).variants;}catch{}}));
  let liked=[],signedIn=false;try{liked=(await api('/client/likes')).items.map(x=>x.item_key);signedIn=true;}catch{/* A guest can browse without authentication. */}
  return{brand,requested,sources,products,properties,services,liked,signedIn};
}
export async function warmViiImages(prepared,{ImageClass=globalThis.Image,timeout=900}={}){
  if(!ImageClass)return;
  const paths=[...(prepared.brand===null?['/assets/exterior.png']:[]),...prepared.properties.slice(0,2).map(x=>x.images?.[0]),...prepared.products.slice(0,2).map(x=>x.images?.[0]),...prepared.services.slice(0,2).map(x=>x.images?.[0])].filter(x=>typeof x==='string'&&(/^https:\/\//.test(x)||/^\/(assets|v1\/media)\//.test(x))).slice(0,5);
  let timer;try{await Promise.race([Promise.allSettled(paths.map(async src=>{const image=new ImageClass();image.src=src;if(image.decode)await image.decode();})),new Promise(resolve=>{timer=setTimeout(resolve,timeout);})]);}finally{clearTimeout(timer);}
}
export async function renderViiFeed({api,frame,L,esc,money,settings,lang,prepared}){
  prepared||=await prepareViiFeed({api,pathname:location.pathname});
  const {brand,requested,sources,products,properties,services}=prepared;
  const likesOnly=new URLSearchParams(location.search).get('likes')==='1',showHero=!brand&&!likesOnly;
  const text=v=>{if(typeof v==='object')return v?.[lang]||v?.en||'';const parts=String(v||'').split('\n[EN]\n');if(parts.length>1)return parts[lang==='en'?1:0];const pair=parts[0].split(' / ');return lang==='en'?pair.at(-1):pair[0];};
  const url=v=>/^https:\/\//.test(v)||/^\/(assets|v1\/media)\//.test(v)?v:'';
  const shop=products.map(p=>({createdAt:p.created_at,key:'product:'+p.id,brand:'shop',category:text(p.category),title:text(p.name),description:text(p.description),image:url(sampleProductGallery(p,p.images||[],settings.demo||p.is_demo)[0]),href:'/shop/'+p.slug,action:L('Comprar','Shop'),...cadProductSummary(p.variants)}));
  const concierge=properties.map(p=>({key:'property:'+p.id,capacity:p.capacity,brand:'viiconcierge',category:L('Estancias','Stays'),title:text(p.name),description:text(p.location),image:url(p.images?.[0]),href:'/viiconcierge/'+p.slug,action:L('Reservar','Reserve'),amount:p.rates?.CAD?.nightly_minor??(p.currency==='CAD'?p.nightly_minor:null),basis:L('por noche · total al elegir fechas','per night · total after choosing dates'),available:true}));
  const serviceTiles=services.flatMap(s=>s.channels.map(channel=>({key:'service:'+s.id,brand:channel,category:text(sources[2].value.families.find(f=>f.id===s.family)?.name),title:text(channel==='viiconcierge'?s.concierge_name:s.name),description:text(s.description),image:url(s.images[0]),video:s.id==='home-cleaning'?'/assets/limpieza-hero-web.mp4':null,href:s.href||'/servicios/'+s.id+'?channel='+channel,action:s.pricing.kind==='quote'?L('Solicitar cotización','Request a quote'):L('Reservar','Book'),amount:s.pricing.amount_minor,basis:s.pricing.kind==='fixed'?L('por ','per ')+({hour:L('hora','hour'),service:L('servicio','service'),visit:L('visita','visit'),load:L('carga','load'),item:L('pieza','item')})[s.pricing.basis]:'',available:s.pricing.kind==='fixed'})));
  const life=serviceTiles.filter(x=>x.brand==='viilife'),conciergeFeed=interleave([concierge,serviceTiles.filter(x=>x.brand==='viiconcierge')]);
  let items=brand==='shop'?shop:brand==='viilife'?life:brand==='viiconcierge'?conciergeFeed:interleave([conciergeFeed,life,shop]);
  const seen=new Set();items=items.filter(x=>{if(seen.has(x.key))return false;seen.add(x.key);return true;});
  const scroller=document.querySelector('#feed');feedCleanups.get(scroller)?.();delete scroller.dataset.restoreScroll;
  document.body.classList.remove('vii-scrolling-down');
  document.title=(brand?{shop:'ViiShop',viilife:'ViiLife',viiconcierge:'ViiConcierge'}[brand]:'Vii · The art of being home')+' — VII';
  frame((showHero?viiHeroMarkup({L}):'')+'<section class="vii-feed-shell">'+(showHero?'<div class="vii-discover-heading"><p>'+L('EL UNIVERSO Vii','THE Vii WORLD')+'</p><h2 id="vii-discover" tabindex="-1">'+L('Encuentra tu próxima inspiración.','Find your next inspiration.')+'</h2></div>':'')+(brand?'<div class="vii-search-wrap"><button class="vii-search" id="intent-open">'+viiIcon('search')+' '+(brand==='viiconcierge'?L('¿A dónde?','Where to?'):L('Buscar en ','Search ')+{shop:'ViiShop',viilife:'ViiLife'}[brand])+'</button><button type="button" id="clear-intent" aria-label="'+L('Limpiar filtros','Clear filters')+'" hidden>×</button></div>':'')+'<div class="vii-tiles" id="vii-tiles"></div><p id="feed-result" role="status"></p></section>');
  document.body.classList.add('vii-experience');document.body.dataset.viiBrand=brand||'home';
  if(!showHero&&!likesOnly)document.querySelector('.vii-feed-shell').insertAdjacentHTML('afterbegin','<h1 class="vii-sr-only">'+(brand?{shop:'ViiShop',viilife:'ViiLife',viiconcierge:'ViiConcierge'}[brand]:'Vii · The art of being home')+'</h1>');
  document.querySelector('#navigation').innerHTML=Object.entries(brandPath).map(([key,path])=>'<a href="'+path+'" '+((brand||'home')===key?'aria-current="page"':'')+'>'+{home:'Vii',shop:'ViiShop',viilife:'ViiLife',viiconcierge:'ViiConcierge'}[key]+'</a>').join('');
  const feed=document.querySelector('#feed');feed.classList.add('vii-scroller');
  const liked=new Set(prepared.liked),signedIn=prepared.signedIn;
  document.body.dataset.viiView=likesOnly?'likes':'feed';
  if(likesOnly)items=items.filter(x=>liked.has(x.key));
  document.querySelector('.vii-feed-shell').insertAdjacentHTML('beforeend',accountNavigation(L,{likes:likesOnly}));
  mountPublicMenu({L,esc,signedIn});
  if(likesOnly)document.querySelector('.vii-feed-shell').insertAdjacentHTML('afterbegin','<h1 class="vii-likes-heading">'+L('Me gusta','Likes')+'</h1>'+(!signedIn?'<p>'+L('Inicia sesión para ver y guardar tus favoritos.','Sign in to view and save your favourites.')+' <a class="vii-cta" href="/cliente">'+L('Iniciar sesión','Sign in')+'</a></p>':''));
  const safeRead=key=>{try{return JSON.parse(sessionStorage.getItem(key)||'null');}catch{return null;}};
  let filters=restoreFeedFilters(brand&&new URLSearchParams(location.search).has('return')?safeRead('vii-filters:'+brand):null);
  let mediaObserver,heroCleanup;
  feedCleanups.set(feed,()=>{mediaObserver?.disconnect();heroCleanup?.();});
  const draw=()=>{
    mediaObserver?.disconnect();
    const visible=filterTiles(items,filters);
    const grid=document.querySelector('#vii-tiles');grid.classList.toggle('vii-results',hasFilters(filters)||likesOnly);
    grid.innerHTML=visible.map((x,i)=>tileMarkup(x.key.startsWith('property:')?{...x,href:stayHref(x.href,filters)}:x,{index:i,home:!brand&&!likesOnly,liked:liked.has(x.key),L,esc,money})).join('')||'<section class="vii-feed-empty"><h2>'+L('Algo especial está por llegar.','Something special is on its way.')+'</h2><p>'+L('Prueba otra búsqueda o descubre otra sección.','Try another search or discover another section.')+'</p><button class="vii-cta" type="button" id="empty-clear">'+L('Limpiar filtros','Clear filters')+'</button></section>';
    document.querySelector('#empty-clear')?.addEventListener('click',()=>applyFilters({q:'',category:'',sort:'recommended',available:false}));
    document.querySelector('#feed-result').textContent=sources.filter((_,index)=>requested[index]).every(x=>x.status==='rejected')?L('No pudimos cargar el catálogo. Recarga para reintentar.','We could not load the catalogue. Reload to retry.'):'';
    document.querySelectorAll('.vii-tile a').forEach(a=>a.addEventListener('click',()=>{const tile=a.closest('.vii-tile');try{sessionStorage.setItem('vii-position:'+tile.dataset.brand,JSON.stringify({key:tile.dataset.item,top:feed.scrollTop,path:location.pathname}));}catch{}}));
    document.querySelectorAll('[data-like]').forEach(b=>b.onclick=async()=>{try{const isLiked=!liked.has(b.dataset.like);await api('/client/likes',{method:'PUT',body:{item_key:b.dataset.like,liked:isLiked}});isLiked?liked.add(b.dataset.like):liked.delete(b.dataset.like);b.setAttribute('aria-pressed',String(isLiked));b.innerHTML=viiIcon('heart');}catch(error){if(error.status===401)location.assign('/cliente');else document.querySelector('#feed-result').textContent=error.message;}});
    document.querySelectorAll('[data-share]').forEach(b=>b.onclick=async()=>{try{const shareUrl=new URL(b.dataset.share,location.origin).href;if(navigator.share)await navigator.share({url:shareUrl});else{await navigator.clipboard.writeText(shareUrl);b.textContent='✓';}}catch{/* Cancelled share does not navigate. */}});
    mediaObserver=new IntersectionObserver(entries=>{for(const {target,isIntersecting} of entries){const video=target.querySelector('video');if(!video)continue;if(isIntersecting&&!matchMedia('(prefers-reduced-motion: reduce)').matches){if(!video.src)video.src=video.dataset.feedVideo;video.play().catch(()=>{});}else video.pause();}},{root:feed,rootMargin:'100px',threshold:.25});
    document.querySelectorAll('.vii-tile').forEach(tile=>mediaObserver.observe(tile));
  };
  const applyFilters=value=>{filters=restoreFeedFilters(value);try{sessionStorage.setItem('vii-filters:'+brand,JSON.stringify(filters));}catch{}draw();const active=hasFilters(filters),button=document.querySelector('#intent-open');if(button){const count=[filters.available,filters.min,filters.max].filter(Boolean).length;button.innerHTML=viiIcon('search')+'<span>'+esc([filters.q,filters.category,filters.checkIn&&[filters.checkIn,filters.checkOut].filter(Boolean).join(' → '),filters.guests>1?filters.guests+' '+L('huéspedes','guests'):'',count?count+' '+L('filtros','filters'):''].filter(Boolean).join(' · ')||(brand==='viiconcierge'?L('¿A dónde?','Where to?'):L('Buscar en ','Search ')+{shop:'ViiShop',viilife:'ViiLife'}[brand]))+'</span>';document.querySelector('#clear-intent').hidden=!active;}feed.scrollTo({top:0,behavior:'instant'});};
  draw();
  if(brand&&!items.length&&!likesOnly&&!hasFilters(filters)&&sources[brand==='shop'?0:brand==='viiconcierge'?1:2].status==='fulfilled'){
    document.querySelector('#vii-tiles').insertAdjacentHTML('beforeend',waitlistMarkup(brand,{L}));bindWaitlists({api,L});
  }
  mountLaunchUI({api,L,esc});
  if(brand&&hasFilters(filters))applyFilters(filters);
  const restored=brand&&new URLSearchParams(location.search).has('return')&&safeRead('vii-position:'+brand);
  if(restored){const tile=[...document.querySelectorAll('[data-item]')].find(x=>x.dataset.item===restored.key);if(tile){const top=restored.path===location.pathname?restored.top:Math.max(0,tile.offsetTop-document.querySelector('.header').getBoundingClientRect().height-20);feed.dataset.restoreScroll=String(top);feed.scrollTo({top,behavior:'instant'});}}
  if(brand){
    document.querySelector('#intent-open').addEventListener('pointerdown',event=>{event.preventDefault();event.currentTarget.focus({preventScroll:true});});
    document.querySelector('#intent-open').onclick=()=>openIntent({brand,items,filters,filterTiles,onApply:applyFilters,feed,L,esc});
    document.querySelector('#clear-intent').onclick=()=>applyFilters({q:'',category:'',sort:'recommended',available:false,min:'',max:''});
  }
  if(likesOnly){
    const heading=document.querySelector('.vii-likes-heading');heading.insertAdjacentHTML('afterend','<div class="vii-like-tabs" role="group" aria-label="'+L('Tipos de favoritos','Favourite types')+'">'+[['',L('Todo','All')],['product:',L('Artículos','Items')],['property:',L('Destinos','Destinations')],['service:',L('Servicios','Services')]].map(([value,title])=>'<button type="button" data-likes-kind="'+value+'" aria-pressed="'+(!value)+'">'+title+'</button>').join('')+'</div>');
    const all=items;document.querySelectorAll('[data-likes-kind]').forEach(button=>button.onclick=()=>{items=all.filter(x=>x.key.startsWith(button.dataset.likesKind));document.querySelectorAll('[data-likes-kind]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));draw();});
  }
  installFeedControls(feed,document.body);
  if(showHero)heroCleanup=mountViiHero({feed});
  document.querySelector('#navigation')?.querySelectorAll('a').forEach(a=>a.setAttribute('aria-current',a.getAttribute('href')===brandPath[brand||'home']?'page':'false'));
}
