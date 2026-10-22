import {scrollFeedTo} from './scroll-navigation.js';
import {mountHeroSlider} from './vii-hero-slider.js';

export const heroSlides=[['exterior.png','Vii'],['vii-hero-shop.png','ViiShop'],['vii-hero-life.png','ViiLife'],['vii-hero-concierge.png','ViiConcierge']];

export function viiHeroMarkup({L}){
  return '<section class="vii-home-hero" aria-labelledby="vii-hero-title" aria-roledescription="'+L('carrusel','carousel')+'">'+
    '<div class="vii-hero-media" aria-hidden="true">'+heroSlides.map(([file],i)=>'<img class="vii-hero-image'+(!i?' is-active':'')+'" data-hero-image '+(!i?'src="/assets/'+file+'" fetchpriority="high"':'data-src="/assets/'+file+'"')+' width="1376" height="768" alt="" decoding="async">').join('')+'</div>'+
    '<div class="vii-hero-content"><p class="vii-hero-eyebrow">THE ART OF BEING HOME</p>'+
    '<h1 id="vii-hero-title">'+L('Más que un lugar.','More than a place.')+'<br><em>'+L('Una forma de vivir.','A way to live.')+'</em></h1>'+
    '<p class="vii-hero-description">'+L('Estancias que inspiran. Objetos con intención. Cuidado para tu hogar. Todo en un mismo universo.','Inspiring stays. Objects with intention. Care for your home. All in one place.')+'</p>'+
    '<a class="vii-hero-discover" href="#vii-discover">'+L('Descubrir Vii','Discover Vii')+'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 4v16m-6-6 6 6 6-6"/></svg></a></div>'+
    '<div class="vii-hero-slider-controls"><span class="vii-hero-caption" data-hero-caption>01 / 04 · Vii</span><div class="vii-hero-dots" role="group" aria-label="'+L('Imágenes del hero','Hero images')+'">'+heroSlides.map(([,label],i)=>'<button type="button" data-hero-slide="'+i+'" data-label="'+label+'" aria-label="'+L('Ver imagen de ','Show image for ')+label+'" aria-pressed="'+(!i)+'"><span></span></button>').join('')+'</div><button class="vii-hero-pause" type="button" data-hero-pause data-play-label="'+L('Reproducir imágenes','Play slideshow')+'" data-pause-label="'+L('Pausar imágenes','Pause slideshow')+'" aria-label="'+L('Pausar imágenes','Pause slideshow')+'" aria-pressed="false"><svg class="vii-pause-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5v10M13 5v10"/></svg><svg class="vii-play-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m7 5 8 5-8 5z"/></svg></button></div>'+
    '<nav class="vii-hero-brands" aria-label="'+L('Descubre nuestras marcas','Discover our brands')+'">'+
    [['/shop','ViiShop',L('Objetos para vivir','Objects for living')],['/viilife','ViiLife',L('Cuidado del hogar','Care for your home')],['/viiconcierge','ViiConcierge',L('Estancias y hospitalidad','Stays & hospitality')]].map(([href,name,label])=>'<a href="'+href+'"><span>'+name+' <span aria-hidden="true">↗</span></span><small>'+label+'</small></a>').join('')+'</nav></section>';
}

export function mountViiHero({feed,doc=document,win=window}){
  const link=doc.querySelector('.vii-hero-discover'),target=doc.querySelector('#vii-discover');
  if(!link||!target||link.dataset.viiScroll)return;
  link.dataset.viiScroll='true';
  link.addEventListener('click',event=>{
    if(event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
    event.preventDefault();
    // Focus without browser scrolling, then align inside the actual scroller, not the body.
    target.focus({preventScroll:true});
    const offset=(doc.querySelector('.header')?.getBoundingClientRect().height||0)+20;
    scrollFeedTo(feed,target.closest?.('.vii-discover-heading')||target,{offset,behavior:win.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  });
  return mountHeroSlider({hero:doc.querySelector('.vii-home-hero'),doc,win});
}
