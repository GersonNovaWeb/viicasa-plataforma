import {fail} from '../viicasa-backend/src/lib.js';
import {addServiceDays} from './service-time.mjs';

export function weeklyDays(input,basis){
  const days=input??[];
  if(!Array.isArray(days)||days.length>7||new Set(days).size!==days.length||days.some(d=>!Number.isInteger(d)||d<0||d>6))fail(400,'Select distinct weekdays from 0 (Sunday) to 6 (Saturday).');
  if(days.length&&basis!=='weekly_package')fail(400,'Multiple weekdays currently apply to negotiated weekly packages only.');
  return[...days].sort((a,b)=>a-b);
}
export function executionCount(quote){return quote.visits*(quote.weekly_days?.length||1);}
export function expandedWeeklyDates(quote,first){
  const days=weeklyDays(quote.weekly_days,quote.basis),start=new Date(first+'T12:00:00Z');
  if(!days.length)return null;
  if(!days.includes(start.getUTCDay()))fail(400,'The first service date must be one of the selected weekdays.');
  const offsets=days.map(d=>(d-start.getUTCDay()+7)%7).sort((a,b)=>a-b),result=[];
  for(let block=0;block<quote.visits;block++)for(const offset of offsets)result.push({service_date:addServiceDays(first,block*7+offset),block_index:block});
  return result;
}
export function scheduleAmounts(quote,properties,allocate){
  const count=executionCount(quote),totalRows=properties.length*count;
  if(!properties.length||totalRows>300)fail(400,'Split the service schedule into at most 300 execution visits.');
  const weights=properties.flatMap(p=>Array(count).fill(['sqft','sqft_visit'].includes(quote.basis)?p.sqft:1));
  if(!quote.weekly_days?.length)return{count,weights,bases:allocate(quote.subtotal_minor,weights),discounts:allocate(quote.intro_discount_minor,weights)};
  const visitsPerBlock=quote.weekly_days.length,weekDiscounts=allocate(quote.intro_discount_minor,Array(quote.visits).fill(1));
  const blockBase=quote.rate_minor*quote.quantity,within=Array(properties.length*visitsPerBlock).fill(1);
  const blocks=Array.from({length:quote.visits},(_,b)=>({base:allocate(blockBase,within),discount:allocate(weekDiscounts[b],within)}));
  const bases=[],discounts=[];
  for(let property=0;property<properties.length;property++)for(let b=0;b<quote.visits;b++)for(let day=0;day<visitsPerBlock;day++){
    bases.push(blocks[b].base[property*visitsPerBlock+day]);discounts.push(blocks[b].discount[property*visitsPerBlock+day]);
  }
  return{count,weights,bases,discounts};
}
