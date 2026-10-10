// Keep navigation inside #feed; scrollIntoView can also move outer ancestors.
export function scrollFeedTo(feed,target,{offset=0,behavior='instant'}={}){
  if(!feed||!target)return;
  const top=Math.max(0,feed.scrollTop+target.getBoundingClientRect().top-feed.getBoundingClientRect().top-offset);
  feed.scrollTo({top,left:0,behavior});
}
export function resetPageScroll(win=window,doc=document){
  if(win.location.hash)return; // Preserve intentional deep links.
  win.scrollTo({top:0,left:0,behavior:'instant'});
  doc.querySelector('#feed')?.scrollTo({top:0,left:0,behavior:'instant'});
}
export function installPageScroll(win=window,doc=document){
  if('scrollRestoration' in win.history)win.history.scrollRestoration='manual';
  resetPageScroll(win,doc);
  win.addEventListener('pageshow',()=>resetPageScroll(win,doc));
}
