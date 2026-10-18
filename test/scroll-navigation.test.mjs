import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {scrollFeedTo,resetPageScroll,installPageScroll,finishPageScroll} from '../viicasa-frontend-prototype/scroll-navigation.js';

test('normal navigation and pageshow reset both scroll containers, never smoothly',()=>{
  const calls=[],events={};
  const win={location:{hash:''},history:{scrollRestoration:'auto'},scrollTo:o=>calls.push(['window',o]),addEventListener:(name,fn)=>events[name]=fn};
  const doc={querySelector:()=>({scrollTo:o=>calls.push(['feed',o])})};
  installPageScroll(win,doc);assert.equal(win.history.scrollRestoration,'manual');
  assert.equal(calls.length,2);events.pageshow({persisted:true});assert.equal(calls.length,4);
  for(const [,options]of calls)assert.deepEqual(options,{top:0,left:0,behavior:'instant'});
  win.location.hash='#viilife-demo-form';resetPageScroll(win,doc);assert.equal(calls.length,4);
});

test('form and scene buttons scroll only the feed and respect the fixed header',()=>{
  let result;const feed={scrollTop:1400,getBoundingClientRect:()=>({top:0}),scrollTo:o=>result=o};
  const target={getBoundingClientRect:()=>({top:850})};
  scrollFeedTo(feed,target,{offset:124,behavior:'smooth'});
  assert.deepEqual(result,{top:2126,left:0,behavior:'smooth'});
  scrollFeedTo(feed,target);assert.equal(result.top,2250);assert.equal(result.behavior,'instant');
  scrollFeedTo(feed,{getBoundingClientRect:()=>({top:-2000})});assert.equal(result.top,0);
  scrollFeedTo(feed,null);assert.equal(result.top,0);
});

