import {fail} from '../viicasa-backend/src/lib.js';
export async function providerJson(url,{fetcher=fetch,headers={},method='GET',body,signal}={}){
  const address=new URL(url);if(address.protocol!=='https:'||address.username||address.password)fail(400,'Invalid provider endpoint.');
  let response;try{response=await fetcher(address.href,{method,headers:{accept:'application/json',...(body?{'content-type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined,redirect:'error',signal:signal||AbortSignal.timeout(15000)});}catch{fail(503,'Provider request could not be confirmed.');}
  if(!response.ok)fail(response.status===429?429:502,'Provider rejected the request.');const declared=Number(response.headers?.get?.('content-length')||0);if(declared>4000000)fail(502,'Provider response exceeds limit.');
  let text;
  if(response.body?.getReader){const reader=response.body.getReader(),chunks=[];let length=0;try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>4000000){await reader.cancel();fail(502,'Provider response exceeds limit.');}chunks.push(Buffer.from(value));}text=Buffer.concat(chunks).toString('utf8');}catch(e){if(e.statusCode)throw e;fail(503,'Provider response could not be confirmed.');}finally{reader.releaseLock();}}
  else{text=await response.text();if(Buffer.byteLength(text)>4000000)fail(502,'Provider response exceeds limit.');}
  try{return JSON.parse(text);}catch{fail(502,'Provider returned an invalid response.');}
}
export const moneyMinor=value=>{if(typeof value!=='string'||!/^\d{1,6}(?:\.\d{1,2})?$/.test(value))fail(409,'Unsupported provider money value.');const [a,b='']=value.split('.');return Number(a)*100+Number(b.padEnd(2,'0'));};
