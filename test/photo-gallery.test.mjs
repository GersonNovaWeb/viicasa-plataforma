import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stat,readFile} from 'node:fs/promises';
import {galleryMarkup,createPhotoSequence,wrapPhoto} from '../viicasa-frontend-prototype/photo-gallery.js';
import {containedRect,imageTransform,validateItemContext,animateSafely,isItemPath,installItemMotion} from '../viicasa-frontend-prototype/gallery-motion.js';
import {sampleProductGallery,sampleGalleryAssets,sampleGalleryDetails} from '../viicasa-frontend-prototype/sample-product-gallery.js';
const L=(es,en)=>en,esc=v=>String(v).replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));

test('gallery exposes all photos, safe names and numbered lazy previews; empty/single states work',()=>{
  const html=galleryMarkup({images:['/assets/a.png','/assets/b.png','/assets/c.png','/assets/d.png'],name:'<demo>',L,esc});
  assert.match(html,/&lt;demo&gt;/);assert.doesNotMatch(html,/<demo>/);
  assert.equal((html.match(/data-gallery=/g)||[]).length,7);assert.match(html,/data-gallery="3"/);assert.match(html,/loading="lazy"/);
  assert.match(galleryMarkup({images:[],name:'empty',L,esc}),/Gallery pending/);
  assert.doesNotMatch(galleryMarkup({images:['/a'],name:'one',L,esc}),/vii-gallery-preview/);
});
test('photo sequence wraps and serializes fast clicks while retaining a failed current image',async()=>{
  assert.equal(wrapPhoto(-1,4),3);assert.equal(wrapPhoto(4,4),0);assert.equal(wrapPhoto(0,0),0);
  let complete;const seen=[],sequence=createPhotoSequence({count:3,show:(i,d)=>{seen.push([i,d]);return new Promise(resolve=>{complete=resolve;});}});
  const changing=sequence.go(1);assert.equal(await sequence.go(2),false);complete(true);await changing;assert.equal(sequence.index,1);assert.deepEqual(seen,[[1,1]]);
  const failed=createPhotoSequence({count:3,initial:2,show:async()=>{throw Error();}});await failed.go(0);assert.equal(failed.index,2);
  const closing=sequence.go(2);sequence.destroy();complete(true);await closing;assert.equal(sequence.index,1);assert.equal(await sequence.go(0),false);
});
test('contain geometry and FLIP transforms preserve the image box at both aspect ratios',()=>{
  assert.deepEqual(containedRect({left:10,top:20,width:400,height:400},800,400),{left:10,top:120,width:400,height:200});
  assert.deepEqual(containedRect({left:10,top:20,width:400,height:400},400,800),{left:110,top:20,width:200,height:400});
  assert.equal(imageTransform({left:10,top:20,width:100,height:50},{left:30,top:60,width:200,height:100}),'translate(-20px, -40px) scale(0.5, 0.5)');
});
test('item entry ignores expired, malformed, wrong-route and resized browser contexts',()=>{
  const value={to:'/shop/sample-terra-vase',at:100,width:390,rect:{left:0,top:150,width:360,height:240}},opts={pathname:value.to,width:390,now:200};
  assert.equal(validateItemContext(value,opts),value);
  for(const modified of [{at:-500000},{to:'/admin'},{width:1440},{rect:{left:0,top:0,width:Infinity,height:20}},{rect:{left:0,top:0,width:-1,height:20}}])assert.equal(validateItemContext({...value,...modified},opts),null);
  assert.equal(isItemPath('/shop/foo-bar'),true);for(const path of ['/shop','/checkout','/admin','/shop/foo/bar','https://example.com/shop/foo'])assert.equal(isItemPath(path),false);
});
test('reduced motion never animates and cancelled effects always clean up',async()=>{
  let calls=0,cancelled=0;const win={matchMedia:()=>({matches:true}),setTimeout,clearTimeout},element={animate(){calls++;return{finished:Promise.reject(Error('cancelled')),cancel(){cancelled++;}};}};
  await animateSafely(element,[],{win});assert.equal(calls,0);
  win.matchMedia=()=>({matches:false});await animateSafely(element,[],{win,duration:1});assert.equal(calls,1);assert.equal(cancelled,1);
});
test('card motion keeps native links and modifiers; installation is idempotent',()=>{
  let click,count=0,stored;const image={getBoundingClientRect:()=>({left:0,top:100,width:300,height:250})},card={querySelector:()=>image};
  const link={href:'http://local/shop/sample-terra-vase',hasAttribute:()=>false,closest:()=>card},doc={documentElement:{dataset:{}},addEventListener(type,handler){count++;click=handler;}};
  const win={matchMedia:()=>({matches:false}),location:{href:'http://local/shop',origin:'http://local',pathname:'/shop'},innerWidth:390,sessionStorage:{setItem(k,v){stored=JSON.parse(v);}},setTimeout,clearTimeout};
  installItemMotion({doc,win});installItemMotion({doc,win});assert.equal(count,1);
  click({button:0,ctrlKey:true,target:{closest:()=>link}});assert.equal(stored,undefined);
  click({button:0,target:{closest:()=>link}});assert.equal(stored.to,'/shop/sample-terra-vase');assert.equal(stored.rect.width,300);
});
test('generated sample supplements exist and never override real or admin replacement images',async()=>{
  for(const [slug,asset] of Object.entries(sampleGalleryAssets)){
    const original=['/assets/objects.png'],generated=[asset,sampleGalleryDetails[slug]];assert.deepEqual(sampleProductGallery({slug},original,true),generated);
    assert.deepEqual(sampleProductGallery({slug},generated,true),generated);
    assert.deepEqual(sampleProductGallery({slug},[asset],true),[asset]);
    assert.deepEqual(sampleProductGallery({slug},original,false),original);
    assert.deepEqual(sampleProductGallery({slug},['/v1/media/admin-upload'],true),['/v1/media/admin-upload']);
    assert.ok((await stat(new URL('../viicasa-frontend-prototype'+asset,import.meta.url))).size>0);
    assert.ok((await stat(new URL('../viicasa-frontend-prototype'+sampleGalleryDetails[slug],import.meta.url))).size>0);
  }
  assert.deepEqual(sampleProductGallery({slug:'real-vase'},['/assets/objects.png'],true),['/assets/objects.png']);
});
test('viewer provides keyboard, swipe, focus restoration, bounded loading and animated cancellation',async()=>{
  const source=await readFile(new URL('../viicasa-frontend-prototype/photo-gallery.js',import.meta.url),'utf8');
  for(const part of ['ArrowLeft','ArrowRight','pointerup',"addEventListener('cancel'",'opener.focus({preventScroll:true})','8000','current.style.visibility','flyPhoto'])assert.ok(source.includes(part));
  assert.doesNotMatch(source,/innerHTML/); // Customer/admin names and photo URLs use safe DOM APIs in the viewer.
  const css=await readFile(new URL('../viicasa-frontend-prototype/photo-gallery.css',import.meta.url),'utf8');
  assert.match(css,/grid-template-columns:minmax\(0,1fr\)/);assert.match(css,/min-width:0;width:100%/);assert.match(css,/\.vii-photo-close\{[^}]*flex-shrink:0/);
  assert.match(css,/\.gallery\.pair\{[^}]*grid-template-columns:1\.35fr 1fr;grid-template-rows:minmax\(0,1fr\)/);
});