test('long ViiLife form is not a snap target and the outer document cannot scroll',async()=>{
  const css=await readFile(new URL('../viicasa-frontend-prototype/cleaning.css',import.meta.url),'utf8');
  const base=await readFile(new URL('../viicasa-frontend-prototype/styles.css',import.meta.url),'utf8');
  assert.match(css,/\.viilife-booking\{scroll-snap-align:none/);
  assert.match(css,/#feed\.has-service-form\{scroll-snap-type:y proximity\}/);
  assert.match(base,/html,body\{height:100%;overflow:hidden\}/);
});

function scrollFixture(hash=''){
  const events={},frames=new Map(),calls=[];let nextFrame=0,anchorReady=false,resolveFonts;
  const feed={scrollTop:1800,getBoundingClientRect:()=>({top:0}),scrollTo:o=>{feed.scrollTop=o.top;calls.push(['feed',o]);},contains:t=>t===anchor};
  const anchor={getBoundingClientRect:()=>({top:2600-feed.scrollTop})};
  const win={location:{hash},history:{scrollRestoration:'auto'},scrollY:500,
    scrollTo:o=>{win.scrollY=o.top;calls.push(['window',o]);},
    addEventListener:(name,fn)=>{(events[name]||=[]).push(fn);},
    requestAnimationFrame:fn=>{const id=++nextFrame;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id)};
  const doc={querySelector:q=>q==='#feed'?feed:q==='.header'?{getBoundingClientRect:()=>({height:100})}:null,getElementById:id=>id==='viilife-demo-form'&&anchorReady?anchor:id==='feed'?feed:null,
    fonts:{ready:new Promise(resolve=>resolveFonts=resolve)}};
  return{win,doc,feed,calls,ready:()=>{anchorReady=true;},fonts:resolveFonts,
    fire:name=>{for(const fn of events[name]||[])fn({type:name});},
    paint:()=>{const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn());},frames,events};
}

test('async rendering resets the final feed and a late browser restoration is corrected after paint',()=>{
  const f=scrollFixture();installPageScroll(f.win,f.doc);
  assert.equal(f.feed.scrollTop,0);f.feed.scrollTop=1700;
  finishPageScroll(f.win,f.doc);assert.equal(f.feed.scrollTop,0);
  f.paint();f.feed.scrollTop=1200;f.win.scrollY=300;f.paint();
  assert.equal(f.feed.scrollTop,0);assert.equal(f.win.scrollY,0);
  assert.ok(f.calls.every(([,o])=>o.behavior==='instant'));
});

test('wheel, touch, pointer and keyboard input cancel pending resets; slow data does not pull the customer away',()=>{
  for(const event of ['wheel','touchstart','pointerdown','keydown']){
    const f=scrollFixture();installPageScroll(f.win,f.doc);finishPageScroll(f.win,f.doc);
    f.fire(event);f.feed.scrollTop=2800;f.win.scrollY=0;f.paint();f.fire('load');finishPageScroll(f.win,f.doc);f.paint();f.paint();
    assert.equal(f.feed.scrollTop,2800,event);
  }
});

test('Back/Forward cache pageshow starts a fresh top reset even after interaction on the previous page',()=>{
  const f=scrollFixture();installPageScroll(f.win,f.doc);f.fire('wheel');f.feed.scrollTop=3200;
  f.fire('pageshow');assert.equal(f.feed.scrollTop,0);
  f.paint();f.feed.scrollTop=3100;f.paint();assert.equal(f.feed.scrollTop,0);
});

test('deferred form anchors align below the actual header after their content is ready',()=>{
  const f=scrollFixture('#viilife-demo-form');installPageScroll(f.win,f.doc);
  finishPageScroll(f.win,f.doc);assert.equal(f.feed.scrollTop,0,'An unavailable anchor does not preserve a stale footer position');
  f.ready();finishPageScroll(f.win,f.doc);f.paint();f.paint();
  assert.equal(f.feed.scrollTop,2476);assert.equal(f.win.scrollY,0);
  f.fire('wheel');f.feed.scrollTop=2900;finishPageScroll(f.win,f.doc);f.paint();assert.equal(f.feed.scrollTop,2900);
  f.fire('hashchange');f.paint();f.paint();assert.equal(f.feed.scrollTop,2476);
});

test('unknown or malformed fragments cannot inherit a footer position',()=>{
  for(const hash of ['#not-a-section','#%E0%A4%A']){
    const f=scrollFixture(hash);installPageScroll(f.win,f.doc);finishPageScroll(f.win,f.doc);f.paint();f.paint();assert.equal(f.feed.scrollTop,0);assert.equal(f.win.scrollY,0);
  }
});

test('late fonts reset only an untouched page; installation does not duplicate handlers',async()=>{
  const f=scrollFixture();installPageScroll(f.win,f.doc);installPageScroll(f.win,f.doc);assert.equal(f.events.pageshow.length,1);
  f.feed.scrollTop=1000;f.fonts();await Promise.resolve();f.paint();f.paint();assert.equal(f.feed.scrollTop,0);
  const touched=scrollFixture();installPageScroll(touched.win,touched.doc);touched.fire('keydown');touched.feed.scrollTop=1200;touched.fonts();await Promise.resolve();touched.paint();touched.paint();assert.equal(touched.feed.scrollTop,1200);
});

test('platform and immersive renderers complete restoration after async work; form scrolling has no snap',async()=>{
  const base=new URL('../viicasa-frontend-prototype/',import.meta.url);
  const platform=await readFile(new URL('platform.js',base),'utf8'),app=await readFile(new URL('app.js',base),'utf8'),css=await readFile(new URL('cleaning.css',base),'utf8');
  assert.match(platform,/finally\{finishPageScroll\(\);/);
  assert.match(platform,/resetPageScroll\(\);finishPageScroll\(\);/);
  assert.doesNotMatch(platform,/\$\('#feed'\)\.scrollTop=0/);
  assert.match(app,/resetPageScroll\(\);finishPageScroll\(\);/);
  assert.match(css,/body\.service-form-visible #feed\.has-service-form\{scroll-snap-type:none\}/);
});
