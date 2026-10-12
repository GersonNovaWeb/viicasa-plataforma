import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {publicProductsPage} from '../viicasa-backend/src/firestore-catalog.js';
const where=[['published','==',true],['archived','==',false]];
const missing=()=>Object.assign(Error('The query requires an index'),{code:9});
function storeFor(rows){return{list:async(c,o)=>{
  assert.equal(c,'products');if(o.where)throw missing();
  assert.ok(o.limit<=100);assert.deepEqual(o.order,[['created_at','desc'],['__name__','desc']]);
  const start=o.cursor?rows.findIndex(r=>r.id===o.cursor[1])+1:o.offset||0;
  return rows.slice(start,start+o.limit);
}};}
const makeRows=n=>Array.from({length:n},(_,i)=>({id:randomUUID(),created_at:new Date(Date.UTC(2026,0,1)-i*1000).toISOString(),published:i%3!==0,archived:i%7===0,search_terms:['linen'],name:'Product '+i}));
test('index fallback preserves stable pages, filters drafts/archives and never exposes search internals',async()=>{
  const rows=makeRows(245),store=storeFor(rows),got=[];let cursor;
  do{const result=await publicProductsPage(store,{limit:7,...(cursor?{cursor}:{})},where);got.push(...result.items);cursor=result.next_cursor;}while(cursor);
  assert.deepEqual(got.map(r=>r.id),rows.filter(r=>r.published&&!r.archived).map(r=>r.id));
  assert.equal(got.some(r=>'search_terms'in r),false);
});
test('fallback scan is bounded and cursor advances even across a page of unpublished products',async()=>{
  const rows=makeRows(601).map((r,i)=>({...r,published:i===600,archived:false}));
  const first=await publicProductsPage(storeFor(rows),{limit:20},where);assert.equal(first.items.length,0);assert.ok(first.next_cursor);
  const second=await publicProductsPage(storeFor(rows),{limit:20,cursor:first.next_cursor},where);assert.deepEqual(second.items.map(r=>r.id),[rows[600].id]);assert.equal(second.next_cursor,null);
});
test('search filtering remains exact; unrelated failures are not hidden',async()=>{
  const rows=makeRows(12);rows[1].search_terms=['vase'];
  const result=await publicProductsPage(storeFor(rows),{},[...where,['search_terms','array-contains','vase']]);assert.deepEqual(result.items.map(r=>r.id),[rows[1].id]);
  for(const error of [Error('network failure'),Object.assign(Error('Permission denied'),{code:7}),Object.assign(Error('Other precondition'),{code:9})])await assert.rejects(publicProductsPage({list:async()=>{throw error;}},{},where),e=>e===error);
});
test('shop appends catalogue to the immersive feed and uses inline retries and non-snap scrolling',async()=>{
  const js=await readFile(new URL('../viicasa-frontend-prototype/platform.js',import.meta.url),'utf8');
  const css=await readFile(new URL('../viicasa-frontend-prototype/cleaning.css',import.meta.url),'utf8');
  assert.match(js,/section.id='viishop-products'/);assert.match(js,/void catalogue\(section\)/);assert.match(js,/data-retry-products/);
  assert.match(js,/href="\/shop#viishop-products"/);assert.doesNotMatch(js,/location.href=path==='\/shop'\?'\/coleccion'/);
  assert.match(css,/\.viishop-products\{scroll-snap-align:none;scroll-snap-stop:normal/);
});
