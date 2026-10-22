import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {filterTiles,cadProductSummary,restoreFeedFilters,prepareViiFeed,warmViiImages} from '../viicasa-frontend-prototype/vii-feed.js';
import {tileMarkup} from '../viicasa-frontend-prototype/vii-tiles.js';
import {accountNavigation} from '../viicasa-frontend-prototype/vii-ui.js';
import {stayPreferences,stayHref} from '../viicasa-frontend-prototype/vii-stay.js';
const L=(es,en)=>en,esc=v=>String(v).replace(/[<&"]/g,c=>({'<':'&lt;','&':'&amp;','"':'&quot;'}[c])),money=n=>'CAD '+n/100;
test('tile markup separates media, brand tag and compact purchase content; never invents review counts',()=>{
  const item={key:'product:1',brand:'shop',category:'Linen',title:'Linen <set>',description:'Soft linen',image:'/assets/shop.png',href:'/shop/linen',amount:7900,action:'Buy'};
  const html=tileMarkup(item,{home:false,liked:true,L,esc,money});
  assert.match(html,/class="vii-tile-media"/);assert.match(html,/class="vii-tile-bottom"/);assert.match(html,/Linen &lt;set>/);assert.match(html,/aria-pressed="true"/);assert.match(html,/href="\/shop\/linen"/);assert.match(html,/href="\/checkout\?product=linen"/);assert.doesNotMatch(html,/reviews|2\.4k|1\.1k/);
  assert.match(tileMarkup(item,{home:true,L,esc,money}),/class="vii-tag">ViiShop/);
});
test('CAD filters reject unpriced items and never convert USD prices',()=>{
  assert.deepEqual(cadProductSummary([{active:true,prices:{CAD:7900},stock:2},{currency:'USD',price_minor:100,stock:10}]),{amount:7900,available:true});
  assert.deepEqual(cadProductSummary([{currency:'USD',price_minor:100,stock:10}]),{amount:null,available:false});
  assert.deepEqual(cadProductSummary([{currency:'CAD',price_minor:1200,active:false,stock:2}]),{amount:null,available:false});
  assert.deepEqual(cadProductSummary(null),{amount:null,available:false});
  const items=[{title:'A',description:'',category:'Linen',amount:1000,available:true},{title:'B',description:'',category:'Linen',amount:3000,available:true},{title:'C',description:'',category:'Linen',amount:null,available:false}];
  assert.deepEqual(filterTiles(items,{min:15,max:35}).map(x=>x.title),['B']);
});
test('bottom account shortcuts use existing operational destinations, not a fake itinerary',()=>{
  const html=accountNavigation(L,{likes:true});assert.match(html,/href="\/cliente\?tab=agenda"/);assert.match(html,/href="\/\?likes=1"[^>]+aria-current="page"/);assert.match(html,/data-account-section="orders" aria-label="Orders"/);assert.doesNotMatch(html,/itinerary/);
});
test('back to a brand restores validated search context without trusting malformed session data',()=>{
  assert.deepEqual(restoreFeedFilters({q:'linen',category:'Textiles',sort:'price',available:true,min:'30',max:'100'}),{q:'linen',category:'Textiles',sort:'price',available:true,min:'30',max:'100',checkIn:'',checkOut:'',guests:1});
  assert.deepEqual(restoreFeedFilters({q:[],sort:'unknown',available:'true',min:'NaN',max:-5}),{q:'',category:'',sort:'recommended',available:false,min:'',max:'',checkIn:'',checkOut:'',guests:1});
});
test('stay dates and guests are validated and transferred without claiming availability',()=>{
  const preferences={checkIn:'2026-11-10',checkOut:'2026-11-13',guests:3};
  assert.deepEqual(stayPreferences(preferences),preferences);
  const href=stayHref('/viiconcierge/villa-oliva',preferences);
  assert.equal(href,'/viiconcierge/villa-oliva?check_in=2026-11-10&check_out=2026-11-13&guests=3');
  assert.deepEqual(stayPreferences(new URL(href,'https://example.com').searchParams),preferences);
  assert.deepEqual(stayPreferences({checkIn:'2026-02-30',checkOut:'bad',guests:-2}),{checkIn:'',checkOut:'',guests:1});
  assert.equal(stayPreferences({checkIn:'2026-11-13',checkOut:'2026-11-10'}).checkOut,'');
  assert.equal(stayHref('/viiconcierge/villa-oliva',{}),'/viiconcierge/villa-oliva');
  const items=[{key:'property:1',capacity:2,title:'Small',description:'',category:''},{key:'property:2',capacity:6,title:'Large',description:'',category:''}];
  assert.deepEqual(filterTiles(items,{guests:3}).map(x=>x.title),['Large']);
});
test('mobile specification includes compact sections, immersive home, filter chips, bottom sheets and safe motion',async()=>{
  const css=await readFile(new URL('../viicasa-frontend-prototype/vii-final.css',import.meta.url),'utf8');
  for(const token of ['[data-vii-brand=home]',':not([data-vii-view=likes])','.vii-results','.vii-intent','.vii-filter-chips','.vii-menu','.vii-booking-sheet','.vii-product-actions','prefers-reduced-motion','forced-colors'])assert.ok(css.includes(token),token);
  assert.match(css,/\.vii-tile-media\{height:190px\}/);assert.match(css,/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(css,/scroll-behavior:smooth|touch-action:none/);
});
test('sections prepare only their own data before any DOM replacement',async()=>{
  const calls=[],api=async path=>{calls.push(path);if(path==='/client/likes')throw Error('guest');return{items:[],families:[]};};
  const life=await prepareViiFeed({api,pathname:'/viilife'});assert.equal(life.brand,'viilife');assert.deepEqual(calls,['/service-catalogue','/client/likes']);assert.equal(life.signedIn,false);
  calls.length=0;await prepareViiFeed({api,pathname:'/shop'});assert.deepEqual(calls,['/products?limit=100','/client/likes']);
});
test('visible image preparation is bounded and decodes only valid public image sources',async()=>{
  const decoded=[];class ImageFixture{async decode(){decoded.push(this.src);}}
  await warmViiImages({brand:null,products:[{images:['javascript:bad']}],properties:[{images:['/assets/interior.png']}],services:[]},{ImageClass:ImageFixture});
  assert.deepEqual(decoded,['/assets/exterior.png','/assets/interior.png']);
  class SlowImage{decode(){return new Promise(()=>{});}}
  await warmViiImages({brand:null,products:[],properties:[],services:[]},{ImageClass:SlowImage,timeout:5});
});
