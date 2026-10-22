export function mountBookingSheet({L}){
  const box=document.querySelector('.property-detail .booking-box');
  if(!box||document.querySelector('.vii-booking-actions'))return;
  const media=matchMedia('(max-width:700px)'),holder=box.parentElement,marker=document.createComment('booking form position');box.before(marker);
  const actions=document.createElement('aside');actions.className='vii-booking-actions';
  const price=box.querySelector('.booking-price').childNodes[0].textContent.trim();
  actions.innerHTML='<div><strong></strong><small></small></div><button type="button"></button>';
  actions.querySelector('strong').textContent=price;actions.querySelector('small').textContent=L('por noche · elige tus fechas','per night · choose your dates');actions.querySelector('button').textContent=L('Reservar','Reserve');document.body.append(actions);
  let dialog;
  actions.querySelector('button').onclick=()=>{
    dialog=document.createElement('dialog');dialog.className='vii-booking-sheet';dialog.setAttribute('aria-label',L('Tu reserva','Your reservation'));
    dialog.innerHTML='<div class="vii-dialog-heading"><h2>'+L('Tu reserva','Your reservation')+'</h2><button type="button" aria-label="'+L('Cerrar','Close')+'">×</button></div>';
    dialog.append(box);document.body.append(dialog);dialog.querySelector('.vii-dialog-heading button').onclick=()=>dialog.close();
    dialog.addEventListener('close',()=>{if(marker.isConnected)marker.after(box);else holder.append(box);dialog.remove();dialog=null;},{once:true});dialog.showModal();
  };
  media.addEventListener('change',()=>{if(!media.matches)dialog?.close();});
  new MutationObserver(()=>{const total=box.querySelector('.price-line.total span:last-child');actions.querySelector('strong').textContent=total?total.textContent:price;actions.querySelector('small').textContent=total?L('Total para las fechas seleccionadas','Total for selected dates'):L('por noche · elige tus fechas','per night · choose your dates');}).observe(box.querySelector('#quote-result'),{childList:true,subtree:true});
}
export async function productExtras({api,product,L,esc}){
  const target=document.querySelector('.product-detail');if(!target)return;
  target.insertAdjacentHTML('beforeend','<section class="vii-product-related"><div class="vii-care-card"><small>'+L('NOSOTROS NOS ENCARGAMOS','WE TAKE CARE OF IT')+'</small><h3>'+L('Disfruta tu hogar. Déjanos el cuidado.','Enjoy your home. Leave the care to us.')+'</h3><p>'+L('Descubre los servicios de limpieza y ropa de cama de ViiLife.','Discover ViiLife cleaning and linen care services.')+'</p><a href="/viilife">'+L('Explorar ViiLife','Explore ViiLife')+' →</a></div><section class="vii-product-reviews"><h2>'+L('Reseñas verificadas','Verified reviews')+'</h2><p role="status">'+L('Cargando…','Loading…')+'</p></section></section>');
  const reviews=document.querySelector('.vii-product-reviews');
  try{const data=await api('/experience/reviews?item_key='+encodeURIComponent('product:'+product.id));reviews.innerHTML='<h2>'+L('Reseñas verificadas','Verified reviews')+'</h2>'+(data.count?'<p>'+Number(data.average).toFixed(1)+' / 7 · '+data.count+' '+L('reseñas','reviews')+'</p>'+data.items.map(x=>'<article><strong>'+esc(x.name)+' · '+x.score+'/7</strong><p>'+esc(x.body)+'</p></article>').join(''):'<p>'+L('Aún no hay reseñas verificadas.','No verified reviews yet.')+'</p>');}
  catch{reviews.querySelector('[role=status]').textContent=L('Las reseñas no están disponibles en este momento.','Reviews are currently unavailable.');}
}
