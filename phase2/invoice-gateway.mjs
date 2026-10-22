import Stripe from 'stripe';
import {fail} from '../viicasa-backend/src/lib.js';
export function invoiceGateway(config,{stripe,advanced=false}={}){
  if(config.paymentProvider==='disabled')return{provider:'disabled',create:async()=>fail(409,'Stripe test payments are not configured.')};
  if(config.paymentProvider!=='stripe')return{provider:'demo',create:async p=>({reference:'invoice-demo-'+p.id,url:null})};
  if(!config.stripeKey?.startsWith('sk_test_'))throw Error('Service invoices accept Stripe test keys only in Phase 2 demo.');
  const api=stripe||new Stripe(config.stripeKey,{maxNetworkRetries:2,timeout:15000});
  const testObject=o=>{if(!o||o.livemode!==false)fail(409,'Only verified Stripe sandbox objects are accepted.');return o;};
  const id=o=>typeof o==='string'?o:o?.id;
  return{provider:'stripe',advancedEnabled:advanced,
    createCustomer:async(a,c)=>testObject(await api.customers.create({email:c.customer_email,metadata:{phase2_authorization_id:a.id}},{idempotencyKey:'phase2-customer-'+a.id})).id,
    createSetup:async(a,customer)=>{const value=await api.checkout.sessions.create({mode:'setup',currency:'cad',payment_method_types:['card'],customer,client_reference_id:a.id,metadata:{phase2_setup_id:a.id},setup_intent_data:{metadata:{phase2_setup_id:a.id}},success_url:new URL('/cliente?card_setup=return',config.siteUrl).href,cancel_url:new URL('/cliente',config.siteUrl).href},{idempotencyKey:'phase2-setup-'+a.id+'-'+(a.setup_attempt||1)});testObject(value);return{reference:value.id,url:value.url};},
    inspectSetup:async reference=>{const session=testObject(await api.checkout.sessions.retrieve(reference));return{status:session.status,authorization:session.metadata?.phase2_setup_id};},
    retrieveSetup:async reference=>{const session=testObject(await api.checkout.sessions.retrieve(reference,{expand:['setup_intent']})),setup=testObject(typeof session.setup_intent==='object'?session.setup_intent:await api.setupIntents.retrieve(session.setup_intent));
      if(session.mode!=='setup'||session.status!=='complete'||setup.status!=='succeeded'||setup.usage!=='off_session')fail(409,'Card setup is not confirmed.');
      const method=testObject(await api.paymentMethods.retrieve(id(setup.payment_method)));if(method.type!=='card'||id(method.customer)!==id(setup.customer)||id(session.customer)!==id(setup.customer))fail(409,'Saved payment method ownership mismatch.');return{customer:id(setup.customer),method:method.id,authorization:session.metadata?.phase2_setup_id};},
    collect:async(p,a)=>{try{return testObject(await api.paymentIntents.create({amount:Number(p.amount_minor),currency:'cad',customer:a.customer_reference,payment_method:a.method_reference,off_session:true,confirm:true,error_on_requires_action:true,payment_method_types:['card'],metadata:{phase2_recurring_payment_id:p.id,phase2_authorization_id:a.authorization_id}},{idempotencyKey:'phase2-collection-'+p.id}));}catch(e){const intent=e.payment_intent||e.raw?.payment_intent;if(intent?.id)return testObject(await api.paymentIntents.retrieve(intent.id));throw Error('STRIPE_COLLECTION_UNCERTAIN');}},
    retrieveIntent:async reference=>testObject(await api.paymentIntents.retrieve(reference)),
    cancelIntent:async reference=>testObject(await api.paymentIntents.cancel(reference)),
    paymentIntentFor:async p=>{if(p.reference?.startsWith('pi_'))return testObject(await api.paymentIntents.retrieve(p.reference));const session=testObject(await api.checkout.sessions.retrieve(p.reference));if(session.payment_status!=='paid'||!id(session.payment_intent))fail(409,'The original Stripe payment is not confirmed.');return testObject(await api.paymentIntents.retrieve(id(session.payment_intent)));},
    createRefund:async(q,intent)=>testObject(await api.refunds.create({payment_intent:intent,amount:Number(q.approved_minor),reason:'requested_by_customer',metadata:{phase2_refund_request_id:q.id}},{idempotencyKey:'phase2-refund-'+q.id})),
    retrieveRefund:async reference=>testObject(await api.refunds.retrieve(reference)),
    create:async(p,i)=>{
    const session=await api.checkout.sessions.create({mode:'payment',payment_method_types:['card'],adaptive_pricing:{enabled:false},customer_email:i.customer_email,client_reference_id:i.id,
      metadata:{phase2_invoice_id:i.id,phase2_payment_id:p.id},line_items:[{quantity:1,price_data:{currency:'cad',unit_amount:p.amount_minor,product_data:{name:'ViiLife · Invoice '+i.number}}}],expires_at:Math.floor(new Date(p.expires_at).getTime()/1000),
      success_url:new URL(i.guest_checkout?'/pedido?reference='+i.id:'/cliente?invoice='+i.id+'&payment=success',config.siteUrl).href,cancel_url:new URL(i.guest_checkout?'/pedido?reference='+i.id:'/cliente?invoice='+i.id,config.siteUrl).href},{idempotencyKey:'phase2-invoice-'+p.id});return{reference:session.id,url:session.url};
    },verify:(raw,signature)=>{try{return api.webhooks.constructEvent(raw,signature,config.stripeWebhookSecret);}catch{fail(400,'Invalid Stripe webhook signature.');}}};
}
