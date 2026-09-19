import { configFromEnv } from '../src/config.js';
import { openDatabase,migrate,one } from '../src/db.js';
import { id } from '../src/lib.js';
const config=configFromEnv();
if(config.driver==='firestore'){
  await import('./firestore-seed.js');
}else{
if(config.production)throw new Error('Los datos de demostración no se cargan en producción');
const db=await openDatabase(config);
try{
  await migrate(db);
  await db.transaction(async tx=>{
    if(!await one(tx,"SELECT id FROM properties WHERE slug='casa-demo-viicasa'"))await tx.query(`INSERT INTO properties
      (id,slug,name,description,location,timezone,capacity,bedrooms,bathrooms,nightly_minor,cleaning_minor,deposit_percent,min_nights,currency,policies,published)
      VALUES($1,'casa-demo-viicasa','Casa de demostración VIICASA','Datos ficticios para pruebas locales','Valle de Bravo','America/Mexico_City',6,3,2,250000,50000,30,2,'MXN','Política de ejemplo; sustituir antes de publicar',true)`,[id()]);
    if(!await one(tx,"SELECT id FROM products WHERE slug='jarron-demo'")){
      const productId=id();await tx.query(`INSERT INTO products(id,slug,name,description,category,published) VALUES($1,'jarron-demo','Jarrón de demostración','Producto ficticio','Decoración',true)`,[productId]);
      const variantId=id();await tx.query(`INSERT INTO variants(id,product_id,sku,name,price_minor,currency,stock) VALUES($1,$2,'DEMO-JARRON-01','Natural',85000,'MXN',10)`,[variantId,productId]);
      await tx.query(`INSERT INTO stock_movements(id,variant_id,delta,reason) VALUES($1,$2,10,'demo seed')`,[id(),variantId]);
    }
  });console.log('Catálogo de ejemplo disponible. No se crearon usuarios ni pagos.');
}finally{await db.close();}
}
