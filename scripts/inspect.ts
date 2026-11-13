import { DOMParser } from '@xmldom/xmldom';
import { readFileSync } from 'node:fs';
import { setXmlParser } from '../src/io/xml';
import { loadScoreFromBytes } from '../src/io/files';
import { parseMusicXml } from '../src/io/musicxml';
import { noteMidi, eventTicks } from '../src/model';
setXmlParser((src) => new DOMParser({ onError: () => {} }).parseFromString(src, 'text/xml') as unknown as Document);
const dir=process.env.CORPUS ?? '';
const n=process.argv[2]; const st=Number(process.argv[3]??0); const ms=(process.argv[4]??'0-2').split('-').map(Number);
const A=loadScoreFromBytes(readFileSync(dir+n+'.mscz'));
const B=parseMusicXml(readFileSync(dir+n+'.musicxml','utf8'));
for (const [name,S] of [['A',A],['B',B]] as const){
  console.log(name, S.parts.map(p=>p.name+' '+JSON.stringify(p.transpose)+' '+p.staves.map(s=>s.clef)).join(' | '), 'measures', S.measures.length);
  for(let j=ms[0];j<=ms[1];j++){ const m=S.measures[j]; console.log(' m'+j, JSON.stringify({t:m.time,k:m.key,len:m.len}), m.staves[st]?.voices.map(v=>v.map(e=>(e.rest?(e.hidden?'h':'r'):e.notes.map(noteMidi).join('+'))+':'+eventTicks(e)).join(' ')).join(' || '));}
}
