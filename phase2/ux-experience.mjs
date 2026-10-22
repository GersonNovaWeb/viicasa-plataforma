import {randomUUID} from 'node:crypto';
import * as s from '../viicasa-backend/src/schemas.js';
import {fail} from '../viicasa-backend/src/lib.js';
// Likes are account-owned; comments never contribute to a service's rating.
export async function registerViiExperience(app,{db,store,customerGuard}){
  await db.query(`CREATE TABLE IF NOT EXISTS vii_likes(customer_id uuid NOT NULL REFERENCES customer_accounts(id),item_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(customer_id,item_key))`);
  await db.query(`CREATE TABLE IF NOT EXISTS vii_reviews(id uuid PRIMARY KEY,customer_id uuid NOT NULL REFERENCES customer_accounts(id),checkout_id text NOT NULL,item_key text NOT NULL,score integer NOT NULL CHECK(score BETWEEN 1 AND 7),body text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(customer_id,checkout_id,item_key))`);
  const key=s.str(180,3);
  const exists=async itemKey=>{
    const [kind,id,...rest]=itemKey.split(':');if(rest.length||!id)fail(400,'Invalid item.');
    if(kind==='service'){const row=(await db.query('SELECT content FROM service_catalogue WHERE id=$1',[id])).rows[0];if(!row?.content.published||row.content.archived)fail(404,'Service unavailable.');return;}
    const row=await store.get(kind==='product'?'products':kind==='property'?'properties':'invalid',id);
    if(!['product','property'].includes(kind)||!row?.published||row.archived)fail(404,'Item unavailable.');
  };
  app.get('/api/client/likes',{preHandler:customerGuard},async r=>({items:(await db.query('SELECT item_key,created_at FROM vii_likes WHERE customer_id=$1 ORDER BY created_at DESC',[r.customer.id])).rows}));
  app.put('/api/client/likes',{preHandler:customerGuard,schema:{body:s.object({item_key:key,liked:s.bool})}},async r=>{
    const {item_key,liked}=r.body;await exists(item_key);
    if(liked)await db.query('INSERT INTO vii_likes(customer_id,item_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[r.customer.id,item_key]);
    else await db.query('DELETE FROM vii_likes WHERE customer_id=$1 AND item_key=$2',[r.customer.id,item_key]);
    return{liked};
  });
  app.get('/api/experience/reviews',{schema:{querystring:s.object({item_key:key})}},async r=>{
    await exists(r.query.item_key);
    const rows=(await db.query('SELECT r.id,r.score,r.body,r.created_at,u.name FROM vii_reviews r JOIN customer_accounts u ON u.id=r.customer_id WHERE r.item_key=$1 ORDER BY r.created_at DESC LIMIT 100',[r.query.item_key])).rows;
    const totals=(await db.query('SELECT count(*)::int AS count,avg(score)::float AS average FROM vii_reviews WHERE item_key=$1',[r.query.item_key])).rows[0];
    const histogram=(await db.query('SELECT score,count(*)::int AS count FROM vii_reviews WHERE item_key=$1 GROUP BY score ORDER BY score DESC',[r.query.item_key])).rows;
    return{bestRating:7,count:totals.count,average:totals.average,histogram,items:rows.map(x=>({...x,name:x.name.split(' ')[0],verified:true,rewarded:false}))};
  });
  app.post('/api/client/reviews',{preHandler:customerGuard,schema:{body:s.object({item_key:key,checkout_id:s.uuid,score:s.int(1,7),body:s.str(3000,3)})}},async r=>{
    const {item_key,checkout_id,score,body}=r.body;await exists(item_key);
    const c=await store.get('checkouts',checkout_id),[kind,id]=item_key.split(':');
    const matches=c&&(kind==='service'?c.kind==='cleaning'&&id==='home-cleaning':kind==='property'?c.kind==='booking'&&c.detail.property_id===id:c.kind==='order'&&c.detail.items.some(x=>x.product_id===id));
    if(!c||c.guest_id!==r.customer.id||c.status!=='confirmed'||!matches)fail(403,'A confirmed purchase of this item in your verified account is required.');
    const done=c.kind==='cleaning'?c.detail.quote?.dates?.at(-1):c.kind==='booking'?c.detail.check_out:null;
    if(!done||done>=new Date().toISOString().slice(0,10))fail(409,'Reviews open after the service or stay. Product delivery verification is required for shop reviews.');
    try{await db.query('INSERT INTO vii_reviews(id,customer_id,checkout_id,item_key,score,body) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),r.customer.id,checkout_id,item_key,score,body]);}catch(error){if(error.code==='23505')fail(409,'This purchase already has a review.');throw error;}
    return{ok:true};
  });
}
