import { describe, expect, it } from 'vitest'
import { fluxToolDefinition, resultText } from '../fluxLink'
import { looksLikeAgentTask, planNeedsComputer } from '../agentRouting'

describe('Flux tools in Goga', () => {
  it('lets reading run freely and makes changes ask first', () => {
    const read = fluxToolDefinition({ name: 'get_project', description: 'Read a project', annotations: { readOnlyHint: true }, inputSchema: { properties: { projectId: { type: 'string' } }, required: ['projectId'] } })
    expect(read).toMatchObject({ name: 'flux.get_project', riskLevel: 'low', reversible: true })
    expect(read.parameters.required).toEqual(['projectId'])
    const change = fluxToolDefinition({ name: 'ask_flux', description: 'Ask Flux to change the design' })
    expect(change).toMatchObject({ name: 'flux.ask_flux', riskLevel: 'high', reversible: false })
    expect(change.description).toContain('Flux (flux.ai circuit-board design)')
  })

  it('keeps tool results short enough for the brain', () => {
    expect(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
    expect(resultText({ content: [], structuredContent: { ok: 1 } })).toBe('{"ok":1}')
    expect(resultText({ content: [{ type: 'text', text: 'x'.repeat(9000) }] }).length).toBeLessThan(6100)
  })

  it('sends Flux work to the PC agent, and keeps writing in chat', () => {
    expect(looksLikeAgentTask('design the Viora sensor board in Flux')).toBe(true)
    expect(looksLikeAgentTask('check my flux project for missing decoupling capacitors')).toBe(true)
    expect(looksLikeAgentTask('draft the parts list for the Viora board')).toBe(false)
    expect(looksLikeAgentTask('build a circuit for the BioZ front end')).toBe(true)
    expect(planNeedsComputer('I will find the parts in KiCad and build the schematic. Want me to go ahead?')).toBe(true)
  })
})
