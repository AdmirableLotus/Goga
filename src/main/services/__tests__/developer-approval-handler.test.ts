import {beforeEach,expect,it,vi} from 'vitest'

const mocks=vi.hoisted(()=>({window:{},showMessageBox:vi.fn(),fromWebContents:vi.fn(),request:vi.fn()}))
vi.mock('electron',()=>({app:{getAppPath:()=>'/isolated/repo',getPath:()=>'/isolated/profile'},
  BrowserWindow:{fromWebContents:mocks.fromWebContents},dialog:{showMessageBox:mocks.showMessageBox}}))
vi.mock('../developerRepository',()=>({DeveloperRepository:class {}}))
vi.mock('../localLlama',()=>({LocalLlamaService:{getInstance:()=>({})}}))
vi.mock('../developerProposals',()=>({DeveloperProposalService:class {requestReviewApproval=mocks.request}}))
import {registerDeveloperHandlers} from '../../handlers/developer'

const proposal={file:'src/renderer/pages/LibraryPage.tsx',baseCommit:'base',patchHash:'patch',candidateHash:'candidate',validationHash:'validation',manifestHash:'manifest'}
let handlers:Map<string,Function>,event:any
beforeEach(()=>{
  vi.resetAllMocks();handlers=new Map()
  registerDeveloperHandlers({handle:(name:string,handler:Function)=>handlers.set(name,handler)} as any)
  const mainFrame={};event={sender:{mainFrame},senderFrame:mainFrame}
  mocks.fromWebContents.mockReturnValue(mocks.window)
  mocks.request.mockImplementation(async(_id,_hash,confirm)=>confirm(proposal))
})
it('uses an application-owned dialog with cancel as default and binds all revision hashes',async()=>{
  mocks.showMessageBox.mockResolvedValue({response:1})
  expect(await handlers.get('developer:request-review-approval')!(event,'proposal','manifest')).toBe(true)
  expect(mocks.request).toHaveBeenCalledWith('proposal','manifest',expect.any(Function))
  const [parent,options]=mocks.showMessageBox.mock.calls[0]
  expect(parent).toBe(mocks.window)
  expect(options).toMatchObject({defaultId:0,cancelId:0,buttons:['Cancel','Record review approval']})
  for(const hash of ['base','patch','candidate','validation','manifest'])expect(options.detail).toContain(hash)
  expect(options.detail).toContain('not full JavaScript or application testing')
  expect(options.detail).toContain('does not authorize')
  expect([...handlers.keys()].some(k=>/apply|activate|install/.test(k))).toBe(false)
})
it('closing or canceling the dialog is not approval',async()=>{
  mocks.showMessageBox.mockResolvedValue({response:0})
  expect(await handlers.get('developer:request-review-approval')!(event,'proposal','manifest')).toBe(false)
})
it.each(['subframe','missing-window'])('rejects confirmation requests from %s',async kind=>{
  if(kind==='subframe')event.senderFrame={}
  else mocks.fromWebContents.mockReturnValue(null)
  await expect(handlers.get('developer:request-review-approval')!(event,'proposal','manifest')).rejects.toThrow('application window')
  expect(mocks.request).not.toHaveBeenCalled();expect(mocks.showMessageBox).not.toHaveBeenCalled()
})
