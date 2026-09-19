import {spawn} from 'node:child_process';
// Requires the local emulator. Never inherits real-project configuration.
const child=spawn(process.execPath,['--test','--test-concurrency=1','test/firestore.test.js'],{
  stdio:'inherit',windowsHide:true,env:{...process.env,RUN_FIRESTORE_TESTS:'true'},
});
child.on('error',()=>{console.error('No se pudo iniciar la suite');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
