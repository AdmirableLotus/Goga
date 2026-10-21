import {beforeEach,expect,it,vi} from 'vitest'
vi.mock('../logs',()=>({LogService:{getInstance:()=>({info:vi.fn(),warn:vi.fn(),error:vi.fn()})}}))
vi.mock('../settings',()=>({SettingsService:{getInstance:()=>({get:()=>({localModelContextSize:4096})})}}))
import {LocalLlamaService} from '../localLlama'
let service:LocalLlamaService,session:any,ctx:any,model:any,llama:any,count:number
beforeEach(()=>{
  count=1000;ctx={contextSize:4096,getSequence:vi.fn(()=>({})),dispose:vi.fn(async()=>{})}
  session={getChatHistory:()=>[{type:'system',text:'trusted'}],chatWrapper:{generateContextState:vi.fn(()=>({contextText:{tokenize:()=>Array(count)}}))},prompt:vi.fn(async()=>'{}'),dispose:vi.fn()}
  model={createContext:vi.fn(async()=>ctx),tokenizer:vi.fn()};llama={createGrammarForJsonSchema:vi.fn(async()=>({grammar:true}))}
  service=new LocalLlamaService();Object.assign(service,{model,llama,state:{status:'ready'},developerRuntime:async()=>({LlamaChatSession:vi.fn(()=>session)})})
})
it('uses one bounded local JSON generation with untrusted source in a user turn and no tool calls',async()=>{
  const signal=new AbortController().signal,context=JSON.stringify({source:'untrusted code',sourceSpans:[{id:'F1'}]})
  await service.generateDeveloper('trusted rules',context,signal)
  expect(session.prompt).toHaveBeenCalledOnce()
  expect(session.prompt).toHaveBeenCalledWith(context,{maxTokens:1152,grammar:{grammar:true},signal,temperature:0.1})
  expect(session.chatWrapper.generateContextState.mock.calls[0][0].chatHistory.at(-2)).toEqual({type:'user',text:context})
  expect(ctx.dispose).toHaveBeenCalledOnce()
})
it('rejects over-budget input before generation and disposes the context',async()=>{
  count=2881
  await expect(service.generateDeveloper('system','source',new AbortController().signal)).rejects.toThrow('input budget')
  expect(session.prompt).not.toHaveBeenCalled();expect(ctx.dispose).toHaveBeenCalledOnce()
})
it('rejects pre-aborted work and late generation results',async()=>{
  const ac=new AbortController();ac.abort()
  await expect(service.generateDeveloper('s','c',ac.signal)).rejects.toThrow()
  expect(model.createContext).not.toHaveBeenCalled()
  const live=new AbortController();session.prompt.mockImplementation(async()=>{live.abort();return '{}'})
  await expect(service.generateDeveloper('s',JSON.stringify({sourceSpans:[{id:'F1'}]}),live.signal)).rejects.toThrow()
  expect(ctx.dispose).toHaveBeenCalledOnce()
})
