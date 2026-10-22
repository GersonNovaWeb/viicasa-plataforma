// Search preferences are not a promise of availability. The quote endpoint remains authoritative.
export function stayPreferences(value){
  const get=key=>typeof value?.get==='function'?value.get(key):value?.[key];
  const date=key=>{const value=get(key);return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value?value:'';};
  const checkIn=date('checkIn')||date('check_in'),checkOut=date('checkOut')||date('check_out'),guests=Number(get('guests'));
  return{checkIn,checkOut:checkOut&&(!checkIn||checkOut>checkIn)?checkOut:'',guests:Number.isSafeInteger(guests)&&guests>=1&&guests<=100?guests:1};
}
export function stayHref(href,value){
  const selection=stayPreferences(value),params=new URLSearchParams();
  if(selection.checkIn)params.set('check_in',selection.checkIn);
  if(selection.checkOut)params.set('check_out',selection.checkOut);
  if(selection.guests>1)params.set('guests',selection.guests);
  return href+(params.size?(href.includes('?')?'&':'?')+params:'');
}
