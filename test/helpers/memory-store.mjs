// Isolated fixture only. Never selected by the production entry point.
export function memoryStore(){
  let rows=new Map();const clone=x=>x==null?x:structuredClone(x);
  const ops=map=>({get:async(c,k)=>clone(map.get(c+'/'+k)||null),put:(c,k,v)=>map.set(c+'/'+k,clone({...v,id:k})),create:(c,k,v)=>{if(map.has(c+'/'+k))throw Error('Duplicate fixture');map.set(c+'/'+k,clone({...v,id:k}));},remove:(c,k)=>map.delete(c+'/'+k),list:async(c,o={})=>{let values=[...map.entries()].filter(([k])=>k.startsWith(c+'/')).map(([,v])=>clone(v)).filter(v=>(o.where||[]).every(([f,op,x])=>op==='=='?v[f]===x:op==='<='?v[f]<=x:op==='>'?v[f]>x:op==='array-contains'?v[f]?.includes(x):false));for(const[f,d]of [...(o.order||[])].reverse())values.sort((a,b)=>String(a[f]).localeCompare(String(b[f]))*(d==='desc'?-1:1));return values.slice(o.offset||0,(o.offset||0)+(o.limit||100));}});
  return{get:(...a)=>ops(rows).get(...a),set:(...a)=>ops(rows).put(...a),list:(...a)=>ops(rows).list(...a),count:async(c,where)=>(await ops(rows).list(c,{where,limit:10000})).length,transaction:async fn=>{const next=structuredClone(rows),result=await fn(ops(next));rows=next;return result;}};
}
