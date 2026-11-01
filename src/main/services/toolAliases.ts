import os from 'os'

/**
 * Tool names the planner invents for abilities Goga already has. His gap journal showed him
 * asking for "terminal", "computer.searchFiles", "navigate_to_url" and "computer.launch" —
 * real abilities under made-up names, so each task died on "unknown tool". The alias runs
 * the real tool with its inputs mapped; the approval check still runs on the real tool.
 */

export type AliasResult =
  | { tool: string; params: Record<string, unknown> }
  | { ask: string }

const first = (p: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const k of keys) if (typeof p[k] === 'string' && (p[k] as string).trim()) return (p[k] as string).trim()
  return undefined
}
const anyString = (p: Record<string, unknown>) => Object.values(p).find((v): v is string => typeof v === 'string' && v.trim().length > 0)

const ALIASES: { names: RegExp; map: (p: Record<string, unknown>) => AliasResult | null }[] = [
  {
    names: /^(terminal|shell|cmd|powershell|bash|run_?command|run_?shell|execute_?command|exec|command(\.run)?|computer\.(run|terminal|shell|command))$/i,
    map: p => { const command = first(p, ['command', 'cmd', 'script', 'input', 'code']) ?? anyString(p); return command ? { tool: 'shell.execute', params: { command } } : null },
  },
  {
    names: /^((computer|file|files|filesystem)\.)?(search_?files|find_?files|file_?search|findfiles|searchfiles|locate)$/i,
    map: p => {
      const raw = first(p, ['pattern', 'name', 'query', 'filename', 'text', 'searchText', 'search'])
      if (!raw) return null
      const pattern = /[*?]/.test(raw) ? raw : `*${raw}*`
      return { tool: 'filesystem.search', params: { path: first(p, ['path', 'folder', 'directory', 'dir', 'root', 'folderPath']) ?? os.homedir(), pattern } }
    },
  },
  {
    names: /^(navigate_?to_?url|open_?url|go_?to_?url|browser\.(goto|go|visit|openUrl)|web\.open|visit_?url|open_?website)$/i,
    map: p => { const url = first(p, ['url', 'link', 'address', 'href', 'site', 'website']) ?? anyString(p); return url ? { tool: 'browser.open', params: { url } } : null },
  },
  {
    names: /^(computer\.(launch|open|openApp|start|run_?app)|launch_?app|open_?app|start_?app|app\.(open|launch|start))$/i,
    map: p => { const executable = first(p, ['executable', 'app', 'application', 'name', 'program', 'path']) ?? anyString(p); return executable ? { tool: 'process.start', params: { executable } } : null },
  },
  {
    // "Ask the user" is not a tool: finish the turn with the question.
    names: /^(clarify(_?query)?|clarification|ask(_?user|_?question)?|user\.ask|request_?clarification)$/i,
    map: p => ({ ask: first(p, ['question', 'query', 'message', 'text', 'prompt']) ?? anyString(p) ?? 'Could you tell me a bit more about what you want me to do?' }),
  },
]

/** The real tool for an invented name (null when it isn't one, or its inputs can't be mapped). */
export function resolveToolAlias(tool: string, params: Record<string, unknown> | undefined): AliasResult | null {
  const alias = ALIASES.find(a => a.names.test(String(tool ?? '').trim()))
  return alias ? alias.map(params ?? {}) : null
}
