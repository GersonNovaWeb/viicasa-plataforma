import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localEmulatorHost} from '../viicasa-frontend-prototype/local-emulator.mjs';
test('local emulator defaults to the new port and allows explicit loopback overrides',()=>{
  assert.equal(localEmulatorHost(),'127.0.0.1:8095');
  assert.equal(localEmulatorHost('127.0.0.1:8088'),'127.0.0.1:8088');
  for(const host of ['example.com:8095','0.0.0.0:8095','127.0.0.1:80','127.0.0.1:99999','http://127.0.0.1:8095','127.0.0.1:8095/path'])assert.throws(()=>localEmulatorHost(host));
});
