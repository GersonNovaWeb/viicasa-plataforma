import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileTypeFromBuffer} from 'file-type';
import {id,fail} from './lib.js';
import {now,key,must,clean,searchTerms,auditDoc,claimUnique} from './firestore-store.js';
import {blockCalendar,unblockCalendar,calendar,enqueue} from './firestore-commerce.js';
import * as s from './firestore-schemas.js';
import {installDemoProperties} from './demo-properties.js';

export const adminSchema=(tag,extra={})=>({tags:[tag],security:[{bearerAuth:[]}],...extra});
// Cursor pagination avoids Firestore billing for skipped documents. Offset is capped for old clients.
export const pageSchema=s.object({limit:s.int(1,100),offset:s.int(0,1000),cursor:s.str(800)},[]);
function cursorDecode(encoded){
  if(!encoded)return undefined;
  try{const values=JSON.parse(Buffer.from(encoded,'base64url').toString());
    if(values.length!==2||values.some(x=>typeof x!=='string')||!/^[0-9a-f-]{36,64}$/.test(values[1]))throw new Error();return values;
  }catch{fail(400,'Cursor inválido');}
}
export async function listPage(store,collection,input={},where=[]){
  const limit=input.limit??20,offset=input.offset??0;
  const rows=await store.list(collection,{where,order:[['created_at','desc'],['__name__','desc']],cursor:cursorDecode(input.cursor),offset,limit:limit+1});
  const items=rows.slice(0,limit),last=items.at(-1);
  return{items:items.map(clean),limit,offset,next_cursor:rows.length>limit?Buffer.from(JSON.stringify([last.created_at,last.id])).toString('base64url'):null};
}
function validateProperty(data){try{new Intl.DateTimeFormat('en',{timeZone:data.timezone});}catch{fail(400,'Zona horaria inválida');}}
export async function saveCatalog(store,actor,collection,input,recordId){
  if(collection==='properties')validateProperty(input);
  return store.transaction(async tx=>{
    const previous=recordId?must(await tx.get(collection,recordId)):null,record={...previous,...input,id:recordId||id(),
      archived:previous?.archived??false,created_at:previous?.created_at||now(),updated_at:now(),search_terms:searchTerms(`${input.name} ${input.location||input.category}`)};
    await claimUnique(tx,`${collection}-slug`,input.slug,record.id);
    if(previous&&previous.slug!==input.slug)tx.remove('unique_keys',key(`${collection}-slug`,previous.slug));
    tx.put(collection,record.id,record);auditDoc(tx,actor,`${collection}.${previous?'update':'create'}`,record.id);return clean(record);
  });
}
export async function saveVariant(store,actor,productId,input,variantId){
  return store.transaction(async tx=>{
    const previous=variantId?must(await tx.get('variants',variantId)):null;
    const product=must(await tx.get('products',productId||previous.product_id));
    if(!previous&&(product.variant_count||0)>=100)fail(400,'Máximo 100 variantes por producto');
    const record={...previous,...input,id:variantId||id(),product_id:productId||previous.product_id,created_at:previous?.created_at||now()};
    await claimUnique(tx,'sku',record.sku,record.id);
    if(previous&&previous.sku!==input.sku)tx.remove('unique_keys',key('sku',previous.sku));
    tx.put('variants',record.id,record);
    if(!previous){
      tx.put('products',product.id,{...product,variant_count:(product.variant_count||0)+1});
      const mid=id();tx.create('stock_movements',mid,{variant_id:record.id,delta:record.stock,reason:'initial',actor_id:actor,checkout_id:null,created_at:now()});
    }
    auditDoc(tx,actor,`variant.${previous?'update':'create'}`,record.id);return record;
  });
}
export async function registerCatalog(app,store,config,guard){
  app.post('/v1/admin/demo-properties',{preHandler:guard.admin(['admin']),schema:adminSchema('Administración catálogo',{
    body:s.object({confirm:{const:true}}),
  })},async request=>{
    if(config.production&&config.paymentProvider!=='disabled')fail(409,'Desactiva los pagos antes de cargar propiedades de prueba');
    return installDemoProperties(store,request.user.id);
  });
  app.get('/v1/shop/settings',{schema:{tags:['Catálogo público']}},async()=>({items:await store.list('shop_settings',{limit:10})}));
  app.put('/v1/admin/shop/settings/:currency',{preHandler:guard.admin(['admin']),schema:adminSchema('Administración catálogo',{
    params:s.object({currency:s.currency}),body:s.object({pickup_enabled:s.bool,shipping_enabled:s.bool,shipping_minor:s.int(),pickup_instructions:s.str(3000,0),terms:s.str(5000,0)})})},async request=>store.transaction(async tx=>{
    const record={currency:request.params.currency,...request.body};tx.put('shop_settings',record.currency,record);
    auditDoc(tx,request.user.id,'shop.settings',record.currency);return record;
  }));
  for(const [collection,body]of [['properties',s.propertyBody],['products',s.productBody]]){
    app.get(`/v1/${collection}`,{schema:{tags:['Catálogo público'],querystring:s.object({...pageSchema.properties,q:s.str(24,0)},[])}},async request=>{
      const where=[['published','==',true],['archived','==',false]],q=request.query.q;
      if(q){const words=q.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
        if(!/^[a-z0-9]+$/.test(words))fail(400,'La búsqueda inicial admite una palabra o prefijo');where.push(['search_terms','array-contains',words]);}
      return listPage(store,collection,request.query,where);
    });
    app.get(`/v1/${collection}/:slug`,{schema:{tags:['Catálogo público'],params:s.object({slug:s.slug})}},async request=>{
      const index=await store.get('unique_keys',key(`${collection}-slug`,request.params.slug));
      const row=index?await store.get(collection,index.owner):null;if(!row||!row.published||row.archived)fail(404,'Publicación no encontrada');
      if(collection==='products')row.variants=await store.list('variants',{where:[['product_id','==',row.id],['active','==',true]],limit:100});return clean(row);
    });
    app.get(`/v1/admin/${collection}`,{preHandler:guard.admin(),schema:adminSchema('Administración catálogo',{querystring:pageSchema})},request=>listPage(store,collection,request.query));
    app.get(`/v1/admin/${collection}/:id`,{preHandler:guard.admin(),schema:adminSchema('Administración catálogo',{params:s.idParams})},async request=>{
      const row=must(await store.get(collection,request.params.id));
      if(collection==='products')row.variants=await store.list('variants',{where:[['product_id','==',row.id]],limit:100});return clean(row);
    });
    app.post(`/v1/admin/${collection}`,{preHandler:guard.admin(['admin','catalog']),schema:adminSchema('Administración catálogo',{body})},async(request,reply)=>{
      const row=await saveCatalog(store,request.user.id,collection,request.body);reply.code(201);return row;
    });
    app.put(`/v1/admin/${collection}/:id`,{preHandler:guard.admin(['admin','catalog']),schema:adminSchema('Administración catálogo',{params:s.idParams,body})},request=>saveCatalog(store,request.user.id,collection,request.body,request.params.id));
    app.delete(`/v1/admin/${collection}/:id`,{preHandler:guard.admin(['admin','catalog']),schema:adminSchema('Administración catálogo',{params:s.idParams})},async(request,reply)=>{
      await store.transaction(async tx=>{const row=must(await tx.get(collection,request.params.id));tx.put(collection,row.id,{...row,archived:true,published:false,updated_at:now()});auditDoc(tx,request.user.id,`${collection}.archive`,row.id);});reply.code(204).send();
    });
  }
  app.post('/v1/admin/products/:id/variants',{preHandler:guard.admin(['admin','catalog']),schema:adminSchema('Inventario',{params:s.idParams,body:s.variantBody})},async(request,reply)=>{
    const row=await saveVariant(store,request.user.id,request.params.id,request.body);reply.code(201);return row;
  });
  const {stock,...editable}=s.variantBody.properties;
  app.put('/v1/admin/variants/:id',{preHandler:guard.admin(['admin','catalog']),schema:adminSchema('Inventario',{params:s.idParams,body:s.object(editable,s.variantBody.required.filter(name=>name!=='stock'))})},request=>saveVariant(store,request.user.id,null,request.body,request.params.id));
  app.post('/v1/admin/variants/:id/stock',{preHandler:guard.admin(['admin','catalog']),schema:adminSchema('Inventario',{params:s.idParams,body:s.object({delta:s.int(-1000000,1000000),reason:s.str(300)})})},request=>store.transaction(async tx=>{
    const row=must(await tx.get('variants',request.params.id)),stock=row.stock+request.body.delta;
    if(stock<0||stock>1000000)fail(409,'Existencia resultante fuera de rango');
    tx.put('variants',row.id,{...row,stock});const mid=id();tx.create('stock_movements',mid,{variant_id:row.id,...request.body,actor_id:request.user.id,checkout_id:null,created_at:now()});
    auditDoc(tx,request.user.id,'stock.adjust',row.id,request.body);return{...row,stock};
  }));
  app.get('/v1/admin/variants/:id/movements',{preHandler:guard.admin(),schema:adminSchema('Inventario',{params:s.idParams,querystring:pageSchema})},request=>listPage(store,'stock_movements',request.query,[['variant_id','==',request.params.id]]));
  app.get('/v1/admin/properties/:id/calendar',{preHandler:guard.admin(),schema:adminSchema('Calendario',{params:s.idParams,querystring:s.object({from:s.date,to:s.date})})},request=>calendar(store,request.params.id,request.query.from,request.query.to));
  app.post('/v1/admin/properties/:id/calendar-blocks',{preHandler:guard.admin(['admin','catalog']),schema:adminSchema('Calendario',{params:s.idParams,body:s.object({check_in:s.date,check_out:s.date,reason:s.str(300)})})},async(request,reply)=>{
    const row=await blockCalendar(store,request.user.id,request.params.id,request.body);reply.code(201);return row;
  });
  app.delete('/v1/admin/calendar-blocks/:id',{preHandler:guard.admin(['admin','catalog']),schema:adminSchema('Calendario',{params:s.idParams})},async(request,reply)=>{await unblockCalendar(store,request.user.id,request.params.id);reply.code(204).send();});
  app.post('/v1/inquiries',{schema:{tags:['Consultas'],body:s.object({property_id:s.uuid,name:s.str(120),email:s.email,phone:s.str(30,5),message:s.str(5000),consent:{const:true}},['name','email','phone','message','consent'])},config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async(request,reply)=>{
    const row=await store.transaction(async tx=>{
      if(request.body.property_id){const p=must(await tx.get('properties',request.body.property_id));if(!p.published||p.archived)fail(404,'Propiedad no encontrada');}
      const result={id:id(),...request.body,status:'new',created_at:now()};tx.create('inquiries',result.id,result);
      await enqueue(tx,`inquiry:${result.id}`,config.adminEmail,'VIICASA · Nueva consulta',`${result.name}\n${result.email}\n${result.phone}\n${result.message}`);return{id:result.id};
    });reply.code(201);return row;
  });
  app.get('/v1/admin/inquiries',{preHandler:guard.admin(['admin','support','viewer']),schema:adminSchema('Consultas',{querystring:pageSchema})},request=>listPage(store,'inquiries',request.query));
  app.patch('/v1/admin/inquiries/:id',{preHandler:guard.admin(['admin','support']),schema:adminSchema('Consultas',{params:s.idParams,body:s.object({status:s.choice(['new','attended','archived'])})})},request=>store.transaction(async tx=>{
    const row=must(await tx.get('inquiries',request.params.id)),updated={...row,status:request.body.status};tx.put('inquiries',row.id,updated);auditDoc(tx,request.user.id,'inquiry.update',row.id);return updated;
  }));
  await mkdir(config.mediaDir,{recursive:true});
  app.post('/v1/admin/media',{preHandler:guard.admin(['admin','catalog']),schema:adminSchema('Multimedia',{summary:'Subir imagen PNG/JPEG/WebP/GIF, máximo 8 MiB'})},async(request,reply)=>{
    const upload=await request.file({limits:{files:1,fileSize:8*1024*1024,fields:0}});if(!upload)fail(400,'Falta archivo');
    const buffer=await upload.toBuffer(),detected=await fileTypeFromBuffer(buffer);
    if(!detected||!['image/jpeg','image/png','image/webp','image/gif'].includes(detected.mime))fail(415,'Formato de imagen no admitido');
    const mid=id(),filename=`${mid}.${detected.ext}`;await writeFile(join(config.mediaDir,filename),buffer,{flag:'wx'});
    await store.transaction(async tx=>{tx.create('media',mid,{filename,mime:detected.mime,bytes:buffer.length,actor_id:request.user.id,created_at:now()});auditDoc(tx,request.user.id,'media.upload',mid);});
    reply.code(201);return{id:mid,url:`/v1/media/${mid}`,mime:detected.mime,bytes:buffer.length};
  });
  app.get('/v1/media/:id',{schema:{tags:['Multimedia'],params:s.idParams}},async(request,reply)=>{
    const media=must(await store.get('media',request.params.id),'Imagen no encontrada');
    return reply.type(media.mime).header('Cache-Control','public, max-age=31536000, immutable').send(await readFile(join(config.mediaDir,media.filename)));
  });
}
