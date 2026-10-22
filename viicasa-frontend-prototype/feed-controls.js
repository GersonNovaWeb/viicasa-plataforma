// Reveal controls on the user's upward gesture, not on CSS snap's final bounce.
// All gesture listeners are passive: native touch scrolling stays in charge.
const installed=new WeakSet();
export function installFeedControls(feed,body,{requestFrame=requestAnimationFrame}={}){
  if(installed.has(feed))return;installed.add(feed);
  let previous=feed.scrollTop,intent=0,touchY=null,touchX=null,queued=false,travel=0,intentVersion=0;
  const reveal=()=>body.classList.remove('vii-scrolling-down');
  const gesture=direction=>{intentVersion++;intent=direction;travel=0;if(direction<0)reveal();};
  feed.addEventListener('wheel',event=>{
    if(Math.abs(event.deltaY)>Math.abs(event.deltaX||0)&&Math.abs(event.deltaY)>=4)gesture(Math.sign(event.deltaY));
  },{passive:true});
  feed.addEventListener('touchstart',event=>{touchY=event.touches[0]?.clientY??null;touchX=event.touches[0]?.clientX??null;},{passive:true});
  feed.addEventListener('touchmove',event=>{
    const y=event.touches[0]?.clientY,x=event.touches[0]?.clientX;
    if(y!==undefined&&touchY!==null){const dy=touchY-y,dx=x!==undefined&&touchX!==null?touchX-x:0;if(Math.abs(dy)>4&&Math.abs(dy)>Math.abs(dx))gesture(Math.sign(dy));}
    touchY=y??null;touchX=x??null;
  },{passive:true});
  feed.addEventListener('touchend',()=>{touchY=null;touchX=null;},{passive:true});
  feed.addEventListener('touchcancel',()=>{touchY=null;touchX=null;},{passive:true});
  // Scrollbar drags have no wheel/touch direction. Track actual travel with a dead band.
  feed.addEventListener('pointerdown',()=>{intentVersion++;intent=0;travel=0;previous=feed.scrollTop;},{passive:true});
  // A quick native scroll can end before its queued paint; do not erase that movement.
  feed.addEventListener('scrollend',()=>{const version=intentVersion;requestFrame(()=>{if(intentVersion===version){intent=0;travel=0;}});},{passive:true});
  feed.addEventListener('keydown',event=>{
    if(event.target!==feed)return;
    if(['ArrowUp','PageUp','Home'].includes(event.key))gesture(-1);
    if(['ArrowDown','PageDown','End'].includes(event.key))gesture(1);
  });
  feed.addEventListener('focusin',()=>{intentVersion++;intent=-1;reveal();});
  feed.addEventListener('scroll',()=>{
    if(queued)return;queued=true;
    requestFrame(()=>{
      const current=feed.scrollTop,delta=current-previous;
      if(!intent)travel=Math.sign(delta)===Math.sign(travel)?travel+delta:delta;
      if(current<=160||intent<0||!intent&&travel<=-8)reveal();
      else if(intent>0||!intent&&travel>=24)body.classList.add('vii-scrolling-down');
      previous=current;queued=false;
    });
  },{passive:true});
}
