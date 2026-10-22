import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installFeedControls} from '../viicasa-frontend-prototype/feed-controls.js';
function fixture(){
  const handlers=new Map(),frames=[],classes=new Set(),feed={scrollTop:0,addEventListener(name,fn,options){handlers.set(name,{fn,options});}},body={classList:{add:c=>classes.add(c),remove:c=>classes.delete(c)}};
  installFeedControls(feed,body,{requestFrame:fn=>frames.push(fn)});
  return{feed,handlers,hidden:()=>classes.has('vii-scrolling-down'),event:(name,event={})=>handlers.get(name).fn(event),flush(){while(frames.length)frames.shift()();},scroll(top){feed.scrollTop=top;handlers.get('scroll').fn();while(frames.length)frames.shift()();}};
}
test('an upward wheel gesture reveals immediately and snap settling cannot hide controls again',()=>{
  const f=fixture();f.event('wheel',{deltaY:500});f.scroll(700);assert.equal(f.hidden(),true);
  f.event('wheel',{deltaY:-100});assert.equal(f.hidden(),false);f.scroll(500);f.scroll(540);assert.equal(f.hidden(),false);
  f.event('wheel',{deltaY:100});f.scroll(800);assert.equal(f.hidden(),true);
  f.scroll(0);assert.equal(f.hidden(),false);
});
test('touch and keyboard intent preserve native scrolling and keyboard focus reveals controls',()=>{
  const f=fixture();f.scroll(500);assert.equal(f.hidden(),true);
  f.event('touchstart',{touches:[{clientY:200}]});f.event('touchmove',{touches:[{clientY:260}]});assert.equal(f.hidden(),false);
  f.scroll(550);assert.equal(f.hidden(),false);f.event('touchmove',{touches:[{clientY:100}]});f.scroll(800);assert.equal(f.hidden(),true);
  f.event('focusin');assert.equal(f.hidden(),false);f.event('keydown',{target:f.feed,key:'PageDown'});f.scroll(1100);assert.equal(f.hidden(),true);
  f.event('keydown',{target:f.feed,key:'PageUp'});assert.equal(f.hidden(),false);
  for(const name of ['wheel','touchstart','touchmove','touchend','scroll'])assert.equal(f.handlers.get(name).options.passive,true);
});
test('scrollbar direction is refreshed and small idle movements do not flicker the header',()=>{
  const f=fixture();f.event('wheel',{deltaY:300});f.scroll(600);assert.equal(f.hidden(),true);
  f.event('scrollend');f.event('pointerdown');f.scroll(580);assert.equal(f.hidden(),false);
  f.scroll(582);f.scroll(580);f.scroll(583);assert.equal(f.hidden(),false);
  f.scroll(620);assert.equal(f.hidden(),true);
  f.event('scrollend');f.event('wheel',{deltaY:-1});f.scroll(619);assert.equal(f.hidden(),true);
  f.event('wheel',{deltaY:-8});assert.equal(f.hidden(),false);
});
test('horizontal swipes never collapse controls and installing twice does not duplicate listeners',()=>{
  const f=fixture();f.event('touchstart',{touches:[{clientX:250,clientY:250}]});
  f.event('touchmove',{touches:[{clientX:100,clientY:240}]});f.scroll(2);assert.equal(f.hidden(),false);
  f.event('touchcancel');f.event('wheel',{deltaX:200,deltaY:5});assert.equal(f.hidden(),false);
  const before=f.handlers.get('scroll');installFeedControls(f.feed,{classList:{}},{requestFrame:fn=>fn()});assert.equal(f.handlers.get('scroll'),before);
});
test('a fast scroll ending before its paint does not erase movement or a newer gesture',()=>{
  const f=fixture();f.event('wheel',{deltaY:600});f.feed.scrollTop=600;f.event('scroll');f.event('scrollend');f.flush();assert.equal(f.hidden(),true);
  f.event('scrollend');f.event('wheel',{deltaY:-100});f.flush();f.scroll(550);assert.equal(f.hidden(),false);
  // Programmatic discover focuses its heading and keeps the navigation visible through settling.
  f.event('focusin');f.feed.scrollTop=900;f.event('scroll');f.event('scrollend');f.flush();assert.equal(f.hidden(),false);
});
