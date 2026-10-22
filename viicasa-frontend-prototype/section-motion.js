// Progressive section navigation: prepared same-document swaps for the four public feeds.
// Other destinations retain real links and normal full-page navigation.
export const sectionOrder=['/','/shop','/viilife','/viiconcierge'];
const key='vii-section-motion';
export function sectionDirection(from,to){
  const a=sectionOrder.indexOf(from),b=sectionOrder.indexOf(to);
  return a<0||b<0||a===b?0:Math.sign(b-a);
}
export function installSectionMotion(win=window,doc=document){
  let leaving=false,outgoingAnimation=null,adapter=null,revision=0,lastPath=win.location.pathname,activeTransition=null;
  const reduced=()=>win.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clear=()=>{try{win.sessionStorage.removeItem(key);}catch{}};
  const take=()=>{try{const value=JSON.parse(win.sessionStorage.getItem(key)||'null');clear();return value;}catch{clear();return null;}};
  const play=async(element,frames,duration,phase,{hold=false}={})=>{
    doc.documentElement.dataset.sectionMotion=phase;
    const animation=element.animate(frames,{duration,easing:'cubic-bezier(.22,.75,.25,1)',fill:hold?'forwards':'none'});
    if(hold)outgoingAnimation=animation;
    // Bounded fallback: a paused tab or browser animation failure must never block navigation.
    let timer,failed=false;
    try{await Promise.race([animation.finished,new Promise(resolve=>{timer=win.setTimeout(resolve,duration+100);})]);}
    catch{failed=true;/* A cancelled animation still completes navigation. */}
    finally{win.clearTimeout(timer);if(!hold||failed)animation.cancel();delete doc.documentElement.dataset.sectionMotion;}
  };
  const navigate=async(url,{pop=false}={})=>{
    const version=++revision,direction=sectionDirection(lastPath,url.pathname),feed=doc.querySelector('#feed');
    leaving=true;activeTransition?.skipTransition?.();
    doc.documentElement.dataset.sectionLoading='true';feed?.setAttribute?.('aria-busy','true');
    let timer,didCommit=false;
    try{
      // Keep the current page painted until data and visible images are ready.
      const prepared=await Promise.race([adapter.prepare(url),new Promise((_,reject)=>{timer=win.setTimeout(()=>reject(Error('Section preparation timed out.')),12000);})]);
      win.clearTimeout(timer);if(version!==revision)return;
      let updated=false;
      const update=async()=>{
        if(updated||version!==revision)return;updated=true;
        if(!pop)win.history.pushState({viiSection:true},'',url.href);
        didCommit=true;
        lastPath=url.pathname;doc.body?.classList.remove('vii-scrolling-down');
        await adapter.render(prepared);feed?.scrollTo?.({top:0,left:0,behavior:'instant'});
      };
      doc.documentElement.dataset.sectionDirection=direction<0?'back':'forward';
      doc.documentElement.dataset.sectionMotion='swapping';
      if(doc.startViewTransition&&!reduced()){
        const transition=doc.startViewTransition(update);activeTransition=transition;
        transition.ready?.catch(()=>{});
        // Rendering failures are not swallowed as an animation failure.
        await transition.updateCallbackDone;await transition.finished.catch(()=>{});
      }else{
        await update();
        if(!reduced()&&feed?.animate)await play(feed,[{transform:`translateX(${direction*24}px)`},{transform:'translateX(0)'}],240,'entering');
      }
    }catch(error){if(version===revision){if(didCommit||pop||!adapter.onError)win.location.assign(url.href);else adapter.onError(error);}}
    finally{win.clearTimeout(timer);if(version===revision){leaving=false;activeTransition=null;delete doc.documentElement.dataset.sectionLoading;delete doc.documentElement.dataset.sectionMotion;delete doc.documentElement.dataset.sectionDirection;feed?.removeAttribute?.('aria-busy');}}
  };
  doc.addEventListener('click',event=>{
    const link=event.target.closest?.('#navigation a,.preview-header nav a,.wordmark,.vii-hero-brands a');
    if(!link||event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||link.hasAttribute('download')||link.target&&link.target!=='_self')return;
    const url=new URL(link.href,win.location.href),direction=sectionDirection(win.location.pathname,url.pathname),feed=doc.querySelector('#feed');
    if(url.origin!==win.location.origin||url.search||url.hash)return;
    if(adapter&&sectionOrder.includes(url.pathname)&&sectionOrder.includes(win.location.pathname)){
      event.preventDefault();if(leaving)return;
      if(url.href===win.location.href){doc.body?.classList.remove('vii-scrolling-down');feed?.scrollTo?.({top:0,left:0,behavior:'instant'});return;}
      void navigate(url);return;
    }
    if(!direction||!feed?.animate||reduced())return;
    if(leaving){event.preventDefault();return;}
    try{win.sessionStorage.setItem(key,JSON.stringify({from:win.location.pathname,to:url.pathname,direction,at:Date.now()}));}catch{return;}
    event.preventDefault();leaving=true;
    const distance=Math.min(win.innerWidth*.07,90)*direction;
    // Stay fully opaque: fading exposed the old dark shell and caused a black flash.
    void play(feed,[{transform:'translateX(0)'},{transform:`translateX(${-distance}px)`}],150,'leaving',{hold:true})
      .catch(()=>{}).finally(()=>win.location.assign(url.href));
  });
  win.addEventListener('pageshow',event=>{leaving=false;outgoingAnimation?.cancel();outgoingAnimation=null;if(event.persisted){revision++;activeTransition?.skipTransition?.();clear();delete doc.documentElement.dataset.sectionLoading;delete doc.documentElement.dataset.sectionMotion;delete doc.documentElement.dataset.sectionDirection;doc.querySelector('#feed')?.removeAttribute?.('aria-busy');}});
  win.addEventListener('popstate',()=>{
    if(!adapter)return;const url=new URL(win.location.href);
    if(!sectionOrder.includes(url.pathname)||url.search||url.hash){revision++;activeTransition?.skipTransition?.();win.location.reload();return;}
    void navigate(url,{pop:true});
  });
  return{
    configure(options){adapter=options;clear();lastPath=win.location.pathname;},
    async enter(){
      if(adapter){clear();return;}
      const pending=take(),feed=doc.querySelector('#feed');
      const age=pending?Date.now()-pending.at:Infinity;
      if(!pending||!Number.isFinite(age)||age<0||age>8000||pending.to!==win.location.pathname||pending.direction!==sectionDirection(pending.from,pending.to)||reduced()||!feed?.animate)return;
      const distance=Math.min(win.innerWidth*.09,110)*pending.direction;
      await play(feed,[{transform:`translateX(${distance}px)`},{transform:'translateX(0)'}],360,'entering');
    }
  };
}
