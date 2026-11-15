import type { IpcMain } from 'electron'
import type { VirtualisationProvider } from '../../shared/setup'
import { readCatalogue } from '../services/setup/catalogue'
import { decideInstall, listProposals, proposeInstall, runInstall } from '../services/setup/install'
import { detectVirtualisation } from '../services/setup/virtualisation'
import { createVm, decideVm, defaultResources, listVmProposals, proposeVm, VM_IMAGES } from '../services/setup/vm'
import { auditSetup, readSetupAudit } from '../services/setup/store'

/**
 * IPC for the Setup page: the installed-tool catalogue, install proposals, the virtualisation
 * report and VM proposals.
 *
 * Everything runs in main. The renderer can read, propose and approve; it cannot reach a
 * PowerShell process, and it cannot run an install without the single-use gate holding a
 * matching approval.
 */

export function registerSetupHandlers(ipcMain: IpcMain) {
  ipcMain.handle('setup:catalogue', async () => readCatalogue())
  ipcMain.handle('setup:virtualisation', async () => detectVirtualisation())
  ipcMain.handle('setup:state', async () => ({
    catalogue: await readCatalogue(),
    virtualisation: await detectVirtualisation(),
    proposals: listProposals(),
    vmProposals: listVmProposals(),
    audit: readSetupAudit(200),
  }))
  ipcMain.handle('setup:audit', async (_e, limit?: number) => readSetupAudit(Number(limit) || 200))

  ipcMain.handle('setup:proposeInstall', async (_e, input: {
    package: string
    task: string
    why?: string
    withoutIt?: string
    vendorUrl?: string
    version?: string
  }) => {
    const catalogue = await readCatalogue()
    return proposeInstall({
      package: String(input?.package ?? ''),
      task: String(input?.task ?? ''),
      why: input?.why ? String(input.why) : undefined,
      withoutIt: input?.withoutIt ? String(input.withoutIt) : undefined,
      vendorUrl: input?.vendorUrl ? String(input.vendorUrl) : undefined,
      version: input?.version ? String(input.version) : undefined,
    }, catalogue)
  })
  ipcMain.handle('setup:decideInstall', async (_e, proposalId: string, approved: boolean) =>
    decideInstall(String(proposalId), approved === true))
  ipcMain.handle('setup:runInstall', async (_e, proposalId: string) => runInstall(String(proposalId)))

  ipcMain.handle('setup:vmImages', async () => Object.entries(VM_IMAGES).map(([key, v]) => ({ key, ...v })))
  ipcMain.handle('setup:vmDefaults', async () => defaultResources(await detectVirtualisation()))
  ipcMain.handle('setup:proposeVm', async (_e, input: {
    purpose: string
    usedFor: string
    name?: string
    image?: string
    provider?: VirtualisationProvider
    cpuCores?: number
    memoryGb?: number
    diskGb?: number
  }) => {
    const report = await detectVirtualisation()
    return proposeVm({
      purpose: String(input?.purpose ?? ''),
      usedFor: String(input?.usedFor ?? ''),
      name: input?.name ? String(input.name) : undefined,
      image: input?.image ? String(input.image) : undefined,
      provider: input?.provider,
      resources: {
        cpuCores: input?.cpuCores ? Number(input.cpuCores) : undefined,
        memoryGb: input?.memoryGb ? Number(input.memoryGb) : undefined,
        diskGb: input?.diskGb ? Number(input.diskGb) : undefined,
      },
    }, report)
  })
  ipcMain.handle('setup:decideVm', async (_e, proposalId: string, approved: boolean) =>
    decideVm(String(proposalId), approved === true))
  ipcMain.handle('setup:createVm', async (_e, proposalId: string) => createVm(String(proposalId)))

  // Enabling a Windows feature is never a step Goga takes. This records the refusal, so the
  // page can say plainly that it needs a restart and the user's decision.
  ipcMain.handle('setup:explainFeatureEnable', async (_e, feature: string) => {
    const name = String(feature ?? '').trim() || 'that Windows feature'
    auditSetup('vm-refusal', `the user asked about enabling ${name}; Goga did not enable it — it needs a restart and the user's own decision`)
    return {
      ok: false,
      message: [
        `Goga will not enable ${name}.`,
        '',
        'Turning a Windows feature on needs administrator rights and a restart, and on a Windows Home edition it needs an edition upgrade first. '
        + 'That is your decision, not a step Goga takes quietly.',
        '',
        `If you want it, do it yourself: press Start, type "Turn Windows features on or off", tick ${name}, and accept the restart. `
        + 'Or in an administrator terminal:',
        `  Enable-WindowsOptionalFeature -Online -FeatureName ${name} -All`,
        '',
        'Tell me when it is done and I will read the virtualisation report again.',
      ].join('\n'),
    }
  })
}
