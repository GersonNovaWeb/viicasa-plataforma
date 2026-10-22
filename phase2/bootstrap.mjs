import {randomUUID} from 'node:crypto';
import {passwordHash} from '../viicasa-backend/src/lib.js';
import {installDemoProducts} from '../viicasa-backend/src/demo-products.js';
import {installDemoProperties} from '../viicasa-backend/src/demo-properties.js';
import {defaultCleaningSettings} from '../viicasa-backend/src/cleaning.js';
import {quoteService} from './service-menu.mjs';

export const demoCredentials={admin:{email:'admin@viicasa.demo.invalid',password:'ViiCasa-Demo-2026!'},seller:{email:'seller@viicasa.demo.invalid',password:'ViiCasa-Seller-2026!'}};
export async function seedPhase2({commercial:db,store},{seed=true}={}){
  if(!seed)return;
  const profile=(await db.query("SELECT value FROM phase2_settings WHERE key='runtime_profile'")).rows[0]?.value;if(profile&&profile.mode!=='demo')throw Error('Example seeding is disabled outside the demo profile.');
  if((await db.query('SELECT count(*)::integer AS n FROM team_users')).rows[0].n===0){
    const admin=randomUUID(),seller=randomUUID();
    const [adminHash,sellerHash]=await Promise.all([passwordHash(demoCredentials.admin.password),passwordHash(demoCredentials.seller.password)]);
    await db.transaction(async tx=>{
      await tx.query("INSERT INTO team_users(id,email,name,password_hash,role,goal_minor) VALUES($1,$2,'VII Demo Admin',$3,'admin',0),($4,$5,'Alex Morgan · Demo',$6,'seller',2000000)",[admin,demoCredentials.admin.email,adminHash,seller,demoCredentials.seller.email,sellerHash]);
      for(const service of ['home','commercial','shop','concierge'])await tx.query('INSERT INTO commission_rules(service,basis_points,approved) VALUES($1,500,false)',[service]);
      for(const [name,service,stage,company]of [['Taylor Reed','home','new',''],['Jordan Blake','commercial','proposal','Okanagan Studio · Demo'],['Casey Ellis','concierge','contacted','']]){
        const id=randomUUID();await tx.query("INSERT INTO crm_leads(id,owner_id,name,email,phone,company,service,stage,priority,source,notes) VALUES($1,$2,$3,$4,'+1 250 555 0100',$5,$6,$7,'normal','Demo seed','Fictional prospect for Phase 2 review.')",[id,seller,name,name.toLowerCase().replace(' ','.')+'@example.invalid',company,service,stage]);
      }
    });
  }
  // Draft examples only. Editing/rejecting them never makes them return on restart.
  await db.transaction(async tx=>{
    for(const [service,email,selection]of [
      ['home','taylor.reed@example.invalid',{service_id:'home-standard',rate_minor:11000,quantity:1,visits:2,frequency:'weekly',term:'month_to_month',properties:[]}],
      ['commercial','jordan.blake@example.invalid',{service_id:'commercial-team',rate_minor:7500,quantity:2,visits:4,frequency:'weekly',term:'annual',properties:[{address:'100 Demo Office',sqft:1000},{address:'200 Demo Office',sqft:2000}]}],
    ]){
      const key='phase2-example-quote-'+service;
      if((await tx.query('SELECT 1 FROM service_quotes WHERE demo_key=$1',[key])).rows.length)continue;
      const lead=(await tx.query("SELECT id,owner_id FROM crm_leads WHERE email=$1 AND service=$2 AND source='Demo seed' LIMIT 1",[email,service])).rows[0];if(!lead)continue;
      await tx.query('INSERT INTO service_quotes(id,lead_id,actor_id,selection,result,demo_key) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),lead.id,lead.owner_id,JSON.stringify({lead_id:lead.id,...selection}),JSON.stringify(quoteService(selection)),key]);
    }
  });
  await installDemoProducts(store,'phase2-bootstrap');await installDemoProperties(store,'phase2-bootstrap');
  if(!await store.get('cleaning_settings','main'))await store.set('cleaning_settings','main',{...defaultCleaningSettings(),revision:1,enabled:true,pricing_confirmed:true,country:'CA',currency:'CAD'});
  for(const currency of ['CAD','USD'])if(!await store.get('system','phase2-delivery-'+currency)){
    await store.set('shop_settings',currency,{currency,pickup_enabled:true,shipping_enabled:false,shipping_minor:0,pickup_instructions:'Demo pickup only. No goods are delivered.',terms:'Phase 2 demo purchase; fictional merchandise.'});
    await store.set('system','phase2-delivery-'+currency,{applied:true});
  }
}
