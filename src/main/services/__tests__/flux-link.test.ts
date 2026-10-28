import { describe, expect, it } from 'vitest'
import { fluxToolDefinition, resultText } from '../fluxLink'
import { FLUX_TASK, looksLikeAgentTask, planNeedsComputer, plannerOffers } from '../agentRouting'

describe('Flux tools in Goga', () => {
  it('lets reading run freely and makes changes ask first', () => {
    const read = fluxToolDefinition({ name: 'get_project', description: 'Read a project', annotations: { readOnlyHint: true }, inputSchema: { properties: { projectId: { type: 'string' } }, required: ['projectId'] } })
    expect(read).toMatchObject({ name: 'flux.get_project', riskLevel: 'low', reversible: true })
    expect(read.parameters.required).toEqual(['projectId'])
    const change = fluxToolDefinition({ name: 'ask_flux', description: 'Ask Flux to change the design' })
    expect(change).toMatchObject({ name: 'flux.ask_flux', riskLevel: 'high', reversible: false })
    expect(change.description).toContain('Flux (circuit-board design)')
  })

  it('without hints from Flux, reads freely and asks before changes, credits or messages to Flux', () => {
    const risk = (name: string) => fluxToolDefinition({ name }).riskLevel
    for (const name of ['list_projects', 'get_nets', 'get_bom', 'wait_for_thread', 'ask_project_wiki', 'list_organization_memberships']) expect(risk(name)).toBe('low')
    for (const name of ['create_project', 'create_thread', 'send_message', 'send_feedback', 'review_knowledge']) expect(risk(name)).toBe('high')
    // Flux's own hint wins over the name
    expect(fluxToolDefinition({ name: 'get_layout', annotations: { readOnlyHint: false } }).riskLevel).toBe('high')
  })

  it('offers Flux tools to the planner only for Flux tasks', () => {
    expect(FLUX_TASK.test('check my Flux project for missing capacitors')).toBe(true)
    expect(FLUX_TASK.test('open notepad and save my notes')).toBe(false)
    expect(FLUX_TASK.test('the reflux valve')).toBe(false)
  })

  it('gives Flux tasks a focused tool set that fits the local brain', () => {
    const flux = plannerOffers('Check my Flux project and see if you can add an ISFET chip')
    for (const name of ['flux.get_project', 'flux.send_message', 'electronics.findPart', 'web.search', 'notepad.saveText']) expect(flux(name)).toBe(true)
    for (const name of ['computer.click', 'browser.open', 'shell.execute', 'flux.send_feedback']) expect(flux(name)).toBe(false)
    const other = plannerOffers('open notepad and save my notes')
    expect(other('computer.click')).toBe(true)
    expect(other('flux.get_project')).toBe(false)
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
