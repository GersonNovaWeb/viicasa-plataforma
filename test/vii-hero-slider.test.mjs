import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import {createHeroRotation,mountHeroSlider} from '../viicasa-frontend-prototype/vii-hero-slider.js';
import {heroSlides,viiHeroMarkup} from '../viicasa-frontend-prototype/vii-hero.js';

function fixture(show=async()=>true){
  let id=0;const jobs=new Map(),changes=[];
  const rotation=createHeroRotation({count:4,show,changed:i=>changes.push(i),schedule:(fn,ms)=>{jobs.set(++id,{fn,ms});return id;},cancel:id=>jobs.delete(id)});
  return{rotation,jobs,changes,tick:async()=>{const [id,job]=jobs.entries().next().value;jobs.delete(id);await job.fn();}};
}
test('hero has four dedicated assets, only the first image loads eagerly',async()=>{
  const markup=viiHeroMarkup({L:(_,en)=>en});
  assert.equal(heroSlides.length,4);assert.equal((markup.match(/data-hero-image/g)||[]).length,4);
  assert.equal((markup.match(/data-src=/g)||[]).length,3);
  assert.equal((markup.match(/data-hero-slide=/g)||[]).length,4);
  assert.match(markup,/Pause slideshow/);assert.match(markup,/aria-roledescription="carousel"/);
  for(const [file] of heroSlides)assert.ok((await stat(new URL('../viicasa-frontend-prototype/assets/'+file,import.meta.url))).size>0);
});
test('rotation wraps in both directions and has one slow autoplay timer',async()=>{
  const f=fixture();f.rotation.start();f.rotation.start();assert.equal(f.jobs.size,1);
  assert.equal([...f.jobs.values()][0].ms,7000);await f.tick();assert.equal(f.rotation.current,1);
  await f.rotation.go(-1);assert.equal(f.rotation.current,3);await f.tick();assert.equal(f.rotation.current,0);
  f.rotation.destroy();assert.equal(f.jobs.size,0);
});
test('motion, focus, hover, visibility and explicit pause block autoplay independently',async()=>{
  const f=fixture();f.rotation.start();
  for(const reason of ['motion','focus','hover','hidden','offscreen','manual'])f.rotation.block(reason,true);
  assert.equal(f.jobs.size,0);await f.rotation.go(2);assert.equal(f.rotation.current,2);assert.equal(f.jobs.size,0);
  for(const reason of ['motion','focus','hover','hidden','offscreen'])f.rotation.block(reason,false);
  assert.equal(f.jobs.size,0);f.rotation.block('manual',false);assert.equal(f.jobs.size,1);f.rotation.destroy();
});
test('failed image keeps the previous slide; concurrent and destroyed loads do not commit',async()=>{
  const failed=fixture(async()=>{throw Error('decode failed');});
  await failed.rotation.go(1);assert.equal(failed.rotation.current,0);assert.deepEqual(failed.changes,[]);failed.rotation.destroy();
  let resolve;const f=fixture(()=>new Promise(done=>{resolve=done;})),pending=f.rotation.go(1);
  assert.equal(await f.rotation.go(2),false);f.rotation.destroy();resolve(true);await pending;
  assert.equal(f.rotation.current,0);assert.equal(f.jobs.size,0);assert.deepEqual(f.changes,[]);
});
test('slider cleanup is composed with media cleanup and preserves reduced motion',async()=>{
  const source=await readFile(new URL('../viicasa-frontend-prototype/vii-feed.js',import.meta.url),'utf8'),css=await readFile(new URL('../viicasa-frontend-prototype/vii-final.css',import.meta.url),'utf8');
  assert.match(source,/mediaObserver\?\.disconnect\(\);heroCleanup\?\.\(\)/);
  assert.match(css,/prefers-reduced-motion:reduce/);assert.match(css,/\.vii-hero-image\{animation:none!important;transition:none;transform:none\}/);
  assert.doesNotThrow(()=>mountHeroSlider({hero:null}));
});
