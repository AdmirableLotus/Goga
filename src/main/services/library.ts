import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { TextDecoder } from 'util'
import type { BookMeta, BookChunk, BookLocation, LibraryAnswer } from '../../shared/types'
import { nanoid } from '../utils/nanoid'

const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_INDEX_BYTES = 32 * 1024 * 1024
const MAX_TEXT = 2_000_000
const MAX_BOOKS = 10
const CHUNK_SIZE = 800
const STEP = 700
interface Section { text: string; location: BookLocation }
interface Index { version: 1; books: BookMeta[]; chunks: BookChunk[] }
export interface LibraryPersistence { load(): unknown; save(index: Index): void }

/** One atomic snapshot: disk succeeds before in-memory state changes. */
export class LocalLibraryIndex implements LibraryPersistence {
  constructor(readonly filename: string) {}
  load(): unknown {
    if (!fs.existsSync(this.filename)) return {version:1,books:[],chunks:[]}
    if (fs.statSync(this.filename).size > MAX_INDEX_BYTES) throw new Error('Library index exceeds the 32 MB limit. Existing index was preserved.')
    try { return JSON.parse(fs.readFileSync(this.filename,'utf8')) }
    catch { throw new Error('Library index could not be read. Existing index was preserved; restore a backup before importing.') }
  }
  save(index: Index) {
    const text=JSON.stringify(index)
    if (Buffer.byteLength(text)>MAX_INDEX_BYTES) throw new Error('Library index exceeds the 32 MB limit.')
    fs.mkdirSync(path.dirname(this.filename),{recursive:true})
    const temporary=this.filename+'.'+nanoid()+'.tmp'
    try {
      const fd=fs.openSync(temporary,'wx',0o600)
      try {fs.writeFileSync(fd,text,'utf8');fs.fsyncSync(fd)} finally {fs.closeSync(fd)}
      fs.renameSync(temporary,this.filename)
    } finally { if(fs.existsSync(temporary))fs.unlinkSync(temporary) }
  }
}

function validIndex(value: unknown): value is Index {
  const i=value as Index
  if (!i || i.version!==1 || !Array.isArray(i.books) || !Array.isArray(i.chunks) || i.books.length>MAX_BOOKS || i.chunks.length>30_000) return false
  const ids=new Set<string>()
  for(const b of i.books){
    if(!b || typeof b.id!=='string' || ids.has(b.id) || typeof b.filename!=='string' || typeof b.title!=='string'
      || !['pdf','txt','epub'].includes(b.format) || !Number.isSafeInteger(b.chunkCount) || b.chunkCount<1
      || !Number.isFinite(b.ingestedAt) || !Number.isFinite(b.sizeBytes))return false
    ids.add(b.id)
  }
  for(const c of i.chunks){
    const l=c?.location
    if(!c || !ids.has(c.bookId) || !Number.isSafeInteger(c.chunkIndex) || c.chunkIndex<0 || typeof c.text!=='string'
      || c.text.length>CHUNK_SIZE || !l || !['page','lines','chapter'].includes(l.kind) || !Number.isSafeInteger(l.start) || l.start<1
      || (l.end!==undefined && (!Number.isSafeInteger(l.end)||l.end<l.start)))return false
  }
  return i.books.every(b=>i.chunks.filter(c=>c.bookId===b.id).length===b.chunkCount)
}

function queryTerms(query:string):string[]{
  const stop=new Set(['what','does','this','that','about','book','with','from','which','the','and','how','are','for','say','says','explain','describe','please','guide','according'])
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[])].filter(t=>t.length>2&&!stop.has(t))
}

