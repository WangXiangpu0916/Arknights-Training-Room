import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';

const [before,after,output='output/ui-comparison']=process.argv.slice(2);
if(!before || !after)throw new Error('Usage: node scripts/compare-ui.mjs <baseline> <current> [output]');
await mkdir(output,{recursive:true});
const report=[];
for(const name of (await readdir(before)).filter(n=>n.endsWith('.png')).sort()) {
  const a=PNG.sync.read(await readFile(path.join(before,name)));
  const b=PNG.sync.read(await readFile(path.join(after,name)));
  if(a.width!==b.width || a.height!==b.height)throw new Error(`Viewport mismatch: ${name}`);
  const diff=new PNG({width:a.width,height:a.height});
  let changed=0,over16=0,maximum=0,total=0;
  for(let i=0;i<a.data.length;i+=4){
    const delta=Math.max(...[0,1,2,3].map(c=>Math.abs(a.data[i+c]-b.data[i+c])));
    if(delta)changed++;if(delta>16)over16++;maximum=Math.max(maximum,delta);total+=delta;
    diff.data.set(delta ? [255,0,100,255] : [b.data[i]/4,b.data[i+1]/4,b.data[i+2]/4,255],i);
  }
  report.push({name,width:a.width,height:a.height,changedPixels:changed,changedPercent:changed*100/(a.width*a.height),over16Pixels:over16,maxChannelDifference:maximum,meanMaxChannelDifference:total/(a.width*a.height)});
  await writeFile(path.join(output,name),PNG.sync.write(diff));
}
await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
