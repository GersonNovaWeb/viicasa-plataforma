// Local preview only: synthetic data, no environment secrets, Firestore or SMTP.
import {createServer} from 'node:http';
import {renderViiLifeMail} from '../viicasa-backend/src/viilife-mail.js';
const mail=renderViiLifeMail({reference:'VIILIFE-PREVIEW-001',issuedAt:'2026-10-07T12:00:00Z',event:'paid',demo:true,customer:{name:'Mary Smith',email:'mary@example.invalid',phone:'+1 250 555 0123'},selection:{service:'routine'},quote:{currency:'CAD',total_minor:59994,lines:[{code:'routine',amount_minor:59994}],billing:{scope:'one_cycle',hourly_minor:9999,hours_per_visit:2,visits:3,cycle:'weekly'},dates:['2026-10-12','2026-10-14','2026-10-16'],estimate_pending:[]},schedule:{start_hour:8},address:{street:'123 Example Street',city:'Kelowna',state:'BC',country:'CA',postal_code:'V1Y 1A1'}});
createServer((req,res)=>{
 res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');
 if(req.url==='/mobile')return res.end('<!doctype html><html lang="en"><title>ViiLife · Mobile email preview</title><body style="margin:0;background:#ddd"><iframe title="Mobile receipt" src="/" style="display:block;width:390px;max-width:100%;height:100vh;margin:auto;border:0"></iframe></body></html>');
 if(req.url!=='/'){res.writeHead(404);return res.end('Not found');}
 res.end(mail.html);
}).listen(3022,'127.0.0.1',()=>console.log('ViiLife email preview: http://127.0.0.1:3022/ — mobile: /mobile'));
