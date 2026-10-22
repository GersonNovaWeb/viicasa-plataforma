// One timer per mounted hero. No autoplay when motion, visibility or focus says stop.
export function createHeroRotation({count,show,changed=()=>{},schedule=setTimeout,cancel=clearTimeout,delay=7000}){
  let current=0,timer=null,stopped=false,busy=false,revision=0;
  const blockers=new Set();
  const clear=()=>{if(timer!==null)cancel(timer);timer=null;};
  const arm=()=>{clear();if(!stopped&&!busy&&!blockers.size)timer=schedule(()=>go(current+1),delay);};
  async function go(index){
    if(stopped||busy)return false;
    const next=((index%count)+count)%count,version=++revision;
    clear();if(next===current){arm();return true;}busy=true;
    try{if(await show(next)!==false&&!stopped&&version===revision){current=next;changed(current);return true;}return false;}
    catch{return false;}finally{busy=false;arm();}
  }
  return{go,block(reason,value){value?blockers.add(reason):blockers.delete(reason);arm();},start:arm,destroy(){stopped=true;revision++;clear();},get current(){return current;}};
}

export function mountHeroSlider({hero,doc=globalThis.document,win=globalThis.window}){
  if(!hero?.querySelectorAll)return()=>{};
  const images=[...hero.querySelectorAll('[data-hero-image]')],dots=[...hero.querySelectorAll('[data-hero-slide]')],toggle=hero.querySelector('[data-hero-pause]'),caption=hero.querySelector('[data-hero-caption]');
  if(images.length!==4||!toggle)return()=>{};
  const motion=win.matchMedia('(prefers-reduced-motion: reduce)'),listeners=[];
  let alive=true,paused=false,decodeTimeout;
  const listen=(node,type,handler)=>{node.addEventListener(type,handler);listeners.push(()=>node.removeEventListener(type,handler));};
  const rotation=createHeroRotation({count:images.length,schedule:win.setTimeout.bind(win),cancel:win.clearTimeout.bind(win),show:async index=>{
    const image=images[index];
    if(!image.getAttribute('src'))image.src=image.dataset.src;
    // Keep the previous image visible until the next one is actually decoded.
    if(image.decode){try{await Promise.race([image.decode(),new Promise((_,reject)=>{decodeTimeout=win.setTimeout(()=>reject(new Error('Image unavailable')),8000);})]);}finally{win.clearTimeout(decodeTimeout);decodeTimeout=undefined;}}
    if(!alive)return false;
    images.forEach((item,i)=>{item.classList.toggle('is-leaving',item.classList.contains('is-active')&&i!==index);item.classList.toggle('is-active',i===index);});
    return true;
  },changed:index=>{
    dots.forEach((dot,i)=>dot.setAttribute('aria-pressed',String(i===index)));
    caption.textContent=String(index+1).padStart(2,'0')+' / 04 · '+dots[index].dataset.label;
  }});
  const block=(reason,value)=>{rotation.block(reason,value);};
  const syncMotion=()=>{block('motion',motion.matches);hero.classList.toggle('is-reduced',motion.matches);};
  listen(doc,'visibilitychange',()=>{block('hidden',doc.hidden);hero.classList.toggle('is-suspended',doc.hidden);});
  listen(hero,'pointerenter',event=>{if(event.pointerType==='mouse')block('hover',true);});
  listen(hero,'pointerleave',()=>block('hover',false));
  listen(hero,'focusin',()=>block('focus',true));
  listen(hero,'focusout',event=>{if(!hero.contains(event.relatedTarget))block('focus',false);});
  dots.forEach((dot,index)=>listen(dot,'click',()=>void rotation.go(index)));
  listen(toggle,'click',()=>{
    paused=!paused;block('manual',paused);hero.classList.toggle('is-paused',paused);
    toggle.setAttribute('aria-pressed',String(paused));
    toggle.setAttribute('aria-label',paused?toggle.dataset.playLabel:toggle.dataset.pauseLabel);
  });
  if(motion.addEventListener)listen(motion,'change',syncMotion);
  const observer=win.IntersectionObserver?new win.IntersectionObserver(entries=>{
    const visible=entries.some(entry=>entry.isIntersecting);block('offscreen',!visible);hero.classList.toggle('is-offscreen',!visible);
  },{threshold:.15}):null;
  observer?.observe(hero);
  syncMotion();block('hidden',doc.hidden);rotation.start();
  return()=>{alive=false;rotation.destroy();win.clearTimeout(decodeTimeout);observer?.disconnect();listeners.forEach(remove=>remove());};
}
