// Shared storefront refinements. All totals, stock and payment states remain server-owned.
export async function enhanceCommerce({api,L,esc,money,settings}){
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
  }
  const update=async()=>{try{const cart=await api('/cart?currency=CAD'),count=cart.items.reduce((sum,item)=>sum+item.quantity,0);basket.hidden=count===0;basket.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M5 8h14l1 13H4L5 8Zm3 0V6a4 4 0 0 1 8 0v2"/></svg> '+count;basket.setAttribute('aria-label',L('Ver canasta','View basket')+' · '+count);document.querySelector('#view-basket')?.toggleAttribute('hidden',!count);return count;}catch{return 0;}};
  await update();
  const form=document.querySelector('#add-cart');
  if(form&&!form.dataset.commerceEnhanced){
    form.dataset.commerceEnhanced='true';
    const product=await api('/products/'+encodeURIComponent(location.pathname.split('/')[2]));
    const input=form.elements.quantity,variant=form.elements.variant;
    input.insertAdjacentHTML('beforebegin','<span class="quantity-stepper"><button type="button" data-step="-1" aria-label="'+L('Disminuir cantidad','Decrease quantity')+'">−</button></span>');
    const stepper=form.querySelector('.quantity-stepper');stepper.append(input);stepper.insertAdjacentHTML('beforeend','<button type="button" data-step="1" aria-label="'+L('Aumentar cantidad','Increase quantity')+'">+</button>');
    input.readOnly=true;
    const limits=()=>{const v=product.variants.find(v=>v.id===variant.value),max=Math.min(99,v?.stock||0);input.max=String(max);input.value=String(Math.max(1,Math.min(Number(input.value)||1,max)));stepper.querySelector('[data-step="-1"]').disabled=Number(input.value)<=1;stepper.querySelector('[data-step="1"]').disabled=Number(input.value)>=max;};
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
          drawer.innerHTML='<button type="button" class="close" aria-label="'+L('Cerrar','Close')+'">×</button><p>'+L('Agregado a tu canasta','Added to your basket')+'</p><h2>'+esc(product.name)+'</h2><p>'+esc(variant.selectedOptions[0].textContent)+' · '+input.value+'</p><a class="btn full" href="/checkout">'+L('Pagar','Checkout')+' ↗</a><button class="btn outline full" data-continue>'+L('Seguir explorando','Keep exploring')+'</button>';
          document.body.append(drawer);drawer.showModal();drawer.querySelector('.close').onclick=drawer.querySelector('[data-continue]').onclick=()=>drawer.close();drawer.addEventListener('close',()=>drawer.remove());
        }
      }finally{go=false;saving=false;if(primary)primary.disabled=false;buy.disabled=false;limits();}
    };
    document.querySelector('#buy-now').onclick=()=>{go=true;form.requestSubmit();};await update();
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
