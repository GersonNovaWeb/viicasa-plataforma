import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { one } from './db.js';
import { id, fail, audit, dateRange } from './lib.js';
import { enqueue } from './notifications.js';
import * as s from './schemas.js';

const pageArgs = request => [request.query.limit ?? 20, request.query.offset ?? 0];
const adminSchema = (tag, extra={}) => ({ tags:[tag],security:[{ bearerAuth:[] }],...extra });

export async function registerCatalog(app,db,config,guard) {
  app.get('/v1/shop/settings',{schema:{tags:['Catálogo público']}},async()=>({items:(await db.query('SELECT * FROM shop_settings ORDER BY currency')).rows}));
  app.put('/v1/admin/shop/settings/:currency',{preHandler:guard.admin(['admin']),schema:adminSchema('Administración catálogo',{
    params:s.object({currency:s.currency}),body:s.object({pickup_enabled:s.bool,shipping_enabled:s.bool,shipping_minor:s.int(),pickup_instructions:s.str(3000,0),terms:s.str(5000,0)})})},async request=>db.transaction(async tx=>{
    const b=request.body;
    const row=await one(tx,'UPDATE shop_settings SET pickup_enabled=$2,shipping_enabled=$3,shipping_minor=$4,pickup_instructions=$5,terms=$6 WHERE currency=$1 RETURNING *',
      [request.params.currency,b.pickup_enabled,b.shipping_enabled,b.shipping_minor,b.pickup_instructions,b.terms]);
    await audit(tx,request.user.id,'shop.settings',request.params.currency);return row;
  }));
  for (const [table,body] of [['properties',s.propertyBody],['products',s.productBody]]) {
    const columns = Object.keys(body.properties);
    const encode = (key,value) => ['images','amenities'].includes(key) ? JSON.stringify(value) : value;
    const validate = data => {
      if (table === 'properties') {
        try { new Intl.DateTimeFormat('en',{ timeZone:data.timezone }); }
        catch { fail(400,'Zona horaria inválida'); }
      }
    };
    app.get(`/v1/${table}`,{ schema:{ tags:['Catálogo público'],querystring:{...s.pagination,properties:{...s.pagination.properties,q:s.str(100,0)}} } },async request => {
      const [limit,offset] = pageArgs(request), q=request.query.q || '';
      const result=await db.query(`SELECT * FROM ${table} WHERE published=true AND archived=false
        AND (name ILIKE $3 OR ${table === 'properties' ? 'location' : 'category'} ILIKE $3) ORDER BY created_at,id LIMIT $1 OFFSET $2`,[limit,offset,`%${q}%`]);
      return { items:result.rows,limit,offset };
    });
    app.get(`/v1/${table}/:slug`,{ schema:{ tags:['Catálogo público'],params:s.object({slug:s.slug}) } },async request => {
      const item=await one(db,`SELECT * FROM ${table} WHERE slug=$1 AND published=true AND archived=false`,[request.params.slug]);
      if (!item) fail(404,'Publicación no encontrada');
      if (table === 'products') item.variants=(await db.query('SELECT id,sku,name,price_minor,currency,stock FROM variants WHERE product_id=$1 AND active=true ORDER BY sku',[item.id])).rows;
      return item;
    });
    app.get(`/v1/admin/${table}`,{ preHandler:guard.admin(),schema:adminSchema('Administración catálogo',{querystring:s.pagination}) },async request => {
      const [limit,offset]=pageArgs(request);
      return {items:(await db.query(`SELECT * FROM ${table} ORDER BY created_at DESC,id LIMIT $1 OFFSET $2`,[limit,offset])).rows,limit,offset};
    });
    app.get(`/v1/admin/${table}/:id`,{ preHandler:guard.admin(),schema:adminSchema('Administración catálogo',{params:s.idParams}) },async request => {
      const item=await one(db,`SELECT * FROM ${table} WHERE id=$1`,[request.params.id]);
      if (!item) fail(404,'Registro no encontrado');
      if(table==='products') item.variants=(await db.query('SELECT * FROM variants WHERE product_id=$1 ORDER BY sku',[item.id])).rows;
      return item;
    });
    app.post(`/v1/admin/${table}`,{ preHandler:guard.admin(['admin','catalog']),schema:adminSchema('Administración catálogo',{body}) },async(request,reply)=>{
      validate(request.body);
      const row=await db.transaction(async tx=>{
        const result=await one(tx,`INSERT INTO ${table}(id,${columns.join(',')}) VALUES(${[...columns,'id'].map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,
          [id(),...columns.map(k=>encode(k,request.body[k]))]);
        await audit(tx,request.user.id,`${table}.create`,result.id); return result;
      });
      reply.code(201);return row;
    });
    app.put(`/v1/admin/${table}/:id`,{ preHandler:guard.admin(['admin','catalog']),schema:adminSchema('Administración catálogo',{params:s.idParams,body}) },async request=>{
      validate(request.body);
      return db.transaction(async tx=>{
        const row=await one(tx,`UPDATE ${table} SET ${columns.map((k,i)=>`${k}=$${i+2}`).join(',')},updated_at=now() WHERE id=$1 RETURNING *`,
          [request.params.id,...columns.map(k=>encode(k,request.body[k]))]);
        if(!row)fail(404,'Registro no encontrado');
        await audit(tx,request.user.id,`${table}.update`,row.id);return row;
      });
    });
    app.delete(`/v1/admin/${table}/:id`,{ preHandler:guard.admin(['admin','catalog']),schema:adminSchema('Administración catálogo',{params:s.idParams,summary:'Archivar sin eliminar historial de pedidos/reservas'}) },async(request,reply)=>{
      await db.transaction(async tx=>{
        const row=await one(tx,`UPDATE ${table} SET archived=true,published=false,updated_at=now() WHERE id=$1 RETURNING id`,[request.params.id]);
        if(!row)fail(404,'Registro no encontrado');
        await audit(tx,request.user.id,`${table}.archive`,row.id);
      });reply.code(204).send();
    });
  }
  app.post('/v1/admin/products/:id/variants',{preHandler:guard.admin(['admin','catalog']),schema:adminSchema('Inventario',{params:s.idParams,body:s.variantBody})},async(request,reply)=>{
    const data=request.body;
    const row=await db.transaction(async tx=>{
      if(!await one(tx,'SELECT id FROM products WHERE id=$1',[request.params.id]))fail(404,'Producto no encontrado');
      const result=await one(tx,`INSERT INTO variants(id,product_id,sku,name,price_minor,currency,stock,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id(),request.params.id,data.sku,data.name,data.price_minor,data.currency,data.stock,data.active]);
      await tx.query('INSERT INTO stock_movements(id,variant_id,delta,reason,actor_id) VALUES($1,$2,$3,$4,$5)',[id(),result.id,data.stock,'initial',request.user.id]);
      await audit(tx,request.user.id,'variant.create',result.id);return result;
    });reply.code(201);return row;
  });
  const {stock,...variantEdit}=s.variantBody.properties;
  app.put('/v1/admin/variants/:id',{preHandler:guard.admin(['admin','catalog']),schema:adminSchema('Inventario',{params:s.idParams,body:s.object(variantEdit)})},async request=>db.transaction(async tx=>{
    const v=request.body;
    const row=await one(tx,'UPDATE variants SET sku=$2,name=$3,price_minor=$4,currency=$5,active=$6 WHERE id=$1 RETURNING *',[request.params.id,v.sku,v.name,v.price_minor,v.currency,v.active]);
    if(!row)fail(404,'Variante no encontrada');await audit(tx,request.user.id,'variant.update',row.id);return row;
  }));
  app.post('/v1/admin/variants/:id/stock',{preHandler:guard.admin(['admin','catalog']),schema:adminSchema('Inventario',{params:s.idParams,body:s.object({delta:s.int(-1000000,1000000),reason:s.str(300)})})},async request=>db.transaction(async tx=>{
    const row=await one(tx,'SELECT * FROM variants WHERE id=$1 FOR UPDATE',[request.params.id]);
    if(!row)fail(404,'Variante no encontrada');
    if(row.stock+request.body.delta<0 || row.stock+request.body.delta>1000000)fail(409,'Existencia resultante fuera de rango');
    await tx.query('INSERT INTO stock_movements(id,variant_id,delta,reason,actor_id) VALUES($1,$2,$3,$4,$5)',[id(),row.id,request.body.delta,request.body.reason,request.user.id]);
    await audit(tx,request.user.id,'stock.adjust',row.id,request.body);
    return one(tx,'UPDATE variants SET stock=stock+$2 WHERE id=$1 RETURNING *',[row.id,request.body.delta]);
  }));
  app.get('/v1/admin/variants/:id/movements',{preHandler:guard.admin(),schema:adminSchema('Inventario',{params:s.idParams,querystring:s.pagination})},async request=>({items:(await db.query('SELECT * FROM stock_movements WHERE variant_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3',[request.params.id,...pageArgs(request)])).rows}));

  app.get('/v1/admin/properties/:id/calendar',{preHandler:guard.admin(),schema:adminSchema('Calendario',{params:s.idParams,querystring:s.object({from:s.date,to:s.date})})},async request=>{
    const {from,to}=request.query;
    if(to<=from)fail(400,'Rango inválido');
    return {blocks:(await db.query('SELECT * FROM calendar_blocks WHERE property_id=$1 AND check_in<$3::date AND check_out>$2::date',[request.params.id,from,to])).rows,
      bookings:(await db.query(`SELECT b.*,c.status FROM bookings b JOIN checkouts c ON c.id=b.checkout_id WHERE b.property_id=$1
        AND b.check_in<$3::date AND b.check_out>$2::date AND (c.status='confirmed' OR(c.status='pending' AND c.expires_at>now()))`,[request.params.id,from,to])).rows};
  });
  app.post('/v1/admin/properties/:id/calendar-blocks',{preHandler:guard.admin(['admin','catalog']),schema:adminSchema('Calendario',{params:s.idParams,body:s.object({check_in:s.date,check_out:s.date,reason:s.str(300)})})},async(request,reply)=>{
    const row=await db.transaction(async tx=>{
      const property=await one(tx,'SELECT * FROM properties WHERE id=$1 FOR UPDATE',[request.params.id]);
      if(!property)fail(404,'Propiedad no encontrada');
      dateRange(request.body.check_in,request.body.check_out,property.timezone);
      const conflict=await one(tx,`SELECT b.checkout_id FROM bookings b JOIN checkouts c ON c.id=b.checkout_id WHERE b.property_id=$1
        AND b.check_in<$3::date AND b.check_out>$2::date AND(c.status='confirmed' OR(c.status='pending' AND c.expires_at>now())) LIMIT 1`,[property.id,request.body.check_in,request.body.check_out]);
      if(conflict)fail(409,'Existen reservas o retenciones en esas fechas');
      const block=await one(tx,'INSERT INTO calendar_blocks(id,property_id,check_in,check_out,reason) VALUES($1,$2,$3,$4,$5) RETURNING *',[id(),property.id,request.body.check_in,request.body.check_out,request.body.reason]);
      await audit(tx,request.user.id,'calendar.block',block.id);return block;
    });reply.code(201);return row;
  });
  app.delete('/v1/admin/calendar-blocks/:id',{preHandler:guard.admin(['admin','catalog']),schema:adminSchema('Calendario',{params:s.idParams})},async(request,reply)=>{
    await db.transaction(async tx=>{
      const row=await one(tx,'DELETE FROM calendar_blocks WHERE id=$1 RETURNING id',[request.params.id]);
      if(!row)fail(404,'Bloqueo no encontrado');await audit(tx,request.user.id,'calendar.unblock',row.id);
    });reply.code(204).send();
  });

  app.post('/v1/inquiries',{schema:{tags:['Consultas'],body:s.object({property_id:s.uuid,name:s.str(120),email:s.email,phone:s.str(30,5),message:s.str(5000),consent:{const:true}},['name','email','phone','message','consent'])},config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async(request,reply)=>{
    const data=request.body;
    const result=await db.transaction(async tx=>{
      if(data.property_id && !await one(tx,'SELECT id FROM properties WHERE id=$1 AND published=true AND archived=false',[data.property_id]))fail(404,'Propiedad no encontrada');
      const row=await one(tx,'INSERT INTO inquiries(id,property_id,name,email,phone,message) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[id(),data.property_id||null,data.name,data.email,data.phone,data.message]);
      await enqueue(tx,`inquiry:${row.id}`,config.adminEmail,'VIICASA · Nueva consulta',`${data.name}\n${data.email}\n${data.phone}\n${data.message}`);return row;
    });reply.code(201);return result;
  });
  app.get('/v1/admin/inquiries',{preHandler:guard.admin(['admin','support','viewer']),schema:adminSchema('Consultas',{querystring:s.pagination})},async request=>({items:(await db.query('SELECT * FROM inquiries ORDER BY created_at DESC,id LIMIT $1 OFFSET $2',pageArgs(request))).rows}));
  app.patch('/v1/admin/inquiries/:id',{preHandler:guard.admin(['admin','support']),schema:adminSchema('Consultas',{params:s.idParams,body:s.object({status:s.choice(['new','attended','archived'])})})},async request=>db.transaction(async tx=>{
    const row=await one(tx,'UPDATE inquiries SET status=$2 WHERE id=$1 RETURNING *',[request.params.id,request.body.status]);
    if(!row)fail(404,'Consulta no encontrada');await audit(tx,request.user.id,'inquiry.update',row.id);return row;
  }));

  await mkdir(config.mediaDir,{recursive:true});
  app.post('/v1/admin/media',{preHandler:guard.admin(['admin','catalog']),schema:adminSchema('Multimedia',{summary:'Subir una imagen PNG/JPEG/WebP/GIF (multipart, máximo 8 MiB)'})},async(request,reply)=>{
    const upload=await request.file({limits:{files:1,fileSize:8*1024*1024,fields:0}});
    if(!upload)fail(400,'Falta archivo');
    const buffer=await upload.toBuffer(), detected=await fileTypeFromBuffer(buffer);
    if(!detected || !['image/jpeg','image/png','image/webp','image/gif'].includes(detected.mime))fail(415,'Formato de imagen no admitido');
    const mediaId=id(),filename=`${mediaId}.${detected.ext}`;
    await writeFile(join(config.mediaDir,filename),buffer,{flag:'wx'});
    await db.transaction(async tx=>{
      await tx.query('INSERT INTO media(id,filename,mime,bytes,actor_id) VALUES($1,$2,$3,$4,$5)',[mediaId,filename,detected.mime,buffer.length,request.user.id]);
      await audit(tx,request.user.id,'media.upload',mediaId);
    });reply.code(201);return{id:mediaId,url:`/v1/media/${mediaId}`,mime:detected.mime,bytes:buffer.length};
  });
  app.get('/v1/media/:id',{schema:{tags:['Multimedia'],params:s.idParams}},async(request,reply)=>{
    const media=await one(db,'SELECT filename,mime FROM media WHERE id=$1',[request.params.id]);
    if(!media)fail(404,'Imagen no encontrada');
    const buffer=await readFile(join(config.mediaDir,media.filename));
    return reply.type(media.mime).header('Cache-Control','public, max-age=31536000, immutable').send(buffer);
  });
}
