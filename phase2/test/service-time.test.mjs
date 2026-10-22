import {test} from 'node:test';
import assert from 'node:assert/strict';
import {serviceDay,addServiceDays,invoiceCalendar} from '../service-time.mjs';
import {serviceToday} from '../service-operations.mjs';

test('home due date uses Vancouver day when UTC has already rolled into tomorrow',()=>{
  const instant=new Date('2026-10-14T00:55:00Z');
  assert.equal(serviceDay(instant),'2026-10-13');assert.equal(serviceToday(instant),'2026-10-13');
  assert.deepEqual(invoiceCalendar('home',instant),{timezone:'America/Vancouver',issued_date:'2026-10-13',due_date:'2026-10-13'});
  assert.equal(invoiceCalendar('commercial',instant).due_date,'2026-10-28');
});
test('service calendar changes only at Vancouver midnight in summer and winter',()=>{
  for(const [before,after,oldDay,newDay]of [
    ['2026-07-01T06:59:59Z','2026-07-01T07:00:00Z','2026-06-30','2026-07-01'],
    ['2026-12-01T07:59:59Z','2026-12-01T08:00:00Z','2026-11-30','2026-12-01']
  ]){assert.equal(serviceDay(before),oldDay);assert.equal(serviceDay(after),newDay);}
});
test('Net 15 uses calendar days across DST, leap day, month and year boundaries',()=>{
  assert.equal(invoiceCalendar('commercial','2026-03-07T20:00:00Z').due_date,'2026-03-22');
  assert.equal(invoiceCalendar('commercial','2026-10-31T20:00:00Z').due_date,'2026-11-15');
  assert.equal(addServiceDays('2028-02-20',15),'2028-03-06');
  assert.equal(addServiceDays('2026-12-25',15),'2027-01-09');
  for(const args of [['2026-02-30',1],['not-a-date',15],['2026-10-13',1.5]])assert.throws(()=>addServiceDays(...args));
  assert.throws(()=>serviceDay('invalid'));assert.throws(()=>invoiceCalendar('unknown'));
});
