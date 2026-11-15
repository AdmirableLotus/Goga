import type { IpcMain } from 'electron'
import { jobs, stopJobs } from '../services/jobs/instance'
import { SettingsService } from '../services/settings'

/**
 * Job IPC.
 *
 * Every handler here is a control surface for work the user started: create, answer, cancel,
 * resume, change the cap. None of them can run a tool directly — a job only acts through the
 * manager's gate, which asks the user before anything guarded runs.
 */
export function registerJobsHandlers(ipcMain: IpcMain) {
  ipcMain.handle('jobs:state', async () => jobs().view())
  ipcMain.handle('jobs:create', async (_e, input: { goal: string; title?: string; maxSteps?: number; maxMinutes?: number }) => {
    const job = jobs().create({
      goal: String(input?.goal ?? ''),
      title: input?.title,
      bounds: {
        ...(typeof input?.maxSteps === 'number' ? { maxSteps: Math.max(1, Math.min(60, input.maxSteps)) } : {}),
        ...(typeof input?.maxMinutes === 'number' ? { maxMinutes: Math.max(1, Math.min(600, input.maxMinutes)) } : {}),
      },
    })
    return { job, view: jobs().view() }
  })
  ipcMain.handle('jobs:answer', async (_e, jobId: string, answer: string) => {
    jobs().answer(String(jobId), String(answer))
    return jobs().view()
  })
  ipcMain.handle('jobs:cancel', async (_e, jobId: string) => {
    jobs().cancel(String(jobId))
    return jobs().view()
  })
  ipcMain.handle('jobs:resume', async (_e, jobId: string) => {
    jobs().resume(String(jobId))
    return jobs().view()
  })
  ipcMain.handle('jobs:setCap', async (_e, cap: number) => {
    SettingsService.getInstance().set({ jobConcurrency: Math.max(1, Math.min(6, Math.floor(Number(cap)))) } as never)
    return jobs().setCap(Number(cap))
  })
  ipcMain.handle('jobs:shutdown', async () => { stopJobs() })
}
