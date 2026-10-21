import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { Worker, type WorkerOptions } from 'worker_threads'

export interface EpubSection { text:string; location:{kind:'chapter';start:number} }
export interface ExtractionWorker extends EventEmitter { terminate():Promise<number> }
interface Options {
  timeoutMs?:number
  createWorker?:(code:string,options:WorkerOptions)=>ExtractionWorker
}
const MAX_TEXT=2_000_000
const workerCode=`
const {parentPort,workerData}=require('worker_threads');
const {EPub}=require(workerData.modulePath);
let sent=false;
function fail(){if(!sent){sent=true;parentPort.postMessage({ok:false})}}
const epub=new EPub(workerData.filename);
epub.once('error',fail);
epub.once('end',async()=>{
  try{
    const sections=[];let total=0;
    for(let n=0;n<epub.flow.length;n++){
      const chapter=epub.flow[n];
      const html=await new Promise((resolve,reject)=>epub.getChapter(chapter.id,(error,text)=>error?reject(error):resolve(text)));
      const text=html.replace(/<script[\\s\\S]*?<\\/script>|<style[\\s\\S]*?<\\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&');
      total+=text.length;if(total>workerData.maxText)throw Error('text limit');
      sections.push({text,location:{kind:'chapter',start:n+1}});
    }
    if(!sent){sent=true;parentPort.postMessage({ok:true,sections})}
  }catch{fail()}
});
try{epub.parse()}catch{fail()}
`

/** Resolve/reject only after termination completes, including on timeout or late callbacks. */
export async function extractEpubSections(bytes:Buffer,options:Options={}):Promise<EpubSection[]> {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'goga-epub-'))
  const filename=path.join(directory,'source.epub')
  const cleanup=()=>{try{if(fs.existsSync(filename))fs.unlinkSync(filename)}finally{fs.rmdirSync(directory)}}
  let worker:ExtractionWorker
  try{
    // The worker reads exactly the immutable bytes hashed by the importer, not a changing source path.
    fs.writeFileSync(filename,bytes,{mode:0o600})
    const create=options.createWorker??((code,settings)=>new Worker(code,settings))
    worker=create(workerCode,{eval:true,workerData:{filename,modulePath:require.resolve('epub2'),maxText:MAX_TEXT},resourceLimits:{maxOldGenerationSizeMb:128}})
  }catch{cleanup();throw new Error('EPUB extraction could not start. No index was changed.')}
  return new Promise((resolve,reject)=>{
    let stopping=false
    let timer:ReturnType<typeof setTimeout>|undefined
    let resolveExit!:()=>void
    const exited=new Promise<void>(resolve=>{resolveExit=resolve})
    const finish=async(error?:Error,sections?:EpubSection[])=>{
      if(stopping)return
      stopping=true
      if(timer)clearTimeout(timer)
      try{
        let shutdownFailed=false
        try {await worker.terminate()}catch{shutdownFailed=true}
        // Do not release the caller's import guard even if termination itself fails.
        await exited
        worker.removeAllListeners()
        cleanup()
        if(shutdownFailed)reject(new Error('EPUB worker termination failed; the worker has now exited. No index was changed.'))
        else if(error)reject(error);else resolve(sections!)
      }catch{reject(new Error('EPUB worker shutdown or temporary-file cleanup failed. No index was changed.'))}
    }
    worker.on('message',(message:any)=>{
      if(stopping)return
      const sections=message?.sections
      if(message?.ok!==true || !Array.isArray(sections)
        || !sections.every(s=>s && typeof s.text==='string' && s.location?.kind==='chapter' && Number.isSafeInteger(s.location.start) && s.location.start>0)
        || sections.reduce((n,s)=>n+s.text.length,0)>MAX_TEXT){
        void finish(new Error('EPUB extraction failed: invalid, encrypted, unsupported, or excessive text. No index was changed.'))
      }else void finish(undefined,sections)
    })
    worker.on('error',()=>{void finish(new Error('EPUB extraction worker failed. No index was changed.'))})
    worker.on('exit',()=>{resolveExit();if(!stopping)void finish(new Error('EPUB extraction stopped before returning chapters. No index was changed.'))})
    timer=setTimeout(()=>{void finish(new Error('EPUB extraction timed out. Its worker was stopped; no index was changed.'))},options.timeoutMs??30_000)
  })
}
