const motionQuery='(prefers-reduced-motion: reduce)';
export const reducedMotion=win=>win.matchMedia(motionQuery).matches;
export function containedRect(box,width,height){
  if(!width||!height||!box.width||!box.height)return box;
  const scale=Math.min(box.width/width,box.height/height),w=width*scale,h=height*scale;
  return{left:box.left+(box.width-w)/2,top:box.top+(box.height-h)/2,width:w,height:h};
}
export function imageTransform(from,to){
  return `translate(${from.left-to.left}px, ${from.top-to.top}px) scale(${from.width/to.width}, ${from.height/to.height})`;
}
export async function animateSafely(element,frames,{win=window,duration=380}={}){
  if(reducedMotion(win)||!element?.animate)return;
  let animation,timer;
  try{
    animation=element.animate(frames,{duration,easing:'cubic-bezier(.22,.75,.25,1)',fill:'both'});
    await Promise.race([animation.finished,new Promise(resolve=>{timer=win.setTimeout(resolve,duration+100);})]);
  }catch{/* A cancelled or unsupported effect never blocks closing or navigation. */}
  finally{win.clearTimeout(timer);animation?.cancel();}
}
export async function flyPhoto({image,from,to,parent,win=window,doc=document}){
  if(reducedMotion(win)||!image?.src||!from?.width||!to?.width||!from.height||!to.height)return;
  const clone=doc.createElement('img');clone.src=image.currentSrc||image.src;clone.alt='';clone.setAttribute('aria-hidden','true');clone.className='vii-photo-flight';
  Object.assign(clone.style,{left:to.left+'px',top:to.top+'px',width:to.width+'px',height:to.height+'px'});
  parent.append(clone);
  try{await animateSafely(clone,[{transform:imageTransform(from,to),borderRadius:'14px'},{transform:'none',borderRadius:'6px'}],{win,duration:420});}
  finally{clone.remove();}
}

const itemKey='vii-item-motion';
export const isItemPath=path=>/^\/(shop|viiconcierge)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path);
export function validateItemContext(value,{pathname,width,now=Date.now()}){
  if(!value||value.to!==pathname||!isItemPath(pathname)||!Number.isFinite(value.at)||now-value.at<0||now-value.at>300000||Math.abs(value.width-width)>80)return null;
  const r=value.rect;if(!r||!['left','top','width','height'].every(k=>Number.isFinite(r[k]))||r.width<=0||r.height<=0||r.width>10000||r.height>10000)return null;
  return value;
}
export function installItemMotion({doc=document,win=window}={}){
  if(doc.documentElement.dataset.itemMotionInstalled)return;
  doc.documentElement.dataset.itemMotionInstalled='true';
  win.addEventListener?.('pageshow',event=>{if(event.persisted){doc.querySelectorAll('.gallery').forEach(gallery=>delete gallery.dataset.leaving);doc.querySelectorAll('.vii-photo-flight').forEach(image=>image.remove());}});
  doc.addEventListener('click',event=>{
    if(event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||reducedMotion(win))return;
    const link=event.target.closest?.('.vii-tile a,.property-card a,.vii-mobile-detail-back,.property-detail>.back-link,.page-wrap>.back-link');
    if(!link||link.target&&link.target!=='_self'||link.hasAttribute('download'))return;
    const url=new URL(link.href,win.location.href);if(url.origin!==win.location.origin)return;
    const card=link.closest('.vii-tile,.property-card'),image=card?.querySelector('.vii-tile-media img,.property-photo img');
    if(image&&isItemPath(url.pathname)&&!url.searchParams.has('buy')){
      const rect=image.getBoundingClientRect();
      try{win.sessionStorage.setItem(itemKey,JSON.stringify({to:url.pathname,from:win.location.pathname,at:Date.now(),width:win.innerWidth,rect:{left:rect.left,top:rect.top,width:rect.width,height:rect.height}}));}catch{}
      // Real links retain native navigation, modified clicks and browser history.
      void animateSafely(image,[{transform:'scale(1)'},{transform:'scale(1.045)'}],{win,duration:150});return;
    }
    if(!card&&isItemPath(win.location.pathname)){
      const gallery=doc.querySelector('.gallery');if(!gallery||gallery.dataset.leaving)return;
      event.preventDefault();gallery.dataset.leaving='true';
      void animateSafely(gallery,[{transform:'scale(1)',opacity:1},{transform:'scale(.94)',opacity:.35}],{win,duration:230}).finally(()=>win.location.assign(url.href));
    }
  });
}
export async function revealItemGallery({gallery,doc=document,win=window}){
  if(!gallery||gallery.dataset.itemRevealed)return;gallery.dataset.itemRevealed='true';
  if(reducedMotion(win))return;
  let value;try{value=JSON.parse(win.sessionStorage.getItem(itemKey)||'null');win.sessionStorage.removeItem(itemKey);}catch{}
  const context=validateItemContext(value,{pathname:win.location.pathname,width:win.innerWidth}),image=gallery.querySelector('img');
  if(!image)return;
  await new Promise(resolve=>win.requestAnimationFrame(()=>win.requestAnimationFrame(resolve)));
  if(!gallery.isConnected)return;
  if(context&&image.complete&&image.naturalWidth){
    const target=image.getBoundingClientRect();
    image.style.visibility='hidden';
    try{await flyPhoto({image,from:context.rect,to:target,parent:doc.body,win,doc});}finally{image.style.visibility='';}
  }else await animateSafely(gallery,[{transform:'translateY(14px) scale(.97)',opacity:.45},{transform:'none',opacity:1}],{win,duration:420});
}
