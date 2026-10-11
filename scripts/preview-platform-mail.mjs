// Synthetic fixtures only. Does not load environment, call SMTP or persist orders.
import {mkdir,writeFile} from 'node:fs/promises';
import {shopSample,bookingSample,platformMailConfig} from '../test/fixtures/platform-mail.mjs';
import {renderPurchaseMail,renderWelcomeMail,commerceReceiptSnapshot} from '../viicasa-backend/src/platform-mail.js';
import {renderViiLifeReceipt} from '../viicasa-backend/src/viilife-receipt.js';
const out=new URL('../output/pdf/',import.meta.url),tmp=new URL('../tmp/pdfs/',import.meta.url);
await mkdir(out,{recursive:true});await mkdir(tmp,{recursive:true});
for(const [name,sample]of [['viishop',shopSample],['viiconcierge',bookingSample]]){
  const snapshot=commerceReceiptSnapshot(sample,'paid',platformMailConfig);snapshot.issuedAt='2026-10-11T19:30:00Z';
  await writeFile(new URL(`${name}-receipt-preview.pdf`,out),await renderViiLifeReceipt(snapshot));
  await writeFile(new URL(`${name}-email-preview.html`,tmp),renderPurchaseMail(sample,'paid',platformMailConfig).html);
}
await writeFile(new URL('welcome-email-preview.html',tmp),renderWelcomeMail({name:'Mary Smith'},platformMailConfig.siteUrl).html);
console.log('Two PDF receipts and three email previews generated with fictional data. No messages sent.');
