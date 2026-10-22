import {animateSafely,containedRect,flyPhoto,imageTransform,reducedMotion,revealItemGallery} from './gallery-motion.js';

export const wrapPhoto=(index,count)=>count?((index%count)+count)%count:0;
export function galleryMarkup({images,name,L,esc,gridIcon=''}){
  if(!images.length)return '<div class="gallery single"><div class="no-photo">'+L('Galería pendiente','Gallery pending')+'</div></div>';
  return '<div class="gallery '+(images.length<2?'single':images.length===2?'pair':'')+'">'+images.slice(0,3).map((src,i)=>'<button type="button" data-gallery="'+i+'" aria-label="'+L('Abrir fotografía','Open photo')+' '+(i+1)+'"><img src="'+esc(src)+'" alt="'+esc(name)+' · '+(i+1)+'" decoding="async">'+(!i?'<span class="gallery-caption">'+gridIcon+L('Ver galería','View gallery')+' ('+images.length+')</span>':'')+'</button>').join('')+'</div>'+(images.length>1?'<div class="vii-gallery-preview" role="group" aria-label="'+L('Fotografías disponibles','Available photos')+'">'+images.map((src,i)=>'<button type="button" data-gallery="'+i+'" aria-label="'+L('Abrir fotografía','Open photo')+' '+(i+1)+'"><img src="'+esc(src)+'" loading="lazy" alt="" width="80" height="60"><span>'+String(i+1).padStart(2,'0')+'</span></button>').join('')+'</div>':'');
}

export function createPhotoSequence({count,initial=0,show,onError=()=>{}}){
  let index=wrapPhoto(initial,count),busy=false,alive=true;
  return{get index(){return index;},async go(value){
    if(!alive||busy||count<2)return false;const next=wrapPhoto(value,count);if(next===index)return true;
    busy=true;try{if(await show(next,next===wrapPhoto(index+1,count)?1:-1)!==false&&alive){index=next;return true;}return false;}
    catch{if(alive)onError();return false;}finally{busy=false;}
  },destroy(){alive=false;}};
}

export function mountPhotoGallery({images,name,L,doc=document,win=window}){
  const buttons=[...doc.querySelectorAll('[data-gallery]')];
  if(!images.length||!buttons.length)return;
  void revealItemGallery({gallery:doc.querySelector('.gallery'),doc,win});
  let viewer=null;
  buttons.forEach(button=>button.addEventListener('click',()=>{
    if(viewer)return;
    viewer=openPhotoViewer({images,name,initial:Number(button.dataset.gallery),opener:button,L,doc,win,onClose:()=>{viewer=null;}});
  }));
}

