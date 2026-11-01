import os from 'os'
import { describe, expect, it } from 'vitest'
import { resolveToolAlias } from '../toolAliases'
import { describeDone } from '../agentResilience'

describe('invented tool names', () => {
  it('maps the names from Goga\'s gap journal to real tools', () => {
    expect(resolveToolAlias('terminal', { command: 'pip install alpaca-py' })).toEqual({ tool: 'shell.execute', params: { command: 'pip install alpaca-py' } })
    expect(resolveToolAlias('computer.searchFiles', { folder: 'C:\\Users\\me\\Desktop', name: 'budget' }))
      .toEqual({ tool: 'filesystem.search', params: { path: 'C:\\Users\\me\\Desktop', pattern: '*budget*' } })
    expect(resolveToolAlias('navigate_to_url', { url: 'https://example.com' })).toEqual({ tool: 'browser.open', params: { url: 'https://example.com' } })
    expect(resolveToolAlias('computer.launch', { app: 'notepad' })).toEqual({ tool: 'process.start', params: { executable: 'notepad' } })
  })

  it('fills sensible defaults and keeps wildcards', () => {
    expect(resolveToolAlias('find_files', { pattern: '*.pdf' })).toEqual({ tool: 'filesystem.search', params: { path: os.homedir(), pattern: '*.pdf' } })
  })

  it('turns "ask the user" into a question, not a tool', () => {
    expect(resolveToolAlias('clarify_query', { question: 'Which folder?' })).toEqual({ ask: 'Which folder?' })
    expect(resolveToolAlias('clarification', {})).toEqual({ ask: expect.stringMatching(/tell me a bit more/) })
  })

  it('leaves real unknown names and unmappable inputs alone', () => {
    expect(resolveToolAlias('teleport', { where: 'mars' })).toBeNull()
    expect(resolveToolAlias('terminal', {})).toBeNull()
  })
})

describe('describing a finished step', () => {
  it('says what was done in plain words', () => {
    expect(describeDone({ tool: 'browser.open', params: { url: 'https://youtube.com' } })).toBe('I opened https://youtube.com')
    expect(describeDone({ tool: 'process.start', params: { executable: 'notepad' } })).toBe('I started notepad')
    expect(describeDone({ tool: 'clock.now', params: {} })).toBe('clock.now worked')
  })
})
