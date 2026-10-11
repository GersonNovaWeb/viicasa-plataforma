// Synthetic preview only. No credentials, SMTP, Stripe or Firestore.
import {mkdir,writeFile} from 'node:fs/promises';
import {renderViiLifeReceipt} from '../viicasa-backend/src/viilife-receipt.js';
import {receiptSample} from '../test/fixtures/viilife-receipt.mjs';
const out=new URL('../output/pdf/',import.meta.url);await mkdir(out,{recursive:true});
await writeFile(new URL('viilife-receipt-preview.pdf',out),await renderViiLifeReceipt(receiptSample));
// Exercise overflow in a separate QA document, never sent to customers.
const tmp=new URL('../tmp/pdfs/',import.meta.url);await mkdir(tmp,{recursive:true});
await writeFile(new URL('viilife-receipt-long.pdf',tmp),await renderViiLifeReceipt({...receiptSample,customer:{...receiptSample.customer,name:'María José García - '+('Long customer name ').repeat(5)},address:{...receiptSample.address,street:'Long service address '.repeat(14)},quote:{...receiptSample.quote,total_minor:59994*18,lines:Array.from({length:18},()=>({code:'deep',amount_minor:59994}))},paidMinor:59994*18}));
console.log('Synthetic PDF receipt previews generated. No external calls.');
