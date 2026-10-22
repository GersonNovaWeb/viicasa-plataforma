import {normalizeIP} from '@fastify/rate-limit';

// Static modules/images must not exhaust the budget for checkout or account operations.
// Use the socket IP (Fastify's request.ip), never a caller-provided forwarding header.
export function trafficBucket(request){
  if(!['GET','HEAD'].includes(request.method))return 'write';
  const path=request.url.split('?')[0];
  return path.startsWith('/api/')||path.startsWith('/v1/')?'read':'page';
}
export const trafficKey=request=>normalizeIP(request.ip)+':'+trafficBucket(request);
export function storefrontLimits({testing=false,internal=false}={}){
  return{timeWindow:'1 minute',keyGenerator:trafficKey,max:request=>testing?100000:trafficBucket(request)==='page'?1200:trafficBucket(request)==='read'?250:internal?120:250};
}
