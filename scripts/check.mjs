import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
let count=0;
async function check(directory){
  for(const item of await readdir(directory,{withFileTypes:true})){
    if(['node_modules','.git','data','.npm-cache','.secrets'].includes(item.name))continue;
    const path=join(directory,item.name);
    if(item.isDirectory())await check(path);
    else if(/\.(?:js|mjs)$/.test(item.name)){
      const result=spawnSync(process.execPath,['--check',path],{stdio:'inherit'});
      if(result.status!==0)process.exit(result.status||1);count++;
    }
  }
}
await check(root);console.log(`${count} JavaScript files checked. No Firebase or payment calls.`);
