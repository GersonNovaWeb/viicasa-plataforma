import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {scrollFeedTo,resetPageScroll,installPageScroll} from '../viicasa-frontend-prototype/scroll-navigation.js';

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
