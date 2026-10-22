import {fail} from '../viicasa-backend/src/lib.js';
export const dateOnly=v=>new Date(v).toISOString().slice(0,10);
export function validStayDate(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||dateOnly(value)!==value)fail(400,'Invalid stay date.');return value;}
const formatters=new Map();
export function timezoneFormatter(zone){
  if(!formatters.has(zone)){try{formatters.set(zone,new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}));}catch{fail(400,'Invalid IANA time zone.');}}
  return formatters.get(zone);
}
export function localStayTime(date,time,zone){
  validStayDate(date);if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))fail(400,'Invalid arrival/departure time.');
  const fmt=timezoneFormatter(zone),wanted=date+'T'+time,base=Date.parse(wanted+':00Z'),matches=[];
  // Current IANA offsets are multiples of 15 minutes. Reject gaps/ambiguous local
  // times explicitly instead of silently shifting a guest's arrival by an hour.
  for(let minutes=-14*60;minutes<=14*60;minutes+=15){const instant=new Date(base+minutes*60000),p=Object.fromEntries(fmt.formatToParts(instant).map(x=>[x.type,x.value]));if(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`===wanted)matches.push(instant.toISOString());}
  if(matches.length!==1)fail(400,'This local time is missing or ambiguous during a clock change. Choose another time.');return matches[0];
}
export function stayLocalDay(zone,now=new Date()){const p=Object.fromEntries(timezoneFormatter(zone).formatToParts(now).map(x=>[x.type,x.value]));return`${p.year}-${p.month}-${p.day}`;}
