import type { IpcMain } from 'electron'
import { breachKeyState, clearBreachKey, readOsintAudit, saveBreachKey } from '../services/osint/audit'
import { runOsint, type OsintKind } from '../services/osint/run'
import { EXCLUDED, SITES } from '../services/osint/sites'
import { activeProgram } from '../services/security/store'
import { ToolRegistry } from '../tools/registry'

/**
 * OSINT page bridge.
 *
 * The page itself is a thin client: every search goes through the same `runOsint` the agent
 * tools use, so the rate limit, the scope refusal, the purpose gate, the redaction and the
 * audit entry are all the same code. Nothing here accepts a host or a URL to contact — only
 * a username, an address, a domain or a confirmed identity.
 */

export function registerOsintHandlers(ipcMain: IpcMain) {
  ipcMain.handle('osint:state', async () => {
    const program = activeProgram()
    return {
      activeProgram: program ? { name: program.name, source: program.source, handle: program.handle } : null,
      breachKey: breachKeyState(),
      sites: SITES.map(s => ({ site: s.site, about: s.about })),
      excluded: EXCLUDED,
      recent: readOsintAudit(5),
    }
  })

  ipcMain.handle('osint:run', async (_e, kind: OsintKind, params: Record<string, unknown>) => {
    if (!['username', 'email', 'domain', 'profile'].includes(kind)) throw new Error('unknown OSINT search type')
    // Public mentions come from the same web search the rest of Goga uses.
    const reg = ToolRegistry.getInstance()
    const out = await runOsint(kind, params, {
      search: async (query, maxResults) => {
        const controller = new AbortController()
        const r = await reg.execute('web.search', { query, maxResults }, { abortSignal: controller.signal })
        if (!r.success) throw new Error(r.error || 'web search failed')
        return (r.data as { title: string; url: string; snippet: string }[]) ?? []
      },
    })
    return { data: out.data, text: out.text, audit: out.audit }
  })

  ipcMain.handle('osint:history', async (_e, limit?: number) => readOsintAudit(limit ?? 50))
  ipcMain.handle('osint:saveBreachKey', async (_e, key: string) => saveBreachKey(key))
  ipcMain.handle('osint:clearBreachKey', async () => clearBreachKey())
}
