// @vitest-environment jsdom
import React from 'react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import DeveloperPage from '../DeveloperPage'
const file='src/renderer/pages/LibraryPage.tsx'
const inspection={id:'inspection-main',file,functionName:'formatBytes',baseCommit:'base-sha',sourceHash:'source-sha',startLine:7,endLine:11,
  functionText:'function formatBytes(b: number) {}',numberedSource:'7: function formatBytes(b: number) {}',explanation:'Formats bytes.',references:[{startLine:7,endLine:7,quote:'function formatBytes(b: number) {}'}],uncertainty:'Only one function was read.'}
const validation={passed:true,syntaxPassed:true,kind:'pure-helper-interpreter',durationMs:3,policyHash:'policy',limitation:'No candidate JS executed.',cases:[{name:'negative',expected:'0 B',actual:'0 B',passed:true}]}
const proposal={id:'proposal-main',file,baseCommit:'base-sha',patchHash:'patch-sha',candidateHash:'candidate-sha',validationHash:'validation-sha',manifestHash:'manifest-sha',candidateDirectory:'isolated/candidate',diff:'COMPLETE DIFF <script>untrusted</script>',explanation:'Adds an invalid-size guard.',references:inspection.references,uncertainty:'No full app tests.',baseline:{...validation,passed:false},validation,reviewable:true}
let invoke:ReturnType<typeof vi.fn>
beforeEach(()=>{invoke=vi.fn(async(channel:string)=>channel==='developer:files'?[file]:channel==='developer:inspect'?inspection:channel==='developer:propose'||channel==='developer:review'?proposal:undefined);Object.assign(window,{goga:{invoke}})})
afterEach(()=>{cleanup();vi.restoreAllMocks()})
it('asks Goga to inspect before proposing and displays actual review data with no apply action',async()=>{
  render(<DeveloperPage/>);fireEvent.click(screen.getByText('Ask Goga to explain'))
  await screen.findByText('Formats bytes.');expect(invoke).toHaveBeenCalledWith('developer:inspect',file,'formatBytes')
  expect(screen.getByText(/exact quotation verified/).textContent).toContain(':7–7')
  fireEvent.change(screen.getByLabelText('Describe one small change'),{target:{value:'Return 0 B for invalid sizes.'}})
  fireEvent.click(screen.getByText('Ask Goga to prepare isolated patch'))
  await screen.findByText('Ready to review');expect(invoke).toHaveBeenCalledWith('developer:propose','inspection-main','Return 0 B for invalid sizes.')
  expect(screen.getByText('COMPLETE DIFF <script>untrusted</script>')).toBeTruthy();expect(document.querySelector('script')).toBeNull()
  expect(screen.getByText('patch-sha')).toBeTruthy();expect(screen.getByText('manifest-sha')).toBeTruthy()
  expect(screen.queryByRole('button',{name:/apply|activate/i})).toBeNull()
  fireEvent.click(screen.getByText('Verify proposal hashes again'))
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('developer:review','proposal-main'))
})

it('requests main-owned confirmation for the displayed manifest and shows a review-only receipt',async()=>{
  const receipt={id:'receipt-id',proposalId:proposal.id,manifestHash:proposal.manifestHash,scope:'proposal-review-only'}
  invoke.mockImplementation(async(channel:string)=>channel==='developer:files'?[file]:channel==='developer:inspect'?inspection:channel==='developer:request-review-approval'?receipt:proposal)
  render(<DeveloperPage/>);fireEvent.click(screen.getByText('Ask Goga to explain'));await screen.findByText('Formats bytes.')
  fireEvent.change(screen.getByLabelText('Describe one small change'),{target:{value:'Guard invalid sizes'}})
  fireEvent.click(screen.getByText('Ask Goga to prepare isolated patch'));await screen.findByText('Ready to review')
  expect(invoke).not.toHaveBeenCalledWith('developer:request-review-approval',proposal.id,proposal.manifestHash)
  fireEvent.click(screen.getByText('Record review approval…'));await screen.findByText('receipt-id')
  expect(invoke).toHaveBeenCalledWith('developer:request-review-approval',proposal.id,proposal.manifestHash)
  expect(screen.getByText(/This receipt cannot activate an update/)).toBeTruthy()
  invoke.mockImplementation(async(channel:string)=>{if(channel==='developer:review')throw Error('Proposal bytes changed');return undefined})
  fireEvent.click(screen.getByText('Verify proposal hashes again'))
  await screen.findByText('Proposal bytes changed')
  expect(screen.queryByText('receipt-id')).toBeNull()
  expect(screen.getByText(/Any prior review receipt is historical only/)).toBeTruthy()
})

it('does not display a late approval receipt after Stop',async()=>{
  let finish!:(value:any)=>void
  invoke.mockImplementation(async(channel:string)=>channel==='developer:files'?[file]:channel==='developer:inspect'?inspection:channel==='developer:request-review-approval'?new Promise(resolve=>{finish=resolve}):proposal)
  render(<DeveloperPage/>);fireEvent.click(screen.getByText('Ask Goga to explain'));await screen.findByText('Formats bytes.')
  fireEvent.change(screen.getByLabelText('Describe one small change'),{target:{value:'Guard invalid sizes'}})
  fireEvent.click(screen.getByText('Ask Goga to prepare isolated patch'));await screen.findByText('Ready to review')
  fireEvent.click(screen.getByText('Record review approval…'));fireEvent.click(screen.getByText('Stop developer request'))
  finish({id:'late-receipt'});await waitFor(()=>expect(screen.queryByRole('status')).toBeNull())
  expect(screen.queryByText('late-receipt')).toBeNull()
  expect(screen.queryByText('Ready to review')).toBeNull()
})
it('discards a late explanation after Stop rather than offering a patch action',async()=>{
  let finish!:(v:any)=>void
  invoke.mockImplementation(async(channel:string)=>channel==='developer:files'?[file]:channel==='developer:inspect'?new Promise(resolve=>{finish=resolve}):undefined)
  render(<DeveloperPage/>);fireEvent.click(screen.getByText('Ask Goga to explain'));fireEvent.click(screen.getByText('Stop developer request'));finish(inspection)
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith('developer:stop'))
  expect(screen.queryByText('Formats bytes.')).toBeNull();expect(screen.queryByText('Ask Goga to prepare isolated patch')).toBeNull()
})

it('sends the user correction to the existing explanation route',async()=>{
  render(<DeveloperPage/>);fireEvent.change(screen.getByLabelText('Correction or follow-up (optional)'),{target:{value:'Only KB and MB use one decimal.'}})
  fireEvent.click(screen.getByText('Ask Goga to explain'))
  await screen.findByText('Formats bytes.')
  expect(invoke).toHaveBeenCalledWith('developer:inspect',file,'formatBytes','Only KB and MB use one decimal.')
})
