import {test} from 'node:test';
import assert from 'node:assert/strict';
import {receiptSample} from './fixtures/viilife-receipt.mjs';
import {receiptSnapshot,receiptAttachment,renderViiLifeReceipt} from '../viicasa-backend/src/viilife-receipt.js';
import {notice} from '../viicasa-backend/src/firestore-commerce.js';
import {deliverMail} from '../viicasa-backend/src/firestore-payments.js';

test('PDF is a bounded binary attachment with a safe filename and an immutable snapshot',async()=>{
  const input=structuredClone(receiptSample),snapshot=receiptSnapshot(input);input.customer.name='Changed';
  assert.equal(snapshot.customer.name,'Mary Smith');
  const a=await receiptAttachment({...snapshot,reference:'../../test\r\n.pdf'});
  assert.equal(a.contentType,'application/pdf');assert.equal(a.contentDisposition,'attachment');
  assert.equal(a.content.subarray(0,5).toString(),'%PDF-');assert.ok(a.content.length<500000);
  assert.doesNotMatch(a.filename,/[\/\\\r\n]/);
  await assert.rejects(renderViiLifeReceipt({...snapshot,event:'requested'}),/Invalid receipt state/);
  await assert.rejects(renderViiLifeReceipt({...snapshot,paidMinor:-1}),/Invalid receipt amount/);
});
test('only customer paid/review notices get PDFs; no admin, failed or approval attachments',async()=>{
  const s=receiptSample,c={id:s.reference,kind:'cleaning',customer_name:s.customer.name,customer_email:s.customer.email,customer_phone:s.customer.phone,due_minor:s.paidMinor,detail:s};
  const config={paymentProvider:'stripe',stripeKey:'sk_test_fixture',adminEmail:'team@example.invalid'};
  for(const [status,wantsPDF] of [['confirmado',true],['pago recibido en revisión',true],['pago vencido',false],['pago rechazado',false],['cancelada',false]]){
    const rows=new Map(),tx={get:async(_,id)=>rows.get(id),create:(_,id,row)=>rows.set(id,row)};
    await notice(tx,c,status,config);await notice(tx,c,status,config);
    const customer=[...rows.values()].find(r=>r.recipient===s.customer.email);
    assert.equal(Boolean(customer.receipt),wantsPDF);
    assert.ok([...rows.values()].filter(r=>r.recipient===config.adminEmail).every(r=>!r.receipt));
  }
});
test('PDF failure leaves the message pending and does not send a receipt-less email',async()=>{
  let row={id:'m1',recipient:'buyer@example.invalid',subject:'Receipt',body:'Receipt',receipt:{...receiptSample,version:999},status:'pending',attempts:0,next_attempt:'2000-01-01'};
  const store={list:async()=>[row],transaction:fn=>fn({get:async()=>row,put:(_,id,value)=>{row=value;}})};
  let calls=0;const transport={sendMail:async()=>{calls++;}};
  const result=await deliverMail(store,{mailMode:'smtp',mailFrom:'accounts@example.invalid'},transport);
  assert.equal(result.failed,1);assert.equal(calls,0);assert.equal(row.status,'pending');assert.equal(row.last_error,'Receipt PDF generation failed');
  row={...row,receipt:receiptSample,next_attempt:'2000-01-01'};
  assert.equal((await deliverMail(store,{mailMode:'smtp'},transport)).sent,1);assert.equal(calls,1);assert.equal(row.status,'sent');
});
