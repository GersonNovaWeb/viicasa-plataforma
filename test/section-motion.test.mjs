import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {installSectionMotion,sectionDirection} from '../viicasa-frontend-prototype/section-motion.js';
function fixture({path='/shop',reduced=false,storageWorks=true,animate=true,viewTransitions=false}={}){
  const handlers={},events={},storage=new Map(),animations=[],navigation=[],dataset={},history=[],transitions=[],attributes=new Map(),scrolls=[];
  const feed={setAttribute:(k,v)=>attributes.set(k,v),removeAttribute:k=>attributes.delete(k),scrollTo:options=>scrolls.push(options),...(animate?{animate(frames,options){const entry={frames,options,cancelled:false};animations.push(entry);return{finished:Promise.resolve(),cancel(){entry.cancelled=true;}};}}:{})};
  const win={location:{pathname:path,origin:'https://viicasa.example',href:'https://viicasa.example'+path,assign:url=>navigation.push(url)},innerWidth:390,matchMedia:()=>({matches:reduced}),setTimeout,clearTimeout,
    sessionStorage:{setItem(k,v){if(!storageWorks)throw Error('unavailable');storage.set(k,v);},getItem:k=>storage.get(k),removeItem:k=>storage.delete(k)},addEventListener:(n,fn)=>events[n]=fn};
  win.history={pushState(state,title,url){history.push(url);const parsed=new URL(url);Object.assign(win.location,{pathname:parsed.pathname,href:parsed.href});}};
  const doc={body:{classList:{remove(){}}},documentElement:{dataset},querySelector:()=>feed,addEventListener:(n,fn)=>handlers[n]=fn};
  if(viewTransitions)doc.startViewTransition=update=>{const updateCallbackDone=Promise.resolve().then(update),transition={updateCallbackDone,finished:updateCallbackDone,skipTransition(){}};transitions.push(transition);return transition;};
  const motion=installSectionMotion(win,doc);
  function click(to,extra={}){const link={href:'https://viicasa.example'+to,target:'',hasAttribute:()=>false},event={button:0,target:{closest:()=>link},preventDefault(){this.defaultPrevented=true;},...extra};handlers.click(event);return event;}
  return{motion,win,doc,click,storage,animations,navigation,dataset,events,history,transitions,attributes,scrolls};
}

