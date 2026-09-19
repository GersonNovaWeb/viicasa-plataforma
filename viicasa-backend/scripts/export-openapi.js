import {writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildApp} from '../src/app.js';
import {configFromEnv} from '../src/config.js';
const mediaDir=await mkdtemp(join(tmpdir(),'viicasa-openapi-'));
const config=configFromEnv();
if(config.driver==='firestore'&&config.firebaseMode!=='emulator')throw new Error('Exportar documentación en emulador; no inicializar el proyecto real');
const app=await buildApp({...config,memory:true,mediaDir},{logger:false});
try{
  const name=config.driver==='firestore'?'openapi.firestore.json':'openapi.demo.json';
  await writeFile(new URL(`../docs/${name}`,import.meta.url),JSON.stringify(app.swagger(),null,2)+'\n');
  console.log(`${Object.keys(app.swagger().paths).length} rutas documentadas en docs/${name}`);
}finally{await app.close();await rm(mediaDir,{recursive:true,force:true});}
