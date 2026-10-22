try{
  const response=await fetch('/api/config',{credentials:'same-origin'}),profile=await response.json();
  if(response.ok&&profile.runtimeMode==='staging'){
    document.documentElement.dataset.runtimeMode='staging';
    const update=()=>{
      for(const element of document.querySelectorAll('.login-visual > small,.sidebar .bottom'))for(const node of element.childNodes)if(node.nodeType===Node.TEXT_NODE&&node.textContent.includes('PHASE 02 · DEMO'))node.textContent=node.textContent.replace('PHASE 02 · DEMO','PHASE 02 · PREPRODUCTION');
      for(const element of document.querySelectorAll('#shop-examples,#import-product,[data-product-edit],[data-inventory],[data-paid],[data-fulfill],[data-simulate-job]')){if(!element.disabled)element.disabled=true;element.title='Unavailable in preproduction; use the independent demo.';}
    };update();new MutationObserver(update).observe(document.body,{childList:true,subtree:true});
  }
}catch{/* A presentation request never changes server permissions or page access. */}
