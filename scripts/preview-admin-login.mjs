// Design-only preview. Does not load private environment files or contact APIs.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {adminLoginPage} from '../viicasa-frontend-prototype/admin-access-ui.js';
const root=new URL('../viicasa-frontend-prototype/',import.meta.url);
const port=Number(process.env.PORT||3045);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid preview port');
const allowed=new Map([['/styles.css','text/css'],['/platform.css','text/css'],['/cleaning.css','text/css'],['/admin-access-ui.js','text/javascript'],['/assets/interior.png','image/png']]);
const server=http.createServer(async(req,res)=>{
  try{
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405).end();return;}
    const url=new URL(req.url,'http://127.0.0.1');
    if(allowed.has(url.pathname)){
      const body=await readFile(new URL(url.pathname.slice(1),root));res.writeHead(200,{'Content-Type':allowed.get(url.pathname),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:body);return;
    }
    if(!['/','/admin'].includes(url.pathname)){res.writeHead(404).end('Design preview only');return;}
    const lang=url.searchParams.get('lang')==='en'?'en':'es',L=(es,en)=>lang==='en'?en:es;
    const page=adminLoginPage(L,{passwordEnabled:true,googleEnabled:true});
    const hydrate=`<script type="module">
      import {bindAdminPasswordLogin} from '/admin-access-ui.js';
      const lang=${JSON.stringify(lang)},L=(es,en)=>lang==='en'?en:es;
      document.documentElement.lang=lang;document.body.classList.add('platform');
      document.querySelector('#feed').innerHTML=${JSON.stringify(page)};
      document.querySelector('#navigation').innerHTML='<a href="/">'+L('Propiedades','Properties')+'</a><a href="/">ViiShop</a><a href="/">ViiConcierge</a><a href="/">ViiLife</a>';
      document.querySelector('#account').textContent=L('Mi cuenta','My account');
      const header=document.querySelector('.header');
      new ResizeObserver(()=>document.documentElement.style.setProperty('--header-height',header.getBoundingClientRect().height+'px')).observe(header);
      document.querySelector('#menu-toggle').onclick=event=>{const open=header.classList.toggle('menu-open');event.currentTarget.setAttribute('aria-expanded',String(open));};
      document.querySelectorAll('[data-language]').forEach(button=>{button.setAttribute('aria-pressed',String(button.dataset.language===lang));button.onclick=()=>location.assign('/admin?lang='+button.dataset.language);});
      document.querySelector('.admin-google-login').onclick=event=>{event.preventDefault();alert(L('Vista de diseño: Google no se conecta desde esta pantalla de prueba.','Design preview: Google does not connect from this test screen.'));};
      bindAdminPasswordLogin({L,api:async()=>{throw Object.assign(new Error('Design preview only'),{status:401});},onSuccess:async()=>{}});
    </script>`;
    let html=(await readFile(new URL('index.html',root),'utf8')).replace('<script src="/platform.js" type="module"></script>',hydrate);
    html=html.replace('</body>',`<div class="admin-design-preview-note" style="position:fixed;bottom:0;left:0;right:0;padding:5px 12px;text-align:center;background:#243d34;color:#fff;font:10px Arial;z-index:40">${L('Vista local de diseño · Sin conexiones ni cambios de cuenta','Local design preview · No connections or account changes')}</div></body>`);
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:html);
  }catch{res.writeHead(500).end('Preview unavailable');}
});
server.listen(port,'127.0.0.1',()=>console.log(`VIICASA login preview: http://127.0.0.1:${port}/admin`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
