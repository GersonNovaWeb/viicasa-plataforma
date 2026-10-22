// Shared storefront refinements. All totals, stock and payment states remain server-owned.
import {mountPublicMenu,mountDetailHeader,viiIcon} from './vii-ui.js';
import {mountBookingSheet,productExtras} from './vii-detail.js';
export async function enhanceCommerce({api,L,esc,money,settings}){
  if(settings.phase===2)mountPublicMenu({L,esc});
  if(!document.querySelector('link[href="/commerce-ux.css"]')){const link=document.createElement('link');link.rel='stylesheet';link.href='/commerce-ux.css';document.head.append(link);}
  let basket=document.querySelector('#header-basket');
  if(!basket){basket=document.createElement('a');basket.id='header-basket';basket.href='/checkout';basket.hidden=true;document.querySelector('.header-actions')?.prepend(basket);}
  if(!basket.dataset.positioned){
    basket.dataset.positioned='true';const viewport=matchMedia('(max-width:700px)');
    const position=()=>{if(viewport.matches)document.querySelector('.header')?.insertBefore(basket,document.querySelector('#menu-toggle'));else document.querySelector('.header-actions')?.prepend(basket);};
    viewport.addEventListener('change',position);position();
  }
  if(settings.phase===2){
    const back=document.querySelector('.page-wrap>.back-link,.property-detail>.back-link');
    if(back&&location.pathname.startsWith('/shop/'))back.href='/shop?return=1';
    if(back&&location.pathname.startsWith('/viiconcierge/'))back.href='/viiconcierge?return=1';
    if(location.pathname.startsWith('/shop/'))mountDetailHeader({brand:'ViiShop',href:'/shop?return=1',L});
    if(location.pathname.startsWith('/viiconcierge/'))mountDetailHeader({brand:'ViiConcierge',href:'/viiconcierge?return=1',L});
    mountBookingSheet({L});
  }
  const update=async()=>{try{const cart=await api('/cart?currency=CAD'),count=cart.items.reduce((sum,item)=>sum+item.quantity,0);basket.hidden=count===0;basket.innerHTML=viiIcon('bag')+'<span class="vii-basket-count">'+count+'</span>';basket.setAttribute('aria-label',L('Ver canasta','View basket')+' · '+count);document.querySelector('#view-basket')?.toggleAttribute('hidden',!count);return count;}catch{return 0;}};
  await update();
  const form=document.querySelector('#add-cart');
  if(form&&!form.dataset.commerceEnhanced){
    form.dataset.commerceEnhanced='true';
    const product=await api('/products/'+encodeURIComponent(location.pathname.split('/')[2]));
    const input=form.elements.quantity,variant=form.elements.variant;
    const cadPrice=v=>{const price=v?.prices?.CAD??(v?.currency==='CAD'?v.price_minor:null);return Number.isSafeInteger(price)&&price>0?price:null;};
    if(settings.phase===2){
      document.body.dataset.viiDetail='shop';
      const title=form.parentElement.querySelector('h1');
      title.insertAdjacentHTML('afterend','<p class="vii-product-price"></p><p class="vii-product-stock" role="status"></p>');
      const chips=document.createElement('div');chips.className='vii-variant-chips';chips.setAttribute('role','group');chips.setAttribute('aria-label',L('Presentación','Variant'));
      chips.innerHTML=product.variants.map(v=>'<button type="button" data-variant="'+esc(v.id)+'" '+(!v.stock||v.active===false||cadPrice(v)===null?'disabled':'')+'>'+esc(v.name)+'</button>').join('');
      variant.parentElement.after(chips);
      const price=()=>{const v=product.variants.find(x=>x.id===variant.value),amount=cadPrice(v);document.querySelector('.vii-product-price').textContent=amount!==null?money(amount,'CAD'):L('Tarifa por confirmar','Price to be confirmed');document.querySelector('.vii-product-stock').textContent=v?(v.stock>0?v.stock+' '+L('disponibles','available'):L('Agotado','Out of stock')):'';chips.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.variant===variant.value)));};
      chips.querySelectorAll('button').forEach(b=>b.onclick=()=>{variant.value=b.dataset.variant;variant.dispatchEvent(new Event('change',{bubbles:true}));});variant.addEventListener('change',price);price();
    }
    input.insertAdjacentHTML('beforebegin','<span class="quantity-stepper"><button type="button" data-step="-1" aria-label="'+L('Disminuir cantidad','Decrease quantity')+'">−</button></span>');
    const stepper=form.querySelector('.quantity-stepper');stepper.append(input);stepper.insertAdjacentHTML('beforeend','<button type="button" data-step="1" aria-label="'+L('Aumentar cantidad','Increase quantity')+'">+</button>');
    input.readOnly=true;
    const limits=()=>{const v=product.variants.find(v=>v.id===variant.value),max=Math.min(99,v?.stock||0);input.max=String(max);input.value=String(Math.max(1,Math.min(Number(input.value)||1,max)));stepper.querySelector('[data-step="-1"]').disabled=Number(input.value)<=1;stepper.querySelector('[data-step="1"]').disabled=Number(input.value)>=max;if(settings.phase===2){const unavailable=!max||v?.active===false||cadPrice(v)===null;const primary=form.querySelector('button:not([type])'),buy=document.querySelector('#buy-now');if(primary)primary.disabled=unavailable;if(buy)buy.disabled=unavailable;}};
    stepper.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>{input.value=String(Number(input.value)+Number(b.dataset.step));limits();});variant.addEventListener('change',limits);limits();
    const old=form.nextElementSibling;if(old?.matches('a.back-link'))old.remove();
    form.insertAdjacentHTML('afterend','<a id="view-basket" class="btn full basket-reveal" href="/checkout" hidden>'+L('Ver canasta','View basket')+' ↗</a><button type="button" class="btn full buy-now" id="buy-now">'+L('Comprar ahora','Buy now')+'</button>');
    const submit=form.onsubmit;let go=false,saving=false;
    form.onsubmit=async e=>{
      e.preventDefault();if(saving)return;saving=true;
      const primary=form.querySelector('button:not([type])'),buy=document.querySelector('#buy-now');if(primary)primary.disabled=true;buy.disabled=true;
      try{await submit(e);const message=form.querySelector('.form-message').textContent;const success=message===L('Carrito actualizado.','Basket updated.');await update();
        if(success&&go)location.assign('/checkout');
        else if(success){
          const drawer=document.createElement('dialog');drawer.className='basket-drawer';
          drawer.setAttribute('aria-label',L('Agregado a tu canasta','Added to your basket'));
          drawer.innerHTML='<button type="button" class="close" aria-label="'+L('Cerrar','Close')+'">×</button><p class="vii-basket-success">✓ '+L('Agregado a tu canasta','Added to your basket')+'</p><div class="vii-basket-product">'+(product.images?.[0]?'<img src="'+esc(product.images[0])+'" alt="">':'')+'<div><h2>'+esc(product.name)+'</h2><p>'+esc(variant.selectedOptions[0].textContent)+' · '+input.value+'</p></div></div><p>'+L('El envío y los impuestos se verifican al pagar.','Shipping and taxes are verified at checkout.')+'</p><a class="btn full" href="/checkout">'+L('Pagar','Checkout')+'</a><button class="btn outline full" data-continue>'+L('Seguir desplazándose','Keep scrolling')+'</button>';
          document.body.append(drawer);drawer.showModal();drawer.querySelector('.close').onclick=drawer.querySelector('[data-continue]').onclick=()=>drawer.close();drawer.addEventListener('close',()=>drawer.remove());
        }
      }finally{go=false;saving=false;if(primary)primary.disabled=false;buy.disabled=false;limits();}
    };
    document.querySelector('#buy-now').onclick=()=>{location.assign('/checkout?'+new URLSearchParams({product:product.slug,variant:variant.value,quantity:input.value}));};limits();await update();
    if(settings.phase===2){
      const actions=document.createElement('aside');actions.className='vii-product-actions';actions.setAttribute('aria-label',L('Comprar producto','Purchase product'));
      actions.innerHTML='<button type="button" class="btn outline" data-sticky-add>'+L('Agregar a la canasta','Add to basket')+'</button><button type="button" class="btn" data-sticky-buy>'+L('Comprar ya','Buy now')+'</button>';
      document.body.append(actions);actions.querySelector('[data-sticky-add]').onclick=()=>form.requestSubmit();actions.querySelector('[data-sticky-buy]').onclick=()=>document.querySelector('#buy-now').click();
      const sync=()=>actions.querySelectorAll('button').forEach(b=>b.disabled=form.querySelector('button:not([type])')?.disabled||saving);sync();new MutationObserver(sync).observe(form,{subtree:true,attributes:true,attributeFilter:['disabled']});
      void productExtras({api,product,L,esc});
    }
  }
  const isReturn=location.pathname==='/pago/resultado';
  const id=new URLSearchParams(location.search).get('checkout');
  if(isReturn&&id&&document.querySelector('#pay')){
    document.querySelector('#pay').hidden=true;document.querySelector('#cancel-checkout')?.setAttribute('hidden','');
    const status=document.querySelector('.form-message');status.textContent=L('Verificando el pago. No vuelvas a pagar. Usa Actualizar estado si tarda.','Verifying payment. Do not pay again. Use Refresh status if this takes a moment.');
    // Bounded read-only checks. Never create another Checkout Session automatically.
    if(!document.body.dataset.paymentPolling){document.body.dataset.paymentPolling='true';
      let attempts=0;const poll=async()=>{if(!document.querySelector('#refresh-result')||document.hidden||attempts++>=8)return;try{const current=await api('/checkouts/'+encodeURIComponent(id));if(current.status!=='pending'){document.querySelector('#refresh-result').click();return;}}catch{/* A failed poll cannot mark a payment as confirmed. */}setTimeout(poll,2500);};setTimeout(poll,2500);
    }
  }
  const summary=document.querySelector('.summary-box');
  if(summary&&document.querySelector('.status.confirmed')&&!document.querySelector('.purchase-success')){
    document.querySelector('#pay')?.remove();
    summary.insertAdjacentHTML('afterend','<section class="purchase-success"><p>'+L('Pago confirmado. Tu recibo y los detalles llegarán por correo.','Payment confirmed. Your receipt and details will arrive by email.')+'</p><h2>'+L('Todo a tu alcance.','Everything in one place.')+'</h2><p>'+L('Repite visitas, consulta recibos y gestiona tus pedidos en segundos. Crear una cuenta es opcional y no cambia tu confirmación.','Repeat visits, view receipts and manage orders in seconds. An account is optional and does not change your confirmation.')+'</p><a class="btn" href="'+(settings.phase===2?'/cliente?return_order=1':'/cuenta')+'">'+L('Crear mi cuenta','Create my account')+'</a><a class="btn outline" href="/">'+L('Seguir explorando','Keep exploring')+' ↗</a></section>');
    await update();
    const results=await Promise.allSettled([api('/products?limit=3'),api('/properties?limit=3'),settings.phase===2?api('/service-catalogue?channel=viilife'):Promise.resolve(null)]);
    const product=results[0].value?.items?.[0],property=results[1].value?.items?.[0],service=results[2].value?.items?.[0];
    const label=v=>typeof v==='object'?v?.[document.documentElement.lang]||v?.en||'':String(v||'').split(' / ').at(document.documentElement.lang==='en'?-1:0);
    const cards=[product&&{brand:'ViiShop',name:label(product.name),href:'/shop/'+encodeURIComponent(product.slug)},property&&{brand:'ViiConcierge',name:label(property.name),href:'/viiconcierge/'+encodeURIComponent(property.slug)},service?{brand:'ViiLife',name:label(service.name),href:'/servicios/'+encodeURIComponent(service.id)+'?channel=viilife'}:{brand:'ViiLife',name:L('Cuidado para tu hogar','Care for your home'),href:'/viilife'}].filter(Boolean);
    document.querySelector('.purchase-success')?.insertAdjacentHTML('beforeend','<h2>'+L('Sugerencias','Suggestions')+'</h2><div class="receipt-suggestions">'+cards.map(x=>'<a href="'+esc(x.href)+'"><small>'+x.brand+'</small><h3>'+esc(x.name)+'</h3><span>'+L('Descubrir','Explore')+' ↗</span></a>').join('')+'</div>');
  }
}
