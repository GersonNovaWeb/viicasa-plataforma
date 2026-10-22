import {createHash} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {join,relative} from 'node:path';

// Runtime source only, never .env, credentials, databases, uploads or test results.
// Calculated once per process: restart after changing code before recording results.
let revision;
export function runtimeSourceRevision(root){
  return revision??=calculate(root);
}
async function calculate(root){
  const files=[];
  async function walk(path){
    for(const entry of await readdir(path,{withFileTypes:true})){
      if(['test','node_modules','.git','data','.secrets'].includes(entry.name))continue;
      const file=join(path,entry.name);
      if(entry.isDirectory())await walk(file);
      else if(entry.isFile()&&/\.(?:js|mjs|html|css)$/.test(entry.name))files.push(file);
    }
  }
  for(const directory of ['phase2','viicasa-backend/src','viicasa-frontend-prototype'])await walk(join(root,directory));
  files.push(join(root,'package.json'),join(root,'package-lock.json'));
  const hash=createHash('sha256');
  for(const file of files.sort()){
    const name=relative(root,file).replaceAll('\\','/'),body=await readFile(file);
    hash.update(name+'\0'+body.length+'\0');hash.update(body);
  }
  return hash.digest('hex');
}
