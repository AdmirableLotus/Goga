import { app } from 'electron'
import { EvolutionLoop, evolutionRoot } from './loop'
import { OllamaClient } from '../ollamaClient'
import { SettingsService } from '../settings'
import { getMainWindow } from '../../index'
import { LogService } from '../logs'

/**
 * The single EvolutionLoop, wired to the local coding model. Constructed lazily so nothing
 * touches the model or the filesystem until something asks for it.
 */

let loop: EvolutionLoop | null = null

function coderModel(): string {
  return SettingsService.getInstance().get().coderModelName || 'qwen2.5-coder:14b'
}

export function evolution(): EvolutionLoop {
  if (loop) return loop
  const log = LogService.getInstance()
  const client = new OllamaClient()
  loop = new EvolutionLoop({
    projectRoot: app.getAppPath(),
    workRoot: evolutionRoot(),
    ask: async (system, user, signal) => client.chatJson(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      signal,
      coderModel(),
      { num_ctx: 16384, num_predict: 4096, temperature: 0.2 },
    ),
    askText: async (system, user, signal) => client.chatWith(
      coderModel(),
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      undefined,
      signal,
      { num_ctx: 16384, num_predict: 1200 },
    ),
    status: text => getMainWindow()?.webContents.send('evolution:status', text),
    publish: () => getMainWindow()?.webContents.send('evolution:update', evolution().state()),
  })
  log.info('Evolution loop ready')
  return loop
}
