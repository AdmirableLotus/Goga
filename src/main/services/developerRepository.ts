import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import ts from 'typescript'
import type { DeveloperInspection } from '../../shared/types'

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const forbidden = /(^|\/)(?:\.git|\.env[^/]*|node_modules|dist|\.local-diagnostics|profiles?|credentials?)(\/|$)|\.(?:pem|key|pfx)$/i
export function relativeSource(value: string): string {
  if (typeof value !== 'string' || !/^src\/[\w./-]+\.tsx?$/.test(value) || value.split('/').some(p => p === '..' || p === '.') || forbidden.test(value)) {
    throw Error('Choose a tracked TypeScript source file inside src/.')
  }
  return value
}
export function assertSafeText(source: string) {
  for (const [key, value] of Object.entries(process.env)) {
    if (/key|token|password|secret|credential/i.test(key) && value && value.length >= 8 && source.includes(value)) throw Error('This source may contain credentials and cannot be sent to the developer panel.')
  }
  if (/sk-[\w-]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN [\w ]*PRIVATE KEY|(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][^"'\r\n]{12,}["']/i.test(source)) {
    throw Error('This source may contain credentials and cannot be sent to the developer panel.')
  }
}
export class DeveloperRepository {
  readonly root: string
  constructor(root: string, readonly storage: string) {
    this.root = fs.realpathSync(root)
    fs.mkdirSync(storage, { recursive: true })
    fs.writeFileSync(path.join(storage, 'empty-git-config'), '')
  }
  git(args: string[], cwd = this.root, input?: Buffer, signal?: AbortSignal, maxBuffer = 2_000_000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(this.storage, 'empty-git-config'), GIT_TERMINAL_PROMPT: '0',
        GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' }
      const child = execFile('git', ['-c','core.hooksPath='+path.join(this.storage,'disabled-hooks'),'-c','core.fsmonitor=false',
        '-c','core.autocrlf=false',...args], { cwd, env, windowsHide:true, timeout:30_000, maxBuffer, encoding:'buffer', signal },
      (error, stdout) => error ? reject(Error(signal?.aborted ? 'Developer operation stopped.' : 'Bounded Git operation failed.')) : resolve(stdout))
      child.stdin?.on('error',()=>{})
      if (input) child.stdin?.end(input)
    })
  }
  async head(signal?: AbortSignal) { return (await this.git(['rev-parse','--verify','HEAD'],this.root,undefined,signal)).toString().trim() }
  async files() {
    const files=(await this.git(['ls-tree','-rz','--name-only','HEAD','--','src/'])).toString().split('\0').filter(Boolean)
    return files.filter(file => { try { relativeSource(file); return true } catch { return false } }).slice(0,300)
  }
  private safeWorkingFile(relative: string) {
    let current=this.root
    for(const part of relative.split('/')) {
      current=path.join(current,part)
      if(fs.lstatSync(current).isSymbolicLink())throw Error('Source links are not allowed.')
    }
    if(!fs.realpathSync(current).startsWith(this.root+path.sep))throw Error('Source escapes the selected repository.')
    return current
  }
  async inspect(file: string, functionName: string, signal?: AbortSignal): Promise<{ view: DeveloperInspection; source: string; start: number; end: number }> {
    relativeSource(file)
    if(!/^[A-Za-z_$][\w$]{0,79}$/.test(functionName))throw Error('Enter a top-level function name.')
    const base=await this.head(signal)
    const entry=(await this.git(['ls-tree',base,'--',file],this.root,undefined,signal)).toString()
    if(!/^100644 blob /.test(entry))throw Error('The selected file must be a regular committed source file.')
    const bytes=await this.git(['show',`${base}:${file}`],this.root,undefined,signal)
    if(bytes.length>100_000)throw Error('Source exceeds the 100 KB inspection limit.')
    const source=bytes.toString('utf8');assertSafeText(source)
    const working=this.safeWorkingFile(file)
    if(fs.readFileSync(working,'utf8').replace(/\r\n/g,'\n')!==source.replace(/\r\n/g,'\n'))throw Error('This file has uncommitted edits. Commit or choose an unchanged file; nothing was discarded.')
    const parsed=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS)
    const fn=parsed.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===functionName) as ts.FunctionDeclaration | undefined
    if(!fn?.body)throw Error('That top-level function was not found in the committed source.')
    const start=fn.getStart(parsed),end=fn.getEnd(),text=source.slice(start,end)
    if(text.length>7000 || text.split('\n').length>100)throw Error('Choose a function of at most 100 lines / 7,000 characters.')
    const startLine=parsed.getLineAndCharacterOfPosition(start).line+1,endLine=parsed.getLineAndCharacterOfPosition(end).line+1
    return {view:{id:'',baseCommit:base,file,functionName,startLine,endLine,sourceHash:sha256(bytes),functionText:text,
      numberedSource:text.split('\n').map((line,i)=>`${startLine+i}: ${line}`).join('\n')},source,start,end}
  }
  async candidate(base: string, directory: string, signal: AbortSignal) {
    signal.throwIfAborted()
    // No checkout filters, hooks or repository scripts: materialize regular blobs ourselves.
    const rows=(await this.git(['ls-tree','-rz','--full-tree',base],this.root,undefined,signal)).toString().split('\0').filter(Boolean)
    const entries=rows.map(row=>{const match=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row)
      if(!match)throw Error('Candidate contains unsupported links or submodules.')
      const file=match[3]
      if(file.split('/').some(part=>!part || part==='..'||part==='.'||/[\\:]/.test(part)) || forbidden.test(file))throw Error('Candidate contains a restricted path.')
      return {id:match[2],file}
    })
    if(entries.length>1000)throw Error('Candidate exceeds the 1,000-file limit.')
    const objects=await this.git(['cat-file','--batch'],this.root,Buffer.from(entries.map(e=>e.id+'\n').join('')),signal,128*1024*1024)
    if(objects.length>120*1024*1024)throw Error('Candidate exceeds the 120 MB limit.')
    await this.git(['worktree','add','--detach','--no-checkout',directory,base],this.root,undefined,signal)
    await this.git(['read-tree',base],directory,undefined,signal)
    let cursor=0
    for(const entry of entries){
      signal.throwIfAborted()
      const newline=objects.indexOf(10,cursor),header=objects.subarray(cursor,newline).toString()
      const match=/^([a-f0-9]{40}) blob (\d+)$/.exec(header)
      if(!match || match[1]!==entry.id)throw Error('Candidate blob verification failed.')
      const size=Number(match[2]),bytes=objects.subarray(newline+1,newline+1+size)
      const target=path.join(directory,...entry.file.split('/'))
      fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx'})
      cursor=newline+1+size+1
    }
  }
  async diff(directory: string, base: string) {
    if((await this.git(['rev-parse','HEAD'],directory)).toString().trim()!==base)throw Error('Candidate base changed.')
    if((await this.git(['ls-files','--others','--exclude-standard'],directory)).length)throw Error('Unexpected untracked candidate files.')
    return (await this.git(['diff','--no-ext-diff','--no-textconv','--binary',base,'--'],directory)).toString('utf8')
  }
}
