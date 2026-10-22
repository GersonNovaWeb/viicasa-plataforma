import {fail} from '../viicasa-backend/src/lib.js';

export const serviceZone='America/Vancouver';
const dayFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:serviceZone,year:'numeric',month:'2-digit',day:'2-digit'});
export function serviceDay(now=new Date()){
  const date=new Date(now);if(!Number.isFinite(date.getTime()))fail(400,'Invalid service calendar instant.');
  const parts=Object.fromEntries(dayFormatter.formatToParts(date).map(p=>[p.type,p.value]));
  return`${parts.year}-${parts.month}-${parts.day}`;
}
export function addServiceDays(day,count){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isInteger(count)||Math.abs(count)>36500)fail(400,'Invalid calendar day offset.');
  const date=new Date(day+'T12:00:00Z');
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==day)fail(400,'Invalid calendar day.');
  // Plain calendar arithmetic: DST never turns a Net 15 day into a 24-hour delay.
  date.setUTCDate(date.getUTCDate()+count);return date.toISOString().slice(0,10);
}
export function invoiceCalendar(segment,now=new Date()){
  if(!['home','commercial'].includes(segment))fail(400,'Invalid service invoice segment.');
  const issued_date=serviceDay(now);
  return{timezone:serviceZone,issued_date,due_date:segment==='commercial'?addServiceDays(issued_date,15):issued_date};
}
