import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {EventEmitter} from 'events'
import {Worker} from 'worker_threads'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {extractEpubSections} from '../epubExtraction'
import {LibraryService,LocalLibraryIndex} from '../library'

class ControlledWorker extends EventEmitter {
  private resolveStop!:(code:number)=>void
  private stop=new Promise<number>(resolve=>{this.resolveStop=resolve})
  terminate=vi.fn(()=>this.stop)
  exit(){this.emit('exit',1);this.resolveStop(1)}
}
let folder:string
beforeEach(()=>{folder=fs.mkdtempSync(path.join(os.tmpdir(),'goga-epub-test-'))})
afterEach(()=>{vi.useRealTimers();fs.rmSync(folder,{recursive:true,force:true})})
const fixture=path.join(__dirname,'fixtures/library.epub')
const chapter={text:'Fixture moonstone navigation',location:{kind:'chapter',start:1}}

async function seed(){
 const store=new LocalLibraryIndex(path.join(folder,'index.json'))
 const file=path.join(folder,'existing.txt');fs.writeFileSync(file,'Existing orchard book')
 const service=new LibraryService(store);await service.ingest(file)
 return {store,before:fs.readFileSync(store.filename,'utf8')}
}

describe('terminable EPUB extraction',()=>{
 it('keeps the guard during timeout shutdown, ignores late callbacks, preserves the index, then permits a successful EPUB import',async()=>{
  const {store,before}=await seed()
  vi.useFakeTimers()
  const workers=[new ControlledWorker(),new ControlledWorker()],files:string[]=[]
  let count=0
  const service=new LibraryService(new LocalLibraryIndex(store.filename),bytes=>extractEpubSections(bytes,{timeoutMs:10,createWorker:(_code,options)=>{
   files.push((options.workerData as any).filename);return workers[count++]
  }}))
  let finished=false
  const pending=service.ingest(fixture).catch(error=>{finished=true;return error})
  await vi.advanceTimersByTimeAsync(11)
  expect(workers[0].terminate).toHaveBeenCalledOnce();expect(finished).toBe(false)
  await expect(service.ingest(fixture)).rejects.toThrow('already running')
  // The parser may emit success after the deadline but before its worker exits.
  workers[0].emit('message',{ok:true,sections:[chapter]})
  expect(finished).toBe(false);expect(fs.readFileSync(store.filename,'utf8')).toBe(before)
  expect(fs.existsSync(files[0])).toBe(true)
  workers[0].exit()
  expect((await pending).message).toContain('timed out')
  expect(fs.existsSync(files[0])).toBe(false);expect(fs.readFileSync(store.filename,'utf8')).toBe(before)
  workers[0].emit('message',{ok:true,sections:[chapter]})
  const next=service.ingest(fixture)
  workers[1].emit('message',{ok:true,sections:[chapter]})
  expect(workers[1].terminate).toHaveBeenCalledOnce()
  workers[1].exit()
  const book=await next
  expect(service.answer(book.id,'moonstone').passages[0].reference).toBe('Chapter 1')
  expect(service.list()).toHaveLength(2);expect(vi.getTimerCount()).toBe(0)
 })
 it('does not release the guard after a termination error until the worker actually exits',async()=>{
  const {store,before}=await seed();vi.useFakeTimers()
  const worker=new ControlledWorker();worker.terminate.mockRejectedValue(new Error('stop failure'))
  const service=new LibraryService(new LocalLibraryIndex(store.filename),bytes=>extractEpubSections(bytes,{timeoutMs:10,createWorker:()=>worker}))
  let finished=false
  const pending=service.ingest(fixture).catch(error=>{finished=true;return error})
  await vi.advanceTimersByTimeAsync(11)
  expect(finished).toBe(false);await expect(service.ingest(fixture)).rejects.toThrow('already running')
  worker.exit();expect((await pending).message).toContain('termination failed')
  expect(fs.readFileSync(store.filename,'utf8')).toBe(before)
 })
 it('terminates a real non-returning worker before rejecting and subsequently extracts a real EPUB',async()=>{
  const {store,before}=await seed();let count=0,stopped=false
  const service=new LibraryService(new LocalLibraryIndex(store.filename),bytes=>extractEpubSections(bytes,{timeoutMs:count===0?50:5000,createWorker:(code,options)=>{
   const worker=new Worker(count++===0?'while(true){}':code,options)
   worker.once('exit',()=>{stopped=true});return worker
  }}))
  await expect(service.ingest(fixture)).rejects.toThrow('timed out')
  expect(stopped).toBe(true);expect(fs.readFileSync(store.filename,'utf8')).toBe(before)
  const book=await service.ingest(fixture)
  expect(service.answer(book.id,'moonstone').passages[0].reference).toBe('Chapter 1')
 })
 it('waits for exit after parser errors and leaves the index unchanged',async()=>{
  const {store,before}=await seed(),worker=new ControlledWorker()
  const service=new LibraryService(new LocalLibraryIndex(store.filename),bytes=>extractEpubSections(bytes,{createWorker:()=>worker}))
  const pending=service.ingest(fixture).catch(error=>error)
  worker.emit('error',new Error('private parser details'))
  worker.emit('message',{ok:true,sections:[chapter]})
  worker.exit()
  expect((await pending).message).toBe('EPUB extraction worker failed. No index was changed.')
  expect(fs.readFileSync(store.filename,'utf8')).toBe(before)
 })
})