export function openPhotoViewer({images,name,initial=0,opener,L,doc=document,win=window,onClose=()=>{}}){
  const dialog=doc.createElement('dialog');dialog.className='vii-photo-viewer';dialog.setAttribute('aria-label',L('Galería de ','Gallery for ')+name);
  const toolbar=doc.createElement('div');toolbar.className='vii-photo-toolbar';
  const title=doc.createElement('h2');title.textContent=name;
  const count=doc.createElement('span');count.className='vii-photo-counter';count.setAttribute('aria-live','polite');
  const closeButton=doc.createElement('button');closeButton.type='button';closeButton.className='vii-photo-close';closeButton.setAttribute('aria-label',L('Cerrar galería','Close gallery'));closeButton.textContent='×';toolbar.append(title,count,closeButton);
  const stage=doc.createElement('div');stage.className='vii-photo-stage';
  const message=doc.createElement('p');message.className='vii-photo-message';message.setAttribute('role','status');
  const makeArrow=(label,text,cls)=>{const b=doc.createElement('button');b.type='button';b.className='vii-photo-arrow '+cls;b.setAttribute('aria-label',label);b.textContent=text;b.hidden=images.length<2;return b;};
  const previous=makeArrow(L('Foto anterior','Previous photo'),'←','is-previous'),next=makeArrow(L('Foto siguiente','Next photo'),'→','is-next');
  const thumbs=doc.createElement('div');thumbs.className='vii-photo-thumbs';thumbs.setAttribute('role','group');thumbs.setAttribute('aria-label',L('Elegir fotografía','Choose photo'));
  const thumbButtons=images.map((src,i)=>{const b=doc.createElement('button');b.type='button';b.setAttribute('aria-label',L('Ver fotografía ','View photo ')+(i+1));const img=doc.createElement('img');img.src=src;img.alt='';img.loading='lazy';b.append(img);thumbs.append(b);return b;});
  const makeImage=index=>{const image=doc.createElement('img');image.className='vii-photo-main';image.src=images[index];image.alt=name+' · '+L('Fotografía ','Photo ')+(index+1);image.draggable=false;return image;};
  let current=makeImage(wrapPhoto(initial,images.length)),closing=false,alive=true,gesture;
  const decodes=new Set();
  const animate=(element,frames,duration)=>animateSafely(element,frames,{win,duration});
  const decode=async image=>{if(!image.decode)return;let timer,abort;try{await Promise.race([image.decode(),new Promise((_,reject)=>{abort=()=>reject(Error('Gallery closed'));decodes.add(abort);timer=win.setTimeout(()=>reject(Error('Image unavailable')),8000);})]);}finally{win.clearTimeout(timer);decodes.delete(abort);}};
  const sync=index=>{count.textContent=(index+1)+' / '+images.length;thumbButtons.forEach((b,i)=>b.setAttribute('aria-pressed',String(i===index)));};
  const sequence=createPhotoSequence({count:images.length,initial,show:async(index,direction)=>{
    const incoming=makeImage(index);message.textContent=L('Cargando fotografía…','Loading photo…');dialog.setAttribute('aria-busy','true');
    try{
      await decode(incoming);if(!alive||closing)return false;
      const outgoing=current;stage.append(incoming);current=incoming;sync(index);message.textContent='';
      await Promise.all([animate(incoming,[{opacity:0,transform:'translateX('+direction*30+'px) scale(1.025)'},{opacity:1,transform:'none'}],360),animate(outgoing,[{opacity:1,transform:'none'},{opacity:0,transform:'translateX('+direction*-18+'px)'}],360)]);
      outgoing.remove();return true;
    }finally{dialog.removeAttribute('aria-busy');if(!incoming.isConnected)incoming.remove();}
  },onError:()=>{message.textContent=L('No pudimos cargar esta fotografía. Intenta con otra.','We could not load this photo. Please try another.');}});
  stage.append(current);dialog.append(toolbar,stage,previous,next,message,thumbs);doc.body.append(dialog);sync(sequence.index);
  const finish=()=>{if(!alive)return;alive=false;sequence.destroy();decodes.forEach(abort=>abort());dialog.remove();if(opener?.isConnected)opener.focus({preventScroll:true});onClose();};
  const close=async()=>{
    if(closing||!alive)return;closing=true;sequence.destroy();dialog.classList.add('is-closing');
    const target=buttonsFor(sequence.index).find(b=>{const r=b.getBoundingClientRect();return r.width&&r.top>=0&&r.bottom<=win.innerHeight;})||opener;
    const targetRect=target?.isConnected?target.getBoundingClientRect():null,from=containedRect(stage.getBoundingClientRect(),current.naturalWidth,current.naturalHeight);
    if(targetRect?.width&&targetRect.top>=0&&targetRect.top<win.innerHeight&&!reducedMotion(win)){
      current.style.visibility='hidden';
      // Reverse FLIP, with the selected image landing back on its thumbnail.
      const clone=current.cloneNode();clone.className='vii-photo-flight';Object.assign(clone.style,{left:from.left+'px',top:from.top+'px',width:from.width+'px',height:from.height+'px'});dialog.append(clone);
      await animate(clone,[{transform:'none',opacity:1},{transform:imageTransform(targetRect,from),opacity:.25}],300);clone.remove();
    }else await animate(stage,[{transform:'scale(1)',opacity:1},{transform:'scale(.93)',opacity:0}],220);
    if(dialog.open)dialog.close();else finish();
  };
  const buttonsFor=index=>[...doc.querySelectorAll('[data-gallery="'+index+'"]')];
  closeButton.onclick=()=>void close();previous.onclick=()=>void sequence.go(sequence.index-1);next.onclick=()=>void sequence.go(sequence.index+1);
  thumbButtons.forEach((button,index)=>button.onclick=()=>void sequence.go(index));
  dialog.addEventListener('cancel',event=>{event.preventDefault();void close();});dialog.addEventListener('close',finish,{once:true});
  dialog.addEventListener('click',event=>{if(event.target===dialog)void close();});
  dialog.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();void sequence.go(sequence.index+(event.key==='ArrowRight'?1:-1));}});
  stage.addEventListener('pointerdown',event=>{if(event.isPrimary&&event.button===0)gesture={id:event.pointerId,x:event.clientX,y:event.clientY};});
  stage.addEventListener('pointerup',event=>{if(!gesture||gesture.id!==event.pointerId)return;const x=event.clientX-gesture.x,y=event.clientY-gesture.y;gesture=null;if(Math.abs(x)>45&&Math.abs(x)>Math.abs(y)*1.4)void sequence.go(sequence.index+(x<0?1:-1));});
  stage.addEventListener('pointercancel',()=>{gesture=null;});
  dialog.showModal();closeButton.focus({preventScroll:true});
  const openingImage=current;
  void (async()=>{
    try{await decode(openingImage);if(!alive||closing||current!==openingImage)return;const source=opener?.querySelector('img'),from=source?.getBoundingClientRect(),to=containedRect(stage.getBoundingClientRect(),openingImage.naturalWidth,openingImage.naturalHeight);
      if(from?.width&&!reducedMotion(win)){openingImage.style.visibility='hidden';try{await flyPhoto({image:openingImage,from,to,parent:dialog,win,doc});}finally{if(alive)openingImage.style.visibility='';}}
    }catch{if(alive)message.textContent=L('No pudimos cargar esta fotografía. Intenta con otra.','We could not load this photo. Please try another.');}
  })();
  return{close};
}
