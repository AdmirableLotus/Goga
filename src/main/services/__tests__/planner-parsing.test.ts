import { beforeEach, describe, expect, it, vi } from 'vitest'
const boundary = vi.hoisted(() => ({ chat:vi.fn(), execute:vi.fn() }))
vi.mock('../logs', () => ({LogService:{getInstance:()=>({info:vi.fn(),warn:vi.fn(),error:vi.fn()})}}))
vi.mock('../settings', () => ({SettingsService:{getInstance:()=>({get:()=>({userName:'Fixture',agentMaxSteps:20,primaryModel:'local'})})}}))
vi.mock('../brain', () => ({BrainService:{getInstance:()=>({getRelevantFacts:()=>[]})}}))
vi.mock('../actionStore', () => ({ActionStore:{getInstance:()=>({stopAll:vi.fn(),add:vi.fn()})}}))
vi.mock('../localLlama', () => ({LocalLlamaService:{getInstance:()=>({isReady:()=>true,getState:()=>({modelPath:'fixture.gguf'}),chat:boundary.chat})}}))
vi.mock('../ollamaClient', () => ({OllamaClient:vi.fn(()=>({chat:vi.fn()}))}))
vi.mock('../taskMemory', () => ({TaskMemoryService:{getInstance:()=>({findRelevant:()=>[],save_pattern:vi.fn()})}}))
vi.mock('../securityWorkspace', () => ({SecurityWorkspaceService:{getInstance:()=>({getActive:()=>null})}}))
vi.mock('../authorization', () => ({AuthorizationService:{getInstance:()=>({evaluateAndLog:()=>({allowed:true,requiresApproval:false})})}}))
vi.mock('../../adapters/desktop', () => ({DesktopAdapter:vi.fn(()=>({screenshot:vi.fn().mockRejectedValue(new Error('no screenshot fixture')),activeWindow:vi.fn()}))}))
vi.mock('../../index', () => ({getMainWindow:()=>null}))
vi.mock('../../tools/registry', () => ({ToolRegistry:{getInstance:()=>({get:()=>undefined,list:()=>[],execute:boundary.execute,toPromptSummary:()=>'',toOllamaTools:()=>[]})}}))
import { AgentLoop } from '../agentLoop'

beforeEach(() => { boundary.chat.mockReset(); boundary.execute.mockReset() })
const task = 'make a text file called fixture.txt with the content routing check'
const validTool = '{"thought":"Save requested text","tool":"notepad.saveText","params":{"text":"routing check","filename":"fixture.txt"}}'
function plan(agent: AgentLoop, signal = new AbortController().signal) {
  return (agent as any).planNextStep(task, [], undefined, '', '', signal)
}

describe('actual planner parser, bounded retry and failure state', () => {
  it.each([
    'prose with {broken braces}', '{not json}', '',
    'null', '[]', '{"done":"true","reply":"claimed success"}',
    '{"done":true}', '{"tool":42}', '{"tool":"notepad.saveText","params":[]}',
    '{"done":true,"reply":"done","thought":{}}',
    '{"done":true,"reply":"done","tool":"notepad.saveText"}',
    '{"tool":"notepad.saveText","reply":42}',
    'prefix {"done":true,"reply":"claimed success"} suffix'
  ])('never classifies malformed output %j as successful completion', raw => {
    const result = (new AgentLoop() as any).parseToolCall(raw)
    expect(result._planningFailed).toBe(true)
  })
  it('retries brace-containing malformed output once and accepts a valid call', async () => {
    boundary.chat.mockResolvedValueOnce('{not json}').mockResolvedValueOnce(validTool)
    const result = await plan(new AgentLoop())
    expect(result).toMatchObject({tool:'notepad.saveText',done:false,params:{text:'routing check'}})
    expect(boundary.chat).toHaveBeenCalledTimes(2)
    expect(boundary.chat.mock.calls[1][0].at(-1).content).toContain('Your response was not valid JSON')
  })
  it('two malformed responses terminate AgentLoop in error without registry dispatch', async () => {
    boundary.chat.mockResolvedValue('I claim it is done {not json}')
    const agent = new AgentLoop()
    await agent.run(task)
    expect(boundary.chat).toHaveBeenCalledTimes(2)
    expect(agent.getState()).toMatchObject({status:'error',error:expect.stringContaining('planning_failed')})
    expect(boundary.execute).not.toHaveBeenCalled()
  })
  it('invalid retry schema cannot produce successful completion', async () => {
    boundary.chat.mockResolvedValueOnce('{broken}').mockResolvedValueOnce('{"done":"true","reply":"done"}')
    const result = await plan(new AgentLoop())
    expect(result._planningFailed).toBe(true)
    expect(boundary.chat).toHaveBeenCalledTimes(2)
  })
  it('preserves valid completion replies containing literal braces and fenced tool JSON', () => {
    const agent = new AgentLoop() as any
    expect(agent.parseToolCall('{"done":true,"reply":"literal {value}"}')).toMatchObject({done:true,reply:'literal {value}'})
    expect(agent.parseToolCall('```json\n'+validTool+'\n```')).toMatchObject({done:false,tool:'notepad.saveText'})
  })
  it('Stop after the first response suppresses retry and dispatch', async () => {
    const agent = new AgentLoop()
    boundary.chat.mockImplementationOnce(async (_messages, _onToken, signal: AbortSignal) => {
      agent.stop('fixture Stop')
      expect(signal.aborted).toBe(true)
      return '{broken}'
    })
    await agent.run(task)
    expect(agent.getState().status).toBe('stopped')
    expect(boundary.chat).toHaveBeenCalledTimes(1)
    expect(boundary.execute).not.toHaveBeenCalled()
  })
  it('backend exceptions become explicit planner errors, not successful completion', async () => {
    boundary.chat.mockRejectedValue(new Error('fixture backend failed'))
    const agent = new AgentLoop()
    const reply = await agent.run(task)
    expect(agent.getState().status).toBe('error')
    expect(reply).toContain('fixture backend failed')
    expect(boundary.chat).toHaveBeenCalledTimes(1)
  })
})
