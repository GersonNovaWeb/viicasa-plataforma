import {test} from 'node:test';
import assert from 'node:assert/strict';
import {paymentGateway} from '../viicasa-backend/src/payments.js';

test('ViiLife checkout disables adaptive FX without changing shop or property settings',async()=>{
  const captured=[];
  const stripe={checkout:{sessions:{create:async(params,options)=>{captured.push({params,options});return {id:'cs_test_fixture',url:'https://checkout.stripe.com/test'};}}}};
  const gateway=paymentGateway({paymentProvider:'stripe',siteUrl:'https://example.invalid'},{stripe});
  for(const kind of ['cleaning','order','booking']){
    await gateway.create({id:'fixture',currency:'CAD',amount_minor:19998,expires_at:new Date(Date.now()+35*60000).toISOString()},{id:'checkout-fixture',kind,customer_email:'qa@example.invalid'});
  }
  assert.deepEqual(captured[0].params.adaptive_pricing,{enabled:false});
  assert.equal(captured[0].params.mode,'payment');
  assert.deepEqual(captured[0].params.payment_method_types,['card']);
  assert.equal(captured[0].params.line_items[0].price_data.currency,'cad');
  assert.equal(captured[0].params.line_items[0].price_data.unit_amount,19998);
  assert.equal(captured[0].options.idempotencyKey,'viicasa-fixture');
  assert.equal(captured[1].params.adaptive_pricing,undefined);
  assert.equal(captured[2].params.adaptive_pricing,undefined);
});
