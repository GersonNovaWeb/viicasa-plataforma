import {key} from '../viicasa-backend/src/firestore-store.js';

// Explicit fictional prices, NOT an exchange-rate table. Only the local emulator.
export async function seedDemoPricing(store){
  if(await store.get('system','demo-dual-currency-v1'))return;
  for(const [slug,mxn,usd,cad]of [['casa-brisa',680000,39000,54000],['villa-oliva',490000,28000,38000],['casa-lumbre',350000,21000,29000],['residencia-arena',920000,53000,73000]]){
    const index=await store.get('unique_keys',key('properties-slug',slug));
    const p=index&&await store.get('properties',index.owner);
    if(p&&p.nightly_minor===mxn&&!p.rates)await store.set('properties',p.id,{...p,rates:{USD:{nightly_minor:usd,cleaning_minor:5000},CAD:{nightly_minor:cad,cleaning_minor:7000}}});
  }
  for(const [sku,usd,cad]of [['JARRON-TERRA',10900,14900],['LINO-NATURAL',13900,18900],['RITUAL-CASA',5900,7900]]){
    const index=await store.get('unique_keys',key('sku',sku));const v=index&&await store.get('variants',index.owner);
    if(v&&!v.prices)await store.set('variants',v.id,{...v,prices:{USD:usd,CAD:cad}});
  }
  await store.set('system','demo-dual-currency-v1',{applied:true});
}
