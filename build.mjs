import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
const out=path.join(root,'dist');
const read=file=>readFile(path.join(root,file),'utf8');
const hash=text=>createHash('sha256').update(text).digest('hex').slice(0,10);

// GitHub Pages serves the repo root and phones cache aggressively, so every asset URL
// carries a content hash (?v=...). Stamp the root files in place, then copy to dist/.
const stamp=(text,file,version)=>text.replace(new RegExp(`(${file.replace('.','\\.')})\\?v=[\\w-]+`,'g'),`$1?v=${version}`);
let app=await read('app.js');
app=stamp(app,'pose-analysis.js',hash(await read('pose-analysis.js')));
await writeFile(path.join(root,'app.js'),app);
let html=await read('index.html');
for(const file of ['styles.css','config.js','app.js']) html=stamp(html,file,hash(await read(file)));
await writeFile(path.join(root,'index.html'),html);

await rm(out,{recursive:true,force:true});
await mkdir(out,{recursive:true});
for(const file of ['index.html','styles.css','app.js','config.js','pose-analysis.js']) await cp(path.join(root,file),path.join(out,file));
if(existsSync(path.join(root,'.openai','hosting.json'))){await mkdir(path.join(out,'.openai'),{recursive:true});await cp(path.join(root,'.openai','hosting.json'),path.join(out,'.openai','hosting.json'));}
console.log(`Big Jump static site prepared at ${out}`);
