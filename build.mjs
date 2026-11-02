import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const out=path.join(root,'dist');
await rm(out,{recursive:true,force:true});
await mkdir(out,{recursive:true});
for(const file of ['index.html','styles.css','app.js','config.js','pose-analysis.js']) await cp(path.join(root,file),path.join(out,file));
if(existsSync(path.join(root,'.openai','hosting.json'))){await mkdir(path.join(out,'.openai'),{recursive:true});await cp(path.join(root,'.openai','hosting.json'),path.join(out,'.openai','hosting.json'));}
console.log(`Big Jump static site prepared at ${out}`);