export class LibraryService {
  private static instance: LibraryService
  private index: Index = {version:1,books:[],chunks:[]}
  private loadFailure?: string
  private importing=false
  static getInstance() {
    if(!this.instance){
      const {app}=require('electron')
      this.instance=new LibraryService(new LocalLibraryIndex(path.join(app.getPath('userData'),'library-index.json')))
    }
    return this.instance
  }
  constructor(private persistence: LibraryPersistence) {
    try {
      const index=persistence.load()
      if(!validIndex(index))throw new Error('Unsupported or damaged library index. Existing index was preserved.')
      this.index=index
    } catch { this.loadFailure='Library index is unreadable or unsupported. Existing index was preserved; restore a backup before importing.' }
  }
  private ready(){if(this.loadFailure)throw new Error(this.loadFailure)}
  private commit(index: Index) {
    this.ready()
    if(!validIndex(index))throw new Error('Extracted index has invalid source references. Existing books were preserved.')
    try {this.persistence.save(index)} catch {throw new Error('Library index could not be saved. Existing books were preserved.')}
    this.index=index
  }
  async ingest(filePath: string): Promise<BookMeta> {
    this.ready()
    if(typeof filePath!=='string' || !filePath)throw new Error('Select a local book file.')
    const format=path.extname(filePath).toLowerCase().slice(1) as BookMeta['format']
    if(!['pdf','txt','epub'].includes(format))throw new Error(`Unsupported format: ${format || '(none)'}. Use PDF, UTF-8 TXT, or EPUB.`)
    if(this.importing)throw new Error('A library import is already running. Wait for it to finish.')
    this.importing=true
    try {
      let bytes: Buffer
      try {
        const stat=fs.statSync(filePath)
        if(!stat.isFile())throw Error('not a file')
        if(stat.size>MAX_FILE_BYTES)throw new Error('size limit')
        bytes=fs.readFileSync(filePath)
      }catch(error){
        if(error instanceof Error && error.message==='size limit')throw new Error('Book exceeds the 25 MB import limit.')
        throw new Error('Book file could not be read. Check its path and permissions.')
      }
      if(bytes.length>MAX_FILE_BYTES)throw new Error('Book exceeds the 25 MB import limit.')
      const contentHash=createHash('sha256').update(bytes).digest('hex')
      const existing=this.index.books.find(b=>b.contentHash===contentHash)
      if(existing)return {...existing}
      if(this.index.books.length>=MAX_BOOKS)throw new Error('This milestone supports up to 10 books. Remove one before importing another.')
      const sections=await this.extract(filePath,format,bytes)
      if(sections.reduce((n,s)=>n+s.text.length,0)>MAX_TEXT)throw new Error('Extracted text exceeds the 2 million character limit; split the book before importing.')
      const id=nanoid(),chunks:BookChunk[]=[]
      for(const section of sections){
        if(section.location.kind==='lines'){
          const lines=section.text.split(/\r?\n/)
          let group='',start=1
          for(let n=0;n<lines.length;n++){
            if(group && group.length+lines[n].length>CHUNK_SIZE){this.chunk(group,id,{kind:'lines',start,end:n},chunks);group='';start=n+1}
            group+=(group?'\n':'')+lines[n]
          }
          if(group.trim())this.chunk(group,id,{kind:'lines',start,end:lines.length},chunks)
        }else this.chunk(section.text,id,section.location,chunks)
      }
      if(!chunks.length)throw new Error('No extractable text found. Scanned PDFs need OCR; unsupported EPUB layouts or empty text files cannot be indexed in this milestone.')
      const meta:BookMeta={id,title:path.basename(filePath,path.extname(filePath)),filename:path.basename(filePath),format,
        contentHash,chunkCount:chunks.length,ingestedAt:Date.now(),sizeBytes:bytes.length}
      this.commit({version:1,books:[...this.index.books,meta],chunks:[...this.index.chunks,...chunks]})
      return {...meta}
    }finally{this.importing=false}
  }
  private chunk(text:string,bookId:string,location:BookLocation,chunks:BookChunk[]){
    const clean=text.replace(/\s+/g,' ').trim()
    for(let n=0;n<clean.length;n+=STEP)chunks.push({bookId,chunkIndex:chunks.length,text:clean.slice(n,n+CHUNK_SIZE),location:{...location}})
  }
  private async extract(filePath:string,format:BookMeta['format'],bytes:Buffer):Promise<Section[]>{
    if(format==='txt'){
      let text:string
      try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw new Error('TXT extraction failed: save the book as UTF-8 text.')}
      if(text.includes('\0'))throw new Error('TXT extraction failed: binary or unsupported text encoding.')
      return [{text,location:{kind:'lines',start:1}}]
    }
    if(format==='pdf'){
      const {PDFParse}=require('pdf-parse')
      const pdf=new PDFParse({data:new Uint8Array(bytes),verbosity:0})
      let timer:ReturnType<typeof setTimeout>|undefined
      try{
        const result:any=await Promise.race([pdf.getText(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),30_000)})])
        if(!Array.isArray(result.pages))throw Error('pages missing')
        return result.pages.map((p:any)=>({text:p.text,location:{kind:'page',start:p.num}}))
      }catch{throw new Error('PDF extraction failed: invalid, encrypted, unsupported, or timed-out PDF. No index was changed.')}
      finally{if(timer)clearTimeout(timer);await pdf.destroy().catch(()=>{})}
    }
    // Reuse epub2, preserve chapter boundaries; EPUB does not have stable physical pages.
    try{
      const {EPub}=require('epub2')
      return await new Promise<Section[]>((resolve,reject)=>{
        const epub=new EPub(filePath)
        const timer=setTimeout(()=>reject(Error('EPUB extraction timed out. No index was changed.')),30_000)
        epub.once('error',()=>{clearTimeout(timer);reject(Error('EPUB extraction failed. No index was changed.'))})
        epub.once('end',async()=>{
          try{
            const sections:Section[]=[]
            for(let n=0;n<epub.flow.length;n++){
              const chapter=epub.flow[n]
              const html:string=await new Promise((res,rej)=>epub.getChapter(chapter.id,(err:Error,text:string)=>err?rej(err):res(text)))
              sections.push({text:html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&'),location:{kind:'chapter',start:n+1}})
              if(sections.reduce((sum,s)=>sum+s.text.length,0)>MAX_TEXT)throw Error('size')
            }
            resolve(sections)
          }catch{reject(Error('EPUB chapter extraction failed or exceeded text limits. No index was changed.'))}
          finally{clearTimeout(timer)}
        })
        try{epub.parse()}catch{clearTimeout(timer);reject(Error('EPUB extraction failed. No index was changed.'))}
      })
    }catch{throw new Error('EPUB extraction failed: invalid, encrypted, unsupported, or timed-out EPUB. No index was changed.')}
  }
  search(query:string,topK=5,bookId?:string):BookChunk[]{
    this.ready()
    if(typeof query!=='string' || query.length>1000)throw new Error('Enter a library question of at most 1,000 characters.')
    if(!Number.isInteger(topK)||topK<1||topK>5)throw new Error('Library result count must be between 1 and 5.')
    if(bookId!==undefined && !this.index.books.some(b=>b.id===bookId))throw new Error('Book not found. Re-select an imported book.')
    const terms=queryTerms(query)
    if(!terms.length)return []
    const candidates=this.index.chunks.filter(c=>!bookId||c.bookId===bookId)
    const tokens:string[][]=candidates.map(c=>c.text.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[])
    const average=tokens.reduce((sum,t)=>sum+t.length,0)/Math.max(1,tokens.length)
    const counts=terms.map(term=>tokens.reduce((n,t)=>n+(t.includes(term)?1:0),0))
    // BM25: common words contribute less than distinctive terms; no network/embeddings.
    return candidates.map((chunk,n)=>{
      const words=tokens[n]
      const score=terms.reduce((sum,term,k)=>{
        const frequency=words.filter(w=>w===term).length
        const idf=Math.log(1+(candidates.length-counts[k]+0.5)/(counts[k]+0.5))
        return sum+idf*(frequency*2.2)/(frequency+1.2*(0.25+0.75*words.length/Math.max(1,average)))
      },0)
      return {chunk,score}
    }).filter(s=>s.score>0).sort((a,b)=>b.score-a.score||a.chunk.chunkIndex-b.chunk.chunkIndex).slice(0,topK).map(({chunk})=>({...chunk,location:chunk.location&&{...chunk.location}}))
  }
  answer(bookId:string,question:string):LibraryAnswer{
    if(typeof bookId!=='string' || !bookId)throw new Error('Select an imported book before asking a question.')
    const retrieved=this.search(question,3,bookId)
    const terms=queryTerms(question)
    const evidenceWords=new Set(retrieved.flatMap(c=>c.text.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[]))
    // Fail conservatively when topical words are unsupported, even if generic words match.
    const chunks=terms.length && terms.every(term=>evidenceWords.has(term)) ? retrieved : []
    const passages=chunks.map((c,n)=>{
      const book=this.index.books.find(b=>b.id===c.bookId)!,l=c.location!
      const reference=l.kind==='page'?`PDF page ${l.start}`:l.kind==='chapter'?`Chapter ${l.start}`:`Lines ${l.start}-${l.end ?? l.start}`
      return {id:`P${n+1}`,text:c.text,title:book.title,filename:book.filename,reference}
    })
    return {mode:'extractive',passages,answer:passages.length
      ? 'Relevant passages from the selected book (quoted evidence, not generated advice):\n\n'+passages.map(p=>`[${p.id}] ${p.filename}, ${p.reference}\n${p.text}`).join('\n\n')
      : 'No matching passages provide supporting evidence for that question. I do not have supporting evidence in the retrieved passages from this book. Try specific terms from the text; this does not prove the topic is absent.'}
  }
  list():BookMeta[]{this.ready();return this.index.books.map(b=>({...b}))}
  delete(bookId:string){
    if(typeof bookId!=='string')throw new Error('Invalid book ID.')
    this.commit({version:1,books:this.index.books.filter(b=>b.id!==bookId),chunks:this.index.chunks.filter(c=>c.bookId!==bookId)})
  }
  getBookTitle(bookId:string){return this.index.books.find(b=>b.id===bookId)?.title??bookId}
}
