import {id,fail} from './lib.js';
import {key,now,searchTerms,auditDoc} from './firestore-store.js';

export const demoProductsCatalogId='demo-products-v1';
export function demoProducts(){
  return [
    ['sample-terra-vase','Terra Ceramic Vase','Decoración / Decor',7900,5900,'objects.png','Jarrón de inspiración orgánica para espacios serenos.','An organically inspired vase for serene spaces.'],
    ['sample-linen-throw','Natural Linen Throw','Textiles / Textiles',12900,9500,'shop.png','Una manta de tonos naturales para vestir tu hogar.','A natural-tone throw to dress your home.'],
    ['sample-wood-sculpture','Sculptural Wood Object','Decoración / Decor',9900,7500,'objects.png','Una pieza escultórica inspirada en las formas de la naturaleza.','A sculptural accent inspired by natural forms.'],
    ['sample-home-ritual','Home Ritual Set','Hogar / Home',5900,4500,'shop.png','Un conjunto decorativo para crear un momento de calma.','A decorative collection for a moment of calm.'],
  ].map(([slug,name,category,cad,usd,image,es,en])=>({
    product:{slug,name:`${name} · Demo`,category,published:true,is_demo:true,
      description:`PRODUCTO DE PRUEBA. Imágenes ilustrativas y precios ficticios; no se entrega mercancía. ${es}\n[EN]\nTEST PRODUCT. Illustrative images and fictional prices; no goods will be delivered. ${en}`,
      images:[`/assets/${image}`]},
    variant:{sku:`DEMO-${slug.toUpperCase()}`,name:'Natural',currency:'CAD',price_minor:cad,prices:{CAD:cad,USD:usd},stock:20,active:true},
  }));
}

// Check the actual key too: a mode label alone must never permit a live charge.
export function requireSamplePaymentMode(config){
  if(config.paymentProvider==='stripe'&&config.stripeMode==='test'&&config.stripeKey?.startsWith('sk_test_'))return;
  if(config.paymentProvider==='demo'&&!config.production)return;
  fail(409,'Los productos de ejemplo solo admiten pagos de prueba con Stripe (sk_test). / Sample products only accept Stripe test payments.');
}

// Explicit admin action only. Ledger prevents renamed/archived examples from returning.
export async function installDemoProducts(store,actor){
  return store.transaction(async tx=>{
    const previous=await tx.get('system',demoProductsCatalogId);
    const installed={...previous?.installed},created=[],skipped=[];
    for(const {product,variant}of demoProducts()){
      const slugKey=key('products-slug',product.slug),skuKey=key('sku',variant.sku);
      const slugClaim=await tx.get('unique_keys',slugKey),skuClaim=await tx.get('unique_keys',skuKey);
      if(installed[product.slug]||slugClaim||skuClaim){skipped.push(product.slug);continue;}
      const p={...product,id:id(),archived:false,variant_count:1,created_at:now(),updated_at:now(),search_terms:searchTerms(`${product.name} ${product.category}`)};
      const v={...variant,id:id(),product_id:p.id,created_at:now()};
      tx.create('products',p.id,p);tx.create('variants',v.id,v);
      tx.create('unique_keys',slugKey,{owner:p.id});tx.create('unique_keys',skuKey,{owner:v.id});
      tx.create('stock_movements',id(),{variant_id:v.id,delta:v.stock,reason:'initial',actor_id:actor,checkout_id:null,created_at:now()});
      auditDoc(tx,actor,'products.demo.create',p.id,{catalog:demoProductsCatalogId});
      installed[product.slug]=p.id;created.push(product.slug);
    }
    if(!previous||created.length)tx.put('system',demoProductsCatalogId,{installed,updated_at:now()});
    return{created,skipped};
  });
}
