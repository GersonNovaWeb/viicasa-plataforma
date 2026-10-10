import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mountViiLifeOrders} from '../viicasa-frontend-prototype/viilife-admin-ui.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
test('dashboard renders review controls only for eligible orders and filters the loaded page',async()=>{
  const nodes=new Map(),events={};const container={innerHTML:'',querySelector:s=>{if(!nodes.has(s))nodes.set(s,{innerHTML:'',textContent:''});return nodes.get(s);},addEventListener:(name,handler)=>events[name]=handler};
  const row={customer:{name:'<script>customer</script>',email:'test@example.invalid',phone:'12345'},quote:{large:true,total_minor:9999,currency:'CAD'},notes:'<script>notes</script>'};
  const items=[{...row,id:'one',checkout_id:'first',payment_status:'awaiting_approval',approval:{status:'pending'}},{...row,id:'two',checkout_id:'second',payment_status:'confirmed',amount_paid:true,payment_started:true}];
  await mountViiLifeOrders({container,api:async path=>path==='/admin/mail-status'?{mode:'smtp',pending:2,failed:0,delivery:{last_error:'FIRESTORE_PRECONDITION'}}:{items},L:(es,en)=>en,esc:escape,money:(v,c)=>`${v/100} ${c}`,receipt:()=>'<p>Receipt</p>'});
  const html=nodes.get('[data-orders]').innerHTML;
  assert.ok(html.includes('data-review="approve"'));assert.ok(html.includes('data-review="cancel"'));assert.ok(html.includes('Customer contacted'));
  assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
  nodes.get('[data-filter]').onchange({target:{value:'confirmed'}});
  assert.ok(!nodes.get('[data-orders]').innerHTML.includes('data-review='));assert.ok(nodes.get('[data-orders]').innerHTML.includes('No second payment'));
  assert.ok(nodes.get('[data-mail-status]').textContent.includes('FIRESTORE_PRECONDITION'));
  assert.equal(typeof events.submit,'function');assert.equal(typeof events.click,'function');
});
