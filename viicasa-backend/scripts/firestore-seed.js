import {configFromEnv} from '../src/config.js';
import {openFirestore,initializeStore,key} from '../src/firestore-store.js';
import {saveCatalog,saveVariant} from '../src/firestore-catalog.js';
const config=configFromEnv();
if(config.firebaseMode!=='emulator'||!config.firebaseProjectId.startsWith('demo-'))throw new Error('Los datos demo solo se cargan en el emulador');
const store=await openFirestore(config);
try{
  await initializeStore(store);
  if(!await store.get('unique_keys',key('properties-slug','casa-demo-viicasa')))await saveCatalog(store,null,'properties',{
    slug:'casa-demo-viicasa',name:'Casa de demostración VIICASA',description:'Datos ficticios para desarrollo local',location:'Valle de Bravo',timezone:'America/Mexico_City',
    capacity:6,bedrooms:3,bathrooms:2,nightly_minor:250000,cleaning_minor:50000,deposit_percent:30,min_nights:2,currency:'MXN',images:[],amenities:['WiFi'],policies:'Política de ejemplo',published:true});
  if(!await store.get('unique_keys',key('products-slug','jarron-demo'))){
    const p=await saveCatalog(store,null,'products',{slug:'jarron-demo',name:'Jarrón de demostración',description:'Producto ficticio',category:'Decoración',images:[],published:true});
    await saveVariant(store,null,p.id,{sku:'DEMO-JARRON-01',name:'Natural',price_minor:85000,currency:'MXN',stock:10,active:true});
  }
  console.log('Catálogo demo listo en el emulador; sin usuarios ni cobros.');
}finally{await store.close();}
