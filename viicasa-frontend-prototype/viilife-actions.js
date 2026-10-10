// Shared, localized actions for the three immersive ViiLife panels.
export function viilifeActions(index,lang='en'){
  if(!Number.isInteger(index)||index<0||index>2)throw new RangeError('Invalid ViiLife panel');
  const L=(es,en)=>lang==='es'?es:en;
  return `<div class="cta-row viilife-actions" role="group" aria-label="${L('Explora o contrata ViiLife','Explore or book ViiLife')}">
    <a class="primary viilife-book" href="/viilife/limpieza">${L('Contratar limpieza','Book cleaning')}<span aria-hidden="true">↗</span></a>
    <button class="viilife-explore" type="button" data-go="${index+1}">${index===2?L('Ver servicios y tarifas','View services & pricing'):L('Seguir explorando','Explore more')}<span aria-hidden="true">↓</span></button>
    <button class="viilife-enquiry" type="button" data-viilife-inquiry="${index}" aria-haspopup="dialog">${L('Información especial','Special enquiries')}<span aria-hidden="true">↗</span></button>
  </div>`;
}

export function bindViiLifeActions(root,{book,enquire}){
  root.querySelectorAll('.viilife-book').forEach(link=>link.addEventListener('click',event=>{
    // Preserve opening the real booking route in a new tab.
    if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||event.button)return;
    event.preventDefault();book();
  }));
  root.querySelectorAll('[data-viilife-inquiry]').forEach(button=>{
    button.addEventListener('click',()=>enquire(Number(button.dataset.viilifeInquiry)));
  });
}
