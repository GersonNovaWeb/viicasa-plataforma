// The public site scrolls inside #feed, not just the outer document.
const controllers=new WeakMap();
const instant={top:0,left:0,behavior:'instant'};

export function scrollFeedTo(feed,target,{offset=0,behavior='instant'}={}){
  if(!feed||!target)return;
  const top=Math.max(0,feed.scrollTop+target.getBoundingClientRect().top-feed.getBoundingClientRect().top-offset);
  feed.scrollTo({top,left:0,behavior});
}
export function resetPageScroll(win=window,doc=document){
  if(win.location.hash)return; // Explicit anchors are aligned after their content exists.
  win.scrollTo(instant);
  doc.querySelector('#feed')?.scrollTo(instant);
}
function alignPage(win,doc){
  let id;
  try{id=decodeURIComponent(win.location.hash.slice(1));}catch{id='';}
  const target=id&&doc.getElementById(id),feed=doc.querySelector('#feed');
  if(target){
    const offset=doc.querySelector('.header')?.getBoundingClientRect().height||0;
    win.scrollTo(instant);
    if(target===feed)feed.scrollTo(instant);
    else if(feed?.contains(target))scrollFeedTo(feed,target,{offset:offset+24});
    else win.scrollTo({top:Math.max(0,(win.scrollY||0)+target.getBoundingClientRect().top-offset-24),left:0,behavior:'instant'});
  }else{win.scrollTo(instant);feed?.scrollTo(instant);}
}
// Called after async rendering, not only when the initially empty document loads.
// Do not pull a customer back to the top once they have started interacting.
export function finishPageScroll(win=window,doc=document){
  const controller=controllers.get(win);
  if(controller?.interacted)return;
  controller?.cancel();
  const apply=()=>{if(!controller?.interacted)alignPage(win,doc);};
  apply();
  if(win.requestAnimationFrame){
    let frame=win.requestAnimationFrame(()=>{frame=win.requestAnimationFrame(apply);if(controller)controller.frame=frame;});
    if(controller)controller.frame=frame;
  }
}
export function installPageScroll(win=window,doc=document){
  if(controllers.has(win))return;
  if('scrollRestoration' in win.history)win.history.scrollRestoration='manual';
  const controller={interacted:false,frame:null,cancel(){if(this.frame!=null)win.cancelAnimationFrame?.(this.frame);this.frame=null;}};
  controllers.set(win,controller);
  const interrupt=()=>{
    controller.interacted=true;controller.cancel();
  };
  for(const event of ['wheel','touchstart','pointerdown','keydown'])win.addEventListener(event,interrupt,{capture:true,passive:true});
  win.addEventListener('pageshow',()=>{controller.interacted=false;finishPageScroll(win,doc);});
  win.addEventListener('load',()=>finishPageScroll(win,doc));
  win.addEventListener('hashchange',()=>{controller.interacted=false;finishPageScroll(win,doc);});
  doc.fonts?.ready.then(()=>finishPageScroll(win,doc));
  resetPageScroll(win,doc);
}