test('prepared section navigation keeps the document, holds the old content and commits history once',async()=>{
  const f=fixture({viewTransitions:true}),renders=[];let ready;
  f.motion.configure({prepare:()=>new Promise(resolve=>ready=resolve),render:data=>renders.push(data)});
  assert.equal(f.click('/viilife').defaultPrevented,true);assert.equal(f.dataset.sectionLoading,'true');
  assert.equal(f.attributes.get('aria-busy'),'true');assert.equal(f.history.length,0);assert.equal(renders.length,0);
  ready('catalogue');await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(renders,['catalogue']);assert.deepEqual(f.history,['https://viicasa.example/viilife']);assert.equal(f.transitions.length,1);
  assert.equal(f.navigation.length,0);assert.equal(f.animations.length,0);assert.equal(f.dataset.sectionLoading,undefined);assert.equal(f.attributes.has('aria-busy'),false);
  await f.motion.enter();assert.equal(f.animations.length,0,'No second entrance animation after the swap.');
});
test('prepared navigation supports reduced motion, missing transition API and native modified links',async()=>{
  for(const options of [{reduced:true,viewTransitions:true},{animate:false}]){
    const f=fixture(options);let renders=0;f.motion.configure({prepare:async()=>null,render:()=>renders++});
    f.click('/viilife');await new Promise(resolve=>setImmediate(resolve));assert.equal(renders,1);assert.equal(f.navigation.length,0);assert.equal(f.transitions.length,0);
    if(options.reduced)assert.equal(f.animations.length,0);
    const before=f.history.length;f.click('/viilife');assert.equal(f.history.length,before,'Current tab does not reload.');
    for(const extra of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1}])assert.notEqual(f.click('/viiconcierge',extra).defaultPrevented,true);
    assert.notEqual(f.click('/checkout').defaultPrevented,true);assert.notEqual(f.click('/viiconcierge?return=1').defaultPrevented,true);
  }
});
test('failed preparation leaves the existing section visible without changing URL',async()=>{
  const f=fixture({viewTransitions:true});let errors=0;f.motion.configure({prepare:async()=>{throw Error('offline');},render:()=>assert.fail('Must not replace content'),onError:()=>errors++});
  f.click('/viilife');await new Promise(resolve=>setImmediate(resolve));assert.equal(errors,1);assert.equal(f.history.length,0);assert.equal(f.navigation.length,0);assert.equal(f.transitions.length,0);assert.equal(f.dataset.sectionLoading,undefined);
});
test('Back and Forward rerender clean public routes without pushing another history entry',async()=>{
  const f=fixture({viewTransitions:true}),renders=[];f.motion.configure({prepare:async url=>url.pathname,render:data=>renders.push(data)});
  f.click('/viilife');await new Promise(resolve=>setImmediate(resolve));
  Object.assign(f.win.location,{href:'https://viicasa.example/shop',pathname:'/shop'});f.events.popstate();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(renders,['/viilife','/shop']);assert.equal(f.history.length,1);assert.equal(f.navigation.length,0);assert.equal(f.transitions.length,2);
});
test('an old slow preparation cannot overwrite a newer Back navigation',async()=>{
  const f=fixture({viewTransitions:true}),ready=new Map(),renders=[];
  f.motion.configure({prepare:url=>new Promise(resolve=>ready.set(url.pathname,resolve)),render:data=>renders.push(data)});
  f.click('/viilife');Object.assign(f.win.location,{href:'https://viicasa.example/',pathname:'/'});f.events.popstate();
  ready.get('/')('home');await new Promise(resolve=>setImmediate(resolve));
  ready.get('/viilife')('old');await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(renders,['home']);assert.equal(f.history.length,0);assert.equal(f.dataset.sectionLoading,undefined);
});
test('public navigation CSS keeps the header fixed and disables snapshot cross-fading',async()=>{
  const css=await readFile(new URL('../viicasa-frontend-prototype/vii-final.css',import.meta.url),'utf8');
  assert.match(css,/body\.vii-experience \.header #navigation\{opacity:1;visibility:visible;pointer-events:auto\}/);
  assert.match(css,/view-transition-name:vii-header/);assert.match(css,/view-transition-name:vii-content/);
  assert.match(css,/view-transition-old\(vii-header\).*display:none/);
  assert.match(css,/view-transition-new\(vii-content\).*mix-blend-mode:normal;opacity:1/);
});
test('tab order determines opposite lateral directions; private and nested routes are excluded',()=>{
  assert.equal(sectionDirection('/','/shop'),1);assert.equal(sectionDirection('/viiconcierge','/viilife'),-1);
  for(const target of ['/shop','/admin','/checkout','/pedido','/shop/example'])assert.equal(sectionDirection('/shop',target),0);
});
test('normal tab click slides content only, then follows the real URL',async()=>{
  const f=fixture();assert.equal(f.click('/viilife').defaultPrevented,true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.navigation,['https://viicasa.example/viilife']);assert.equal(f.animations.length,1);
  assert.match(f.animations[0].frames[1].transform,/translateX\(-/);assert.equal(f.animations[0].options.duration,150);
  assert.equal(f.animations[0].options.fill,'forwards');assert.equal(f.animations[0].cancelled,false);
  assert.ok(f.animations[0].frames.every(frame=>!('opacity' in frame)));
  assert.equal(f.dataset.sectionMotion,undefined);
  const destination=fixture({path:'/viilife'});for(const [k,v]of f.storage)destination.storage.set(k,v);
  await destination.motion.enter();assert.equal(destination.animations.length,1);assert.equal(destination.animations[0].options.duration,360);assert.equal(destination.storage.size,0);
  assert.ok(destination.animations[0].frames.every(frame=>!('opacity' in frame)));assert.equal(destination.animations[0].cancelled,true);
  f.events.pageshow({persisted:true});assert.equal(f.animations[0].cancelled,true);
  await destination.motion.enter();assert.equal(destination.animations.length,1);
});
test('the first HTML paint uses a light shell before JavaScript and async catalogue loading',async()=>{
  const html=await readFile(new URL('../viicasa-frontend-prototype/index.html',import.meta.url),'utf8');
  assert.match(html,/<html class="platform-shell"/);assert.match(html,/<body class="platform">/);
  assert.match(html,/<style>html.platform-shell\{background:#f7f4ee;color-scheme:light\}/);
  assert.match(html,/name="theme-color" content="#f7f4ee"/);
  assert.ok(html.indexOf('<style>')<html.indexOf('href="/styles.css"'));
});
test('native behavior is preserved for modifiers, current tab, private paths, missing storage, reduced motion and unsupported animation',()=>{
  for(const extra of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1},{defaultPrevented:true}]){
    const f=fixture();f.click('/viilife',extra);assert.equal(f.animations.length,0);assert.equal(f.storage.size,0);
  }
  for(const options of [{reduced:true},{storageWorks:false},{animate:false}])assert.notEqual(fixture(options).click('/viilife').defaultPrevented,true);
  for(const path of ['/shop','/admin','/checkout','/viilife/limpieza','/viilife?return=1','/viilife#form'])assert.notEqual(fixture().click(path).defaultPrevented,true);
});
test('stale or mismatched transitions are discarded, and returning from browser history resets pending state',async()=>{
  for(const pending of [{from:'/shop',to:'/viilife',direction:1,at:'invalid'},{from:'/shop',to:'/viilife',direction:1,at:0},{from:'/shop',to:'/viiconcierge',direction:1,at:Date.now()},{from:'/shop',to:'/viilife',direction:-1,at:Date.now()}]){
    const f=fixture({path:'/viilife'});f.storage.set('vii-section-motion',JSON.stringify(pending));await f.motion.enter();assert.equal(f.animations.length,0);assert.equal(f.storage.size,0);
  }
  const f=fixture();f.storage.set('vii-section-motion','bad');await f.motion.enter();assert.equal(f.storage.size,0);
  f.storage.set('vii-section-motion','{}');f.events.pageshow({persisted:true});assert.equal(f.storage.size,0);
});
test('cancelled browser animation never traps the customer on the source page',async()=>{
  const f=fixture();let cancelled=false;
  // Use a deliberately rejected animation to exercise the normal navigation fallback.
  const handlers={},win={...f.win},doc={documentElement:{dataset:{}},querySelector:()=>({animate:()=>({finished:Promise.reject(Error('cancelled')),cancel(){cancelled=true;}})}),addEventListener:(name,handler)=>handlers[name]=handler};
  installSectionMotion(win,doc);
  handlers.click({button:0,target:{closest:()=>({href:'https://viicasa.example/viilife',target:'',hasAttribute:()=>false})},preventDefault(){}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,true);assert.deepEqual(f.navigation,['https://viicasa.example/viilife']);
});
