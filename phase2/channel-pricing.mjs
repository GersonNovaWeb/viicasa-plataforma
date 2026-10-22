import {fail} from '../viicasa-backend/src/lib.js';
import * as s from '../viicasa-backend/src/schemas.js';
import {audit} from './api.mjs';
const ident={type:'string',pattern:'^[a-z][a-z0-9-]*$',maxLength:60};
const tax=s.object({id:ident,label:s.str(120),amount_minor:s.int(0)});
export const channelBreakdownSchema=s.object({subtotal_minor:s.int(0),discount_minor:s.int(0),shipping_minor:s.int(0),tax_minor:s.int(0),total_minor:s.int(1),taxes:s.array(tax,10),taxes_included:s.bool},['subtotal_minor','discount_minor','shipping_minor','tax_minor','total_minor','taxes']);
export const emptyChannelPricing=()=>({revision:0,approved:false,shipping_options:[],discounts:[],taxes:null,note:''});
export const channelPolicy=async db=>({...emptyChannelPricing(),...(await db.query("SELECT value FROM phase2_settings WHERE key='channel_pricing'")).rows[0]?.value});
const validMinor=n=>Number.isSafeInteger(n)&&n>=0&&n<=99999999;
export function orderBreakdown(lines,breakdown,total){
  if(breakdown!==undefined&&(!breakdown||typeof breakdown!=='object'||Array.isArray(breakdown)))fail(400,'Invalid normalised order breakdown.');
  const subtotal=lines.reduce((n,l)=>n+l.quantity*l.unit_minor,0);
  const b=breakdown??{subtotal_minor:subtotal,discount_minor:0,shipping_minor:0,tax_minor:0,total_minor:total,taxes:[]};
  if(!b||typeof b!=='object'||Object.keys(b).some(k=>!Object.hasOwn(channelBreakdownSchema.properties,k))||channelBreakdownSchema.required.some(k=>!Object.hasOwn(b,k))||b.taxes_included!==undefined&&typeof b.taxes_included!=='boolean'||!['subtotal_minor','discount_minor','shipping_minor','tax_minor','total_minor'].every(k=>validMinor(b[k]))||!Array.isArray(b.taxes)||b.taxes.length>10)fail(400,'Invalid normalised order breakdown.');
  if(new Set(b.taxes.map(t=>t?.id)).size!==b.taxes.length||b.taxes.some(t=>!t||Object.keys(t).some(k=>!Object.hasOwn(tax.properties,k))||typeof t.id!=='string'||!/^[a-z][a-z0-9-]{0,59}$/.test(t.id)||typeof t.label!=='string'||!t.label.trim()||t.label.length>120||!validMinor(t.amount_minor)))fail(400,'Invalid normalised order taxes.');
  if(b.subtotal_minor!==subtotal||b.discount_minor>subtotal+b.shipping_minor||b.tax_minor!==b.taxes.reduce((n,t)=>n+t.amount_minor,0)||b.total_minor!==total||total<1||total!==subtotal-b.discount_minor+b.shipping_minor+(b.taxes_included?0:b.tax_minor))fail(400,'Order breakdown does not reconcile to its lines and total.');
  return b;
}
export function priceChannel(lines,policy,{shipping_option='',discount_code=''}={}){
  const subtotal=lines.reduce((n,l)=>n+l.quantity*l.unit_minor,0);if(!validMinor(subtotal)||subtotal<1)fail(400,'Cart subtotal outside demo limit.');
  let shipping=0,discount=0,chosen=null,promo=null,taxes=[];
  if(policy.approved){
    if(!Array.isArray(policy.taxes))fail(409,'Approved shipping and tax rules need review.');
    chosen=policy.shipping_options.find(o=>o.id===shipping_option);
    if(policy.shipping_options.length&&!chosen||shipping_option&&!chosen)fail(400,'Select a configured delivery option.');
    shipping=chosen?.amount_minor||0;
    const code=discount_code.trim().toUpperCase();promo=code?policy.discounts.find(d=>d.code===code):null;
    if(code&&(!promo||subtotal<promo.min_subtotal_minor))fail(400,'Discount code is not valid for this cart.');
    if(promo)discount=Math.min(subtotal,promo.basis==='fixed'?promo.value:Number((BigInt(subtotal)*BigInt(promo.value)+5000n)/10000n));
    taxes=(policy.taxes||[]).map(t=>({id:t.id,label:t.label,amount_minor:Number((BigInt(subtotal-discount+(t.shipping_taxable?shipping:0))*BigInt(t.basis_points)+5000n)/10000n)}));
  }else if(shipping_option||discount_code.trim())fail(409,'Shipping and discount rules are not approved yet.');
  const tax=taxes.reduce((n,t)=>n+t.amount_minor,0),total=subtotal-discount+shipping+tax;
  const breakdown=orderBreakdown(lines,{subtotal_minor:subtotal,discount_minor:discount,shipping_minor:shipping,tax_minor:tax,total_minor:total,taxes},total);
  return{breakdown,pricing:{policy_revision:policy.revision,configured:policy.approved,taxes_defined:policy.approved&&policy.taxes!==null,shipping_option:chosen?{id:chosen.id,label:chosen.label}:null,discount:promo?{code:promo.code,label:promo.label}:null}};
}
export function registerChannelPricing(app,{db,adminGuard}){
  app.get('/api/commercial/shop-channel/pricing',{preHandler:adminGuard},async(r,reply)=>{reply.header('Cache-Control','private, no-store');return channelPolicy(db);});
  app.get('/api/shop-channel/pricing',async()=>{const p=await channelPolicy(db);return{revision:p.revision,approved:p.approved,shipping_options:p.approved?p.shipping_options:[],taxes_defined:p.approved&&p.taxes!==null};});
  const body=s.object({revision:s.int(0),approved:s.bool,shipping_options:s.array(s.object({id:ident,label:s.str(120),amount_minor:s.int(0)}),20),discounts:s.array(s.object({code:{type:'string',pattern:'^[A-Z0-9_-]{1,80}$'},label:s.str(120),basis:s.choice(['fixed','percent']),value:s.int(0),min_subtotal_minor:s.int(0)}),30),taxes:{anyOf:[s.array(s.object({id:ident,label:s.str(120),basis_points:s.int(0,10000),shipping_taxable:s.bool}),10),{type:'null'}]},note:s.str(2000,3)});
  app.put('/api/commercial/shop-channel/pricing',{preHandler:adminGuard,schema:{body}},r=>db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(73182011)');const old=await channelPolicy(tx),p=r.body;
    if(old.revision!==p.revision)fail(409,'Pricing rules changed. Refresh first.');
    if(!p.note.trim()||p.note.trim().length<3)fail(400,'Enter a policy approval reference.');
    for(const [rows,key]of [[p.shipping_options,'id'],[p.discounts,'code'],[p.taxes||[],'id']])if(new Set(rows.map(x=>x[key])).size!==rows.length)fail(400,'Pricing identifiers must be unique.');
    if(p.discounts.some(d=>d.basis==='percent'&&d.value>10000)||(p.taxes||[]).reduce((n,t)=>n+t.basis_points,0)>10000)fail(400,'Configured rates cannot exceed 100%.');
    if(p.approved&&p.taxes===null)fail(409,'Define the tax treatment explicitly before approving. An empty list means no added tax.');
    const value={...p,revision:old.revision+1,note:p.note.trim()};
    await tx.query("INSERT INTO phase2_settings(key,value) VALUES('channel_pricing',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[JSON.stringify(value)]);
    await audit(tx,r.teamUser.id,'channel.pricing','channel_pricing',value);return{ok:true,revision:value.revision};
  }));
}
