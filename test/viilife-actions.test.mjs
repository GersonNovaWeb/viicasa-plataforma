import {test} from 'node:test';
import assert from 'node:assert/strict';
import {viilifeActions,bindViiLifeActions} from '../viicasa-frontend-prototype/viilife-actions.js';

test('every ViiLife panel offers booking, next section and a contextual enquiry in both languages',()=>{
  for(const lang of ['en','es'])for(let index=0;index<3;index++){
    const html=viilifeActions(index,lang);
    assert.ok(html.includes('href="/viilife/limpieza"'));
    assert.ok(html.includes(`data-go="${index+1}"`));
    assert.ok(html.includes(`data-viilife-inquiry="${index}"`));
    assert.ok(html.includes('aria-haspopup="dialog"'));
    assert.ok(html.includes(lang==='es'?'Contratar limpieza':'Book cleaning'));
    assert.ok(html.includes(lang==='es'?'Información especial':'Special enquiries'));
    assert.equal((html.match(/<button /g)||[]).length,2);
  }
  assert.throws(()=>viilifeActions(3),RangeError);
});

test('booking uses the form, modifier clicks keep the link, enquiry preserves service context',()=>{
  const handlers={};let bookings=0,context=null,prevented=0;
  const root={querySelectorAll:selector=>selector==='.viilife-book'
    ?[{addEventListener:(event,fn)=>handlers.book=fn}]
    :[0,1,2].map(index=>({dataset:{viilifeInquiry:String(index)},addEventListener:(event,fn)=>handlers[index]=fn}))};
  bindViiLifeActions(root,{book:()=>bookings++,enquire:index=>context=index});
  handlers.book({button:0,preventDefault:()=>prevented++});
  assert.equal(bookings,1);assert.equal(prevented,1);
  handlers.book({ctrlKey:true,preventDefault:()=>assert.fail('Preserve new tab')});
  assert.equal(bookings,1);
  for(let i=0;i<3;i++){handlers[i]();assert.equal(context,i);}
});
