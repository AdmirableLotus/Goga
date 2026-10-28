import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { ToolRegistry } from './registry'
import { BOARDS, MicrocontrollerService, type MicroProject } from '../services/microcontroller'
import { SchematikReader } from '../services/schematik'
import { BRAVE_PATH } from '../adapters/browser'

const reg = ToolRegistry.getInstance()
const micro = new MicrocontrollerService()
let schematik: SchematikReader | null = null

const failure = (err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) })
const boardNames = Object.keys(BOARDS).join(', ')

reg.register({
  name: 'microcontroller.build',
  description: `Make a microcontroller project (${boardNames}) on this PC: the code, plus a build guide with parts to buy, wiring and steps, in Documents\\Goga\\Microcontrollers\\<name>. Compiles the code to check it.`,
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short project name, letters/digits/-/_ only.' },
      board: { type: 'string', enum: Object.keys(BOARDS), description: 'The board.' },
      code: { type: 'string', description: 'The full Arduino sketch, with setup() and loop().' },
      parts: { type: 'array', description: '[{"name":"DHT22 sensor","qty":1,"note":"temperature"}]' },
      wiring: { type: 'array', description: '[{"from":"DHT22 DATA","to":"GPIO 4","note":"10k pull-up to 3V3"}]' },
      steps: { type: 'array', description: 'Assembly steps, in order.' },
    },
    required: ['name', 'board', 'code'],
  },
  riskLevel: 'medium', reversible: true, category: 'filesystem',
}, async (p, ctx) => {
  try {
    const r = await micro.build(p as unknown as MicroProject, ctx.abortSignal)
    return { success: true, data: `${r.ok ? 'Compiled' : 'Did not compile'}: ${r.report}\nBuild guide: ${r.guide}\nFolder: ${r.folder}` }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'microcontroller.setup',
  description: 'Install support for a board (and any libraries the code needs) so projects for it compile. Downloads from Arduino\'s official indexes.',
  parameters: {
    type: 'object',
    properties: {
      board: { type: 'string', enum: Object.keys(BOARDS), description: 'The board.' },
      libraries: { type: 'array', description: 'Arduino library names, e.g. ["DHT sensor library"].' },
    },
    required: ['board'],
  },
  riskLevel: 'high', reversible: false, category: 'system',
}, async (p, ctx) => {
  try {
    return { success: true, data: await micro.setup(String(p.board), (p.libraries as string[] | undefined) ?? [], ctx.abortSignal) }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'microcontroller.boards',
  description: 'List the microcontroller boards plugged into this PC, with their ports (like COM3).',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'system',
}, async (_p, ctx) => {
  try {
    const boards = await micro.connectedBoards(ctx.abortSignal)
    return { success: true, data: boards.length ? boards.map(b => `${b.port}: ${b.label}`).join('\n') : 'No board is plugged in.' }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'microcontroller.upload',
  description: 'Upload a project made with microcontroller.build to the board on a port.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The project name.' },
      port: { type: 'string', description: 'The board\'s port from microcontroller.boards, e.g. "COM3".' },
    },
    required: ['name', 'port'],
  },
  riskLevel: 'high', reversible: false, category: 'system',
}, async (p, ctx) => {
  try {
    return { success: true, data: await micro.upload(String(p.name), String(p.port), ctx.abortSignal) }
  } catch (err) { return failure(err) }
})

reg.register({
  name: 'schematik.read',
  description: 'Read a page of the user\'s Schematik (schematik.io) account: a project link, or their project list when no url is given. Opens Goga\'s Schematik window; if it asks to sign in, the user signs in there themselves and the page is read once they have.',
  parameters: {
    type: 'object',
    properties: { url: { type: 'string', description: 'A https://www.schematik.io/app/... link (optional).' } },
  },
  riskLevel: 'low', reversible: true, category: 'web',
}, async (p, ctx) => {
  try {
    schematik ??= new SchematikReader(path.join(app.getPath('userData'), 'schematik-browser'), fs.existsSync(BRAVE_PATH) ? BRAVE_PATH : undefined)
    const r = await schematik.read(p.url ? String(p.url) : undefined, undefined, ctx.abortSignal)
    if (r.signIn) return { success: false, error: 'Schematik is asking to sign in and nobody signed in within 4 minutes. Ask the user to sign in in the Schematik window themselves, then read the page again.' }
    return { success: true, data: r.text || '(the page had no text)' }
  } catch (err) { return failure(err) }
})
