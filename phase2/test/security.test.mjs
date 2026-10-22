import {test} from 'node:test';
import assert from 'node:assert/strict';
import {totp,verifyTotp,secretVault} from '../security.mjs';
import {quoteService,cancellationRepayment} from '../service-menu.mjs';

test('TOTP matches RFC 6238, rejects used counters and invalid codes; encrypted secrets authenticate',()=>{
  const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totp(secret,1),'287082');
  assert.equal(verifyTotp(secret,'287082',-1,59000),1);
  assert.equal(verifyTotp(secret,'287082',1,59000),null);
  assert.equal(verifyTotp(secret,'999999',-1,59000),null);
  const vault=secretVault(Buffer.alloc(32,7)),sealed=vault.seal(secret);
  assert.notEqual(sealed,secret);assert.equal(vault.open(sealed),secret);
  const bytes=Buffer.from(sealed,'base64');bytes[bytes.length-1]^=1;assert.throws(()=>vault.open(bytes.toString('base64')));
});
test('commercial team is charged as a two-person team, annual introductory discount applies only to eligible periods',()=>{
  const quote={service_id:'commercial-team',rate_minor:7500,quantity:3,visits:4,frequency:'weekly',term:'annual',properties:[]};
  const result=quoteService(quote);assert.equal(result.subtotal_minor,90000);assert.equal(result.intro_discount_minor,27000);assert.equal(result.total_minor,63000);assert.equal(result.team_size,2);assert.equal(result.discount_months,3);
  assert.equal(quoteService({...quote,frequency:'biweekly'}).intro_discount_minor,0);
  assert.equal(quoteService({...quote,term:'month_to_month'}).intro_discount_minor,0);
  assert.equal(cancellationRepayment([27000,27000]),54000);
});
test('project fees cannot be treated as recurring hourly charges; property area and tariff ranges are validated',()=>{
  assert.throws(()=>quoteService({service_id:'home-deep',rate_minor:35000,quantity:3,visits:2,frequency:'weekly',term:'month_to_month'}),e=>e.statusCode===400);
  const selection={service_id:'commercial-janitorial',rate_minor:8,quantity:3000,visits:4,frequency:'weekly',term:'annual',properties:[{address:'123 Example Street',sqft:3000}]};
  assert.equal(quoteService(selection).total_minor,67200);
  assert.throws(()=>quoteService({...selection,quantity:2000}),e=>e.statusCode===400);
  assert.throws(()=>quoteService({...selection,rate_minor:1}),e=>e.statusCode===400);
});
