import { app, BrowserWindow, dialog } from 'electron'
import type { IpcMain } from 'electron'
import path from 'path'
import { DeveloperRepository } from '../services/developerRepository'
import { DeveloperProposalService } from '../services/developerProposals'
import { LocalLlamaService } from '../services/localLlama'

let service:DeveloperProposalService | undefined
function developer(){
  if(!service)service=new DeveloperProposalService(new DeveloperRepository(app.getAppPath(),path.join(app.getPath('userData'),'developer-proposals')),LocalLlamaService.getInstance())
  return service
}
export function stopDeveloper(){service?.stop()}
export function registerDeveloperHandlers(ipcMain:IpcMain){
  ipcMain.handle('developer:files',async()=>developer().repository.files())
  ipcMain.handle('developer:inspect',async(_e,file:string,fn:string,feedback?:string)=>developer().inspect(file,fn,feedback))
  ipcMain.handle('developer:propose',async(_e,id:string,request:string)=>developer().propose(id,request))
  ipcMain.handle('developer:review',async(_e,id:string)=>developer().review(id))
  ipcMain.handle('developer:request-review-approval',async(event,id:string,manifestHash:string)=>{
    const window=BrowserWindow.fromWebContents(event.sender)
    if(!window||event.senderFrame!==event.sender.mainFrame)throw Error('Review approval requires the application window.')
    return developer().requestReviewApproval(id,manifestHash,async proposal=>{
      const result=await dialog.showMessageBox(window,{
        type:'question',title:'Approve this reviewed proposal?',
        message:'Record approval of this exact proposal for review only?',
        detail:`File: ${proposal.file}\nBase: ${proposal.baseCommit}\nPatch SHA-256: ${proposal.patchHash}\nCandidate SHA-256: ${proposal.candidateHash}\nValidation SHA-256: ${proposal.validationHash}\nManifest SHA-256: ${proposal.manifestHash}\n\nValidation is restricted pure-function testing, not full JavaScript or application testing. This records your review decision only. It does not authorize or perform apply, installation, restart, merge or activation.`,
        buttons:['Cancel','Record review approval'],defaultId:0,cancelId:0,noLink:true
      })
      return result.response===1
    })
  })
  ipcMain.handle('developer:stop',async()=>stopDeveloper())
  // Deliberately no apply, merge, install, restart or activation endpoint.
}
