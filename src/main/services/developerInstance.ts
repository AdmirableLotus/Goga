import { DeveloperService } from './developer'

/**
 * The one DeveloperService instance.
 *
 * Both the Developer page (through its IPC handlers) and the `developer.start` tool resolve to
 * this, so a run started from chat is the same run the page is showing — one child process,
 * one event stream, one Stop button. Two instances would mean a page that shows nothing while
 * a Codex process edits source behind it.
 */

let service: DeveloperService | undefined

export function developerService(publish?: (state: import('../../shared/developer').DeveloperState) => void): DeveloperService {
  if (!service) service = new DeveloperService(publish ?? (() => {}))
  return service
}

/** For the page's "Use Goga source" on boot, so the service detects the engine once. */
export function hasDeveloperService(): boolean { return !!service }
