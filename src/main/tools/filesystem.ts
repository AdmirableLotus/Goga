import fs from 'fs'
import path from 'path'
import { ToolRegistry } from './registry'
import { shellExecute } from './shell'

const reg = ToolRegistry.getInstance()

reg.register({
  name: 'filesystem.read',
  description: 'Read the text content of a file. Returns the file contents as a string.',
  parameters: {
    type: 'object',
    properties: {
      path:     { type: 'string', description: 'Absolute or relative file path.' },
      encoding: { type: 'string', description: 'Text encoding. Default: utf-8.' }
    },
    required: ['path']
  },
  riskLevel: 'low', reversible: true, category: 'filesystem'
}, async (p) => {
  try {
    const content = fs.readFileSync(p.path as string, (p.encoding as BufferEncoding) ?? 'utf-8')
    return { success: true, data: { content, path: p.path, size: content.length } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

reg.register({
  name: 'filesystem.write',
  description: 'Write or overwrite a file with text content. Creates the file if it does not exist.',
  parameters: {
    type: 'object',
    properties: {
      path:    { type: 'string', description: 'Absolute or relative file path.' },
      content: { type: 'string', description: 'Text content to write.' },
      append:  { type: 'boolean', description: 'If true, append instead of overwrite. Default: false.' }
    },
    required: ['path', 'content']
  },
  riskLevel: 'high', reversible: false, category: 'filesystem'
}, async (p) => {
  try {
    const filePath = p.path as string
    const content = p.content as string
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    if (p.append) fs.appendFileSync(filePath, content, 'utf-8')
    else fs.writeFileSync(filePath, content, 'utf-8')
    return { success: true, data: { path: filePath, bytes: Buffer.byteLength(content) } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

reg.register({
  name: 'filesystem.list',
  description: 'List files and directories at a path. Returns names, types and sizes.',
  parameters: {
    type: 'object',
    properties: {
      path:      { type: 'string', description: 'Directory path to list.' },
      recursive: { type: 'boolean', description: 'List recursively. Default: false.' }
    },
    required: ['path']
  },
  riskLevel: 'low', reversible: true, category: 'filesystem'
}, async (p) => {
  try {
    const dirPath = p.path as string
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    const result = entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file',
      size: e.isFile() ? fs.statSync(path.join(dirPath, e.name)).size : undefined
    }))
    return { success: true, data: { path: dirPath, entries: result, count: result.length } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

reg.register({
  name: 'filesystem.search',
  description: 'Search for files matching a name pattern under a directory. Uses PowerShell Get-ChildItem.',
  parameters: {
    type: 'object',
    properties: {
      path:    { type: 'string', description: 'Root directory to search from.' },
      pattern: { type: 'string', description: 'File name pattern, e.g. "*.ts" or "config*".' },
      content: { type: 'string', description: 'Optional: search file contents for this string (grep).' }
    },
    required: ['path', 'pattern']
  },
  riskLevel: 'low', reversible: true, category: 'filesystem'
}, async (p) => {
  const rootPath = (p.path as string).replace(/'/g, "''")
  const pattern = (p.pattern as string).replace(/'/g, "''")
  let cmd = `Get-ChildItem -Path '${rootPath}' -Recurse -Filter '${pattern}' -ErrorAction SilentlyContinue | Select-Object -First 200 FullName, Length | ConvertTo-Json -Compress`
  if (p.content) {
    const needle = (p.content as string).replace(/'/g, "''")
    cmd = `Get-ChildItem -Path '${rootPath}' -Recurse -Filter '${pattern}' -ErrorAction SilentlyContinue | Select-String -Pattern '${needle}' | Select-Object -First 200 Path, LineNumber, Line | ConvertTo-Json -Compress`
  }
  const result = await shellExecute(cmd)
  try {
    const parsed = JSON.parse(result.stdout || '[]')
    return { success: true, data: Array.isArray(parsed) ? parsed : [parsed] }
  } catch {
    return { success: true, data: result.stdout ? result.stdout.split('\n').filter(Boolean) : [] }
  }
})

reg.register({
  name: 'filesystem.move',
  description: 'Move or rename a file or directory.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Source path.' },
      to:   { type: 'string', description: 'Destination path.' }
    },
    required: ['from', 'to']
  },
  riskLevel: 'high', reversible: false, category: 'filesystem'
}, async (p) => {
  try {
    fs.renameSync(p.from as string, p.to as string)
    return { success: true, data: { from: p.from, to: p.to } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

reg.register({
  name: 'filesystem.delete',
  description: 'Delete a file or directory. IRREVERSIBLE — always requires approval.',
  parameters: {
    type: 'object',
    properties: {
      path:      { type: 'string', description: 'Path to delete.' },
      recursive: { type: 'boolean', description: 'Delete directory recursively. Default: false.' }
    },
    required: ['path']
  },
  riskLevel: 'critical', reversible: false, category: 'filesystem'
}, async (p) => {
  try {
    const target = p.path as string
    const stat = fs.statSync(target)
    if (stat.isDirectory()) fs.rmSync(target, { recursive: !!(p.recursive), force: true })
    else fs.unlinkSync(target)
    return { success: true, data: { deleted: target } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

reg.register({
  name: 'filesystem.mkdir',
  description: 'Create a directory (and any missing parent directories).',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory path to create.' } },
    required: ['path']
  },
  riskLevel: 'low', reversible: false, category: 'filesystem'
}, async (p) => {
  try {
    fs.mkdirSync(p.path as string, { recursive: true })
    return { success: true, data: { created: p.path } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
})

export function registerFilesystemTools() {
  return ToolRegistry.getInstance()
}
