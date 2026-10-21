import {expect,it} from 'vitest'
import {execFileSync} from 'child_process'
import {developerModelSchema} from '../developerModelSchema'

it('compiles the actual JSON grammar with the installed CPU runtime, without a model or network',()=>{
  const script="(async()=>{const {getLlama}=await import('node-llama-cpp');const llama=await getLlama({gpu:false});try{await llama.createGrammarForJsonSchema(JSON.parse(process.argv[1]));console.log('compiled');}finally{await llama.dispose();}})().catch(()=>process.exit(1));"
  const stdout=execFileSync(process.execPath,['-e',script,JSON.stringify(developerModelSchema(['F1','S1','S2','S3']))],{encoding:'utf8',timeout:20_000,maxBuffer:100_000,windowsHide:true})
  expect(stdout.trim()).toBe('compiled')
},25_000)
