import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {viiHeroMarkup,mountViiHero} from '../viicasa-frontend-prototype/vii-hero.js';

test('Vii hero is bilingual, reserves image space and provides working brand destinations',()=>{
  const english=viiHeroMarkup({L:(es,en)=>en}),spanish=viiHeroMarkup({L:es=>es});
  assert.match(english,/More than a place\./);assert.match(spanish,/Más que un lugar\./);
  assert.equal((english.match(/<h1 /g)||[]).length,1);
  assert.match(english,/fetchpriority="high"/);assert.match(english,/width="1376" height="768"/);
  for(const href of ['/shop','/viilife','/viiconcierge','#vii-discover'])assert.ok(english.includes('href="'+href+'"'));
  assert.doesNotMatch(english,/<video|setInterval|requestAnimationFrame|testimonials/i);
});

function fixture(reduced=false){
  let handler,focused=false;const scrolls=[],link={dataset:{},addEventListener(name,fn){handler=fn;}},target={focus(options){focused=options.preventScroll;},getBoundingClientRect:()=>({top:750})};
  const feed={scrollTop:0,getBoundingClientRect:()=>({top:0}),scrollTo:options=>scrolls.push(options)};
  const doc={querySelector:selector=>selector==='.vii-hero-discover'?link:selector==='#vii-discover'?target:{getBoundingClientRect:()=>({height:102})}};
  const options={feed,doc,win:{matchMedia:()=>({matches:reduced})}};mountViiHero(options);
  return{options,link,scrolls,focused:()=>focused,click(extra={}){const event={button:0,preventDefault(){this.defaultPrevented=true;},...extra};handler(event);return event;}};
}
test('discover scrolls the inner feed below the header, with focus and reduced-motion support',()=>{
  const f=fixture();assert.equal(f.click().defaultPrevented,true);assert.equal(f.focused(),true);
  assert.deepEqual(f.scrolls,[{top:628,left:0,behavior:'smooth'}]);
  const reduced=fixture(true);reduced.click();assert.equal(reduced.scrolls[0].behavior,'instant');
  for(const event of [{button:1},{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{defaultPrevented:true}]){const f=fixture();f.click(event);assert.equal(f.scrolls.length,0);}
  mountViiHero(f.options);assert.equal(f.link.dataset.viiScroll,'true');
});
test('hero is excluded from favourites and motion refinements preserve native scrolling',async()=>{
  const feed=await readFile(new URL('../viicasa-frontend-prototype/vii-feed.js',import.meta.url),'utf8'),css=await readFile(new URL('../viicasa-frontend-prototype/vii-final.css',import.meta.url),'utf8');
  assert.match(feed,/showHero=!brand&&!likesOnly/);assert.match(feed,/showHero\?viiHeroMarkup/);
  assert.match(css,/scroll-behavior:auto;scroll-snap-type:none/);assert.match(css,/scroll-snap-stop:normal/);
  assert.match(css,/padding-top:var\(--header-height,90px\)/);assert.match(css,/\.vii-search-wrap\{position:sticky;top:0/);assert.match(css,/prefers-reduced-motion/);
  assert.doesNotMatch(css,/touch-action:none|scroll-snap-type:y mandatory/);
});
