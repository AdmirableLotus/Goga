import { app } from 'electron'
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
  ipcMain.handle('developer:stop',async()=>stopDeveloper())
  // Deliberately no apply, approval, merge, install, or activation endpoint.
}
