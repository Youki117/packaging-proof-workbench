import {readFile,stat} from 'node:fs/promises';
import {basename,extname,resolve,posix} from 'node:path';
import JSZip from 'jszip';
import xmlJs from 'xml-js';
const {xml2js}=xmlJs;
const MAX_BYTES=50*1024*1024;
export async function readInput(path){
 path=resolve(path);const info=await stat(path);
 if(!info.isFile()||!info.size||info.size>MAX_BYTES)throw Error('输入必须为非空普通文件且不超过50 MiB');
 return {path,name:basename(path),size:info.size,mtime_ms:info.mtimeMs,bytes:await readFile(path)};
}
const nodes=v=>v==null?[]:Array.isArray(v)?v:[v];
const text=node=>typeof node==='string'?node:[node?._text,node?._cdata,...nodes(node?.t).map(text),...nodes(node?.r).map(text)].filter(v=>v!==undefined).join('');
const xml=s=>xml2js(s,{compact:true,ignoreComment:true,ignoreDeclaration:true});
export async function readFormula(path){
 const source=await readInput(path),ext=extname(path).toLowerCase();
 if(['.txt','.md','.csv','.tsv'].includes(ext))return {text:new TextDecoder('utf-8',{fatal:true}).decode(source.bytes).replace(/^\uFEFF/,''),source:source.name};
 if(!['.xlsx','.xlsm'].includes(ext))return {text:'',media_path:source.path,source:source.name};
 const zip=await JSZip.loadAsync(source.bytes);let expanded=0;
 const raw=async name=>{const file=zip.file(name);if(!file)throw Error(`XLSX缺少 ${name}`);const size=file._data?.uncompressedSize||0;expanded+=size;if(size>20*1024*1024||expanded>80*1024*1024)throw Error('XLSX展开内容过大');return file.async('string');};
 const shared=zip.file('xl/sharedStrings.xml')?nodes(xml(await raw('xl/sharedStrings.xml')).sst?.si).map(text):[];
 const rels=new Map(nodes(xml(await raw('xl/_rels/workbook.xml.rels')).Relationships?.Relationship).map(r=>[r._attributes.Id,r._attributes]));
 const sheets=nodes(xml(await raw('xl/workbook.xml')).workbook?.sheets?.sheet),output=[];
 let count=0;
 for(const sheet of sheets){
  const rel=rels.get(sheet._attributes['r:id']);if(!rel||rel.TargetMode==='External')throw Error('XLSX工作表外部引用不受支持');
  const target=posix.normalize(rel.Target.startsWith('/')?rel.Target.slice(1):posix.join('xl',rel.Target));if(!target.startsWith('xl/'))throw Error('XLSX工作表路径无效');
  const data=xml(await raw(target)).worksheet;output.push(`Sheet: ${sheet._attributes.name}`);
  for(const row of nodes(data?.sheetData?.row)){
   const cells=[];
   for(const c of nodes(row.c)){
    if(++count>100_000)throw Error('配方表超过10万单元格');
    const type=c._attributes?.t;let value=type==='s'?shared[Number(text(c.v))]:type==='inlineStr'?text(c.is):text(c.v);
    if(type==='e')throw Error(`XLSX单元格 ${c._attributes?.r} 包含错误值`);
    if(c.f&&!nodes(c.v).length)throw Error(`XLSX公式 ${c._attributes?.r} 没有缓存值，请重新计算并保存`);
    if(value!==undefined&&value!=='')cells.push(`${c._attributes?.r||'?'}=${value}`);
   }
   if(cells.length)output.push(cells.join('\t'));
  }
  const merges=nodes(data?.mergeCells?.mergeCell).map(m=>m._attributes?.ref).filter(Boolean);if(merges.length)output.push('合并单元格范围：'+merges.join('、'));
 }
 const result=output.join('\n');if(!result.trim()||count===0)throw Error('配方表没有可读单元格');
 return {text:result,source:source.name};
}
