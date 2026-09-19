import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, extname, sep} from 'node:path';
import {handlePlatform,platformReady,maintenance,demo} from './platform-server.mjs';
const root = fileURLToPath(new URL('.', import.meta.url));
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.mp4':'video/mp4','.webm':'video/webm'};
http.createServer(async (req,res) => {
  try {
    const url=new URL(req.url,'http://localhost');
    if(await handlePlatform(req,res,url))return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {res.writeHead(405).end();return;}
    const pathname = decodeURIComponent(url.pathname);
    const file = /^(\/|\/(shop|viilife|viiconcierge|propiedades|coleccion|cuenta|checkout|admin|privacidad|pago\/resultado|pago\/cancelado)(\/[^.]+)?)$/.test(pathname) ? 'index.html' : pathname.slice(1);
    const target = resolve(root, file);
    if (!target.startsWith(root.endsWith(sep) ? root : root+sep) || !['index.html','app.js','styles.css','platform.js','platform.css','currency-ui.js'].includes(file) && !file.startsWith('assets/')) {
      res.writeHead(404).end('Not found');return;
    }
    const body = await readFile(target);
    res.writeHead(200, {'Content-Type':types[extname(target)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'strict-origin-when-cross-origin','Cross-Origin-Opener-Policy':'same-origin-allow-popups'});
    res.end(req.method==='HEAD' ? undefined : body);
  } catch {res.writeHead(404).end('Not found');}
}).listen(Number(process.env.PORT||3015),demo?'127.0.0.1':(process.env.HOST||'0.0.0.0'),()=>console.log('VIICASA: http://127.0.0.1:3015/propiedades'));
platformReady().then(()=>console.log('Platform catalog ready; '+(demo?'isolated local demo':'live mode'))).catch(()=>console.error('Backend unavailable; check Firestore configuration.'));
let working=false;setInterval(async()=>{if(working)return;working=true;try{await maintenance();}catch{/* Retry next cycle. */}finally{working=false;}},30000).unref();
