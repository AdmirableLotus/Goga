import React, { useEffect, useRef, useState } from 'react'
import type { DeveloperApprovalReceipt, DeveloperInspection, DeveloperProposal, DeveloperValidation } from '@shared/types'

function Tests({ label, value }: { label:string; value:DeveloperValidation }) {
  return <section><h4>{label}: {value.passed?'passed':'not passing'}</h4>
    <p>{value.limitation}</p><p>Syntax allowlist: {value.syntaxPassed?'passed':'rejected'} · {value.durationMs} ms</p>
    <table><thead><tr><th>Case</th><th>Expected</th><th>Actual</th><th>Result</th></tr></thead>
      <tbody>{value.cases.map(row=><tr key={row.name}><td>{row.name}</td><td>{row.expected}</td><td>{row.actual}</td><td>{row.passed?'PASS':'FAIL'}</td></tr>)}</tbody></table>
  </section>
}
export default function DeveloperPage(){
  const [files,setFiles]=useState<string[]>([]),[file,setFile]=useState('src/renderer/pages/LibraryPage.tsx'),[fn,setFn]=useState('formatBytes')
  const [request,setRequest]=useState(''),[inspection,setInspection]=useState<DeveloperInspection|null>(null),[proposal,setProposal]=useState<DeveloperProposal|null>(null)
  const [feedback,setFeedback]=useState('')
  const [approval,setApproval]=useState<DeveloperApprovalReceipt|null>(null)
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('')
  const revision=useRef(0)
  useEffect(()=>{
    let alive=true
    window.goga.invoke('developer:files').then(v=>{if(alive)setFiles(v)}).catch(()=>{if(alive)setError('The running app must be a Git checkout to inspect its committed source.')})
    return()=>{alive=false;revision.current++;void window.goga.invoke('developer:stop').catch(()=>{})}
  },[])
  async function run(action:()=>Promise<void>){setBusy(true);setError('');try{await action()}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
  const inspect=()=>run(async()=>{
    const token=++revision.current;setInspection(null);setProposal(null);setApproval(null);setStatus('Reading committed source and asking the local model…')
    const value=feedback.trim()?await window.goga.invoke('developer:inspect',file,fn,feedback):await window.goga.invoke('developer:inspect',file,fn)
    if(token===revision.current){setInspection(value);setStatus('Explanation references verified against the committed source.')}
  })
  const prepare=()=>run(async()=>{
    if(!inspection)return
    const token=++revision.current;setProposal(null);setApproval(null);setStatus('Preparing an isolated patch and running bounded pure-function tests…')
    const value=await window.goga.invoke('developer:propose',inspection.id,request)
    if(token===revision.current){setProposal(value);setStatus(value.reviewable?'Proposal prepared for review. No update applied.':'Patch prepared, but validation is not passing. No update applied.')}
  })
  const stop=async()=>{revision.current++;setInspection(null);setProposal(null);setApproval(null);setStatus('Stop requested; the request guard stays held until work stops.');try{await window.goga.invoke('developer:stop')}catch{setError('Stop could not be requested.')}}
  const verify=()=>run(async()=>{
    if(!proposal)return
    try{await window.goga.invoke('developer:review',proposal.id)}
    catch(error){setApproval(null);setStatus('Proposal verification failed. Any prior review receipt is historical only; review a fresh proposal.');throw error}
    setStatus('Candidate, complete patch, manifest, and base hashes verified again. Still proposal-only.')
  })
  const approve=()=>run(async()=>{
    if(!proposal)return
    const token=revision.current;setApproval(null)
    const receipt=await window.goga.invoke('developer:request-review-approval',proposal.id,proposal.manifestHash)
    if(token===revision.current){setApproval(receipt);setStatus(receipt?'Review approval recorded for this exact proposal. No update authorized or applied.':'Review approval canceled.')}
  })
  const changed=()=>{setInspection(null);setProposal(null);setApproval(null);setStatus('')}
  return <div style={{padding:24,overflowY:'auto',flex:1}}>
    <h2>Developer proposals</h2>
    <p>Goga can inspect committed source and prepare one isolated change for your review. You can record approval of the reviewed proposal. No apply, installation, merge, or activation action exists here.</p>
    <p>First editing profile: LibraryPage.formatBytes, returning 0 B for negative or non-finite sizes while preserving normal formatting. Other small top-level functions can be explained.</p>
    <label htmlFor="developer-file">Source file</label><input id="developer-file" list="developer-files" value={file} disabled={busy} onChange={e=>{setFile(e.target.value);changed()}} style={{display:'block',width:'100%'}}/>
    <datalist id="developer-files">{files.map(f=><option key={f} value={f}/>)}</datalist>
    <label htmlFor="developer-function">Function name</label><input id="developer-function" value={fn} disabled={busy} onChange={e=>{setFn(e.target.value);changed()}} style={{display:'block'}}/>
    <label htmlFor="developer-feedback">Correction or follow-up (optional)</label><textarea id="developer-feedback" value={feedback} maxLength={3000} disabled={busy} onChange={e=>setFeedback(e.target.value)} style={{display:'block',width:'100%'}}/>
    <button disabled={busy} onClick={inspect}>Ask Goga to explain</button>{' '}<button onClick={stop}>Stop developer request</button>
    {busy&&<p role="status">Developer request running…</p>}{error&&<p role="alert">{error}</p>}<p aria-live="polite">{status}</p>
    {inspection&&<section aria-label="Verified code explanation"><h3>Goga’s explanation</h3><p>{inspection.explanation}</p>
      <p>Source quotations are resolved by the application from the pinned revision. Verified references do not prove the explanation is correct.</p>
      <p>Base commit: <code>{inspection.baseCommit}</code></p><p>Source SHA-256: <code>{inspection.sourceHash}</code></p>
      {inspection.references?.map((r,i)=><blockquote key={i}><strong>{inspection.file}:{r.startLine}–{r.endLine} · exact quotation verified</strong><pre>{r.quote}</pre></blockquote>)}
      <p>Uncertainty: {inspection.uncertainty}</p><details><summary>Inspected function with line numbers</summary><pre>{inspection.numberedSource}</pre></details>
      <label htmlFor="developer-change">Describe one small change</label><textarea id="developer-change" value={request} maxLength={1000} disabled={busy} onChange={e=>setRequest(e.target.value)} style={{display:'block',width:'100%'}}/>
      <button disabled={busy||!request.trim()} onClick={prepare}>Ask Goga to prepare isolated patch</button>
    </section>}
    {proposal&&<section aria-label="Developer patch review"><h3>{proposal.reviewable?'Ready to review':'Validation incomplete or failed'}</h3>
      <p>{proposal.explanation}</p><p>Remaining uncertainty: {proposal.uncertainty}</p>
      <p>Base commit: <code>{proposal.baseCommit}</code></p><p>Patch SHA-256: <code>{proposal.patchHash}</code></p>
      <p>Candidate file SHA-256: <code>{proposal.candidateHash}</code></p><p>Validation SHA-256: <code>{proposal.validationHash}</code></p><p>Manifest SHA-256: <code>{proposal.manifestHash}</code></p>
      <p>Isolated checkout: <code>{proposal.candidateDirectory}</code></p>
      <Tests label="Original function on the requested behavior" value={proposal.baseline}/><Tests label="Candidate validation" value={proposal.validation}/>
      <h4>Complete diff</h4><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{proposal.diff}</pre>
      <button disabled={busy} onClick={verify}>Verify proposal hashes again</button>
      <button disabled={busy||!proposal.reviewable||!!approval} onClick={approve}>Record review approval…</button>
      {approval&&<p>Historical review approval receipt: <code>{approval.id}</code>. Scope: proposal review only. This receipt cannot activate an update. Changes to the candidate require a fresh review.</p>}
      <p>Full application and integration validation remain unrun. Everyday Goga has not been changed. Applying or activating an update is unavailable and would require separate approval.</p>
    </section>}
  </div>
}
