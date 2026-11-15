import fs from 'fs'
import path from 'path'
import { spawn, execFile, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { nanoid } from '../../utils/nanoid'
import type { BuildProject, BuildTemplate } from '../../../shared/business'
import { addProject, listProjects, removeProject, updateProject } from './store'
import { recordAudit } from './audit'

/**
 * App building: scaffold a project on disk, build it, run it, and show the user a preview.
 *
 * What this is: a local scaffolder and runner. It writes real files into a folder the user
 * chooses, runs the project's own build command, and starts its dev server so the user can
 * look at it in a browser. It can also be pointed at a project that already exists.
 *
 * What this is not: a hosted builder, and not a store publisher. Choicely and Runable run
 * the build on their own servers and publish to the App Store and Google Play for you.
 * Goga runs on this machine, so publishing still goes through the user's own developer
 * accounts and their own approval of that release. Nothing here uploads anything.
 *
 * Every command runs with a fixed, small environment: no Goga credentials are forwarded.
 */

const execute = promisify(execFile)
const MAX_OUTPUT = 12_000
const BUILD_TIMEOUT_MS = 5 * 60_000

export function builderEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp',
    'home', 'userprofile', 'appdata', 'localappdata', 'programfiles', 'programfiles(x86)', 'number_of_processors'])
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key.toLowerCase())))
}

function safeName(input: string): string {
  const name = String(input ?? '').trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '')
  if (!name) throw new Error('give the project a name using letters, digits or hyphens')
  if (name.length > 60) throw new Error('that name is too long')
  return name
}

/** Refuse to write outside the folder the user picked. */
function insideRoot(root: string, relative: string): string {
  const target = path.resolve(root, relative)
  const normalRoot = path.resolve(root)
  if (target !== normalRoot && !target.startsWith(normalRoot + path.sep)) {
    throw new Error(`refusing to write outside the project folder: ${relative}`)
  }
  return target
}

// ── templates ───────────────────────────────────────────────────────────────

interface TemplateFile { path: string; content: string }

function staticFiles(name: string, description: string): TemplateFile[] {
  return [
    {
      path: 'index.html',
      content: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(name)}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main>
    <h1>${escapeHtml(name)}</h1>
    <p>${escapeHtml(description || 'A new app, scaffolded by Goga.')}</p>
    <p class="hint">Edit <code>index.html</code> and <code>styles.css</code>, then reload this page.</p>
  </main>
  <script src="app.js"></script>
</body>
</html>
`,
    },
    {
      path: 'styles.css',
      content: `:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: grid; place-items: center;
  background: #0b0a11; color: #e9e7f2;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
main { max-width: 640px; padding: 32px; }
h1 { font-size: 28px; letter-spacing: -0.4px; margin: 0 0 12px; }
p { color: #9d97b3; line-height: 1.6; }
.hint { font-size: 13px; color: #6d6785; }
code { font-family: ui-monospace, Consolas, monospace; color: #9585ff; }
`,
    },
    {
      path: 'app.js',
      content: `// ${name} — scaffolded by Goga.
// This file is yours. Nothing here is regenerated after the first write.
console.log('${name.replace(/'/g, "\\'")} loaded')
`,
    },
    {
      path: 'README.md',
      content: `# ${name}

${description || 'A new app, scaffolded by Goga.'}

## Run it

Open \`index.html\` in a browser, or serve the folder:

\`\`\`
npx serve .
\`\`\`

## Files

- \`index.html\` — the page
- \`styles.css\` — the styles
- \`app.js\` — the script
`,
    },
  ]
}

function viteReactFiles(name: string, description: string): TemplateFile[] {
  return [
    {
      path: 'package.json',
      content: JSON.stringify({
        name,
        private: true,
        version: '0.0.1',
        type: 'module',
        description: description || 'A new app, scaffolded by Goga.',
        scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
        dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
        devDependencies: { '@vitejs/plugin-react': '^4.3.1', vite: '^5.4.0', typescript: '^5.5.0' },
      }, null, 2) + '\n',
    },
    {
      path: 'index.html',
      content: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(name)}</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
`,
    },
    {
      path: 'vite.config.ts',
      content: `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({ plugins: [react()] })
`,
    },
    {
      path: 'tsconfig.json',
      content: JSON.stringify({
        compilerOptions: {
          target: 'ES2020', lib: ['ES2020', 'DOM', 'DOM.Iterable'], module: 'ESNext',
          jsx: 'react-jsx', strict: true, moduleResolution: 'bundler', skipLibCheck: true,
          noEmit: true, isolatedModules: true,
        },
        include: ['src'],
      }, null, 2) + '\n',
    },
    {
      path: 'src/main.tsx',
      content: `import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
`,
    },
    {
      path: 'src/App.tsx',
      content: `export default function App() {
  return (
    <main>
      <h1>${escapeHtml(name)}</h1>
      <p>${escapeHtml(description || 'A new app, scaffolded by Goga.')}</p>
      <p className="hint">Edit <code>src/App.tsx</code> and save — Vite reloads the page.</p>
    </main>
  )
}
`,
    },
    {
      path: 'src/styles.css',
      content: `:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: grid; place-items: center;
  background: #0b0a11; color: #e9e7f2;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
main { max-width: 640px; padding: 32px; }
h1 { font-size: 28px; letter-spacing: -0.4px; margin: 0 0 12px; }
p { color: #9d97b3; line-height: 1.6; }
.hint { font-size: 13px; color: #6d6785; }
code { font-family: ui-monospace, Consolas, monospace; color: #9585ff; }
`,
    },
    {
      path: 'README.md',
      content: `# ${name}

${description || 'A new app, scaffolded by Goga.'}

## Run it

\`\`\`
npm install
npm run dev
\`\`\`

## Build it

\`\`\`
npm run build
\`\`\`

The build output lands in \`dist/\`.
`,
    },
  ]
}

function nodeExpressFiles(name: string, description: string): TemplateFile[] {
  return [
    {
      path: 'package.json',
      content: JSON.stringify({
        name,
        private: true,
        version: '0.0.1',
        description: description || 'A new app, scaffolded by Goga.',
        main: 'server.js',
        scripts: { start: 'node server.js' },
        dependencies: { express: '^4.19.2' },
      }, null, 2) + '\n',
    },
    {
      path: 'server.js',
      content: `// ${name} — scaffolded by Goga.
const express = require('express')
const path = require('path')

const app = express()
const port = Number(process.env.PORT) || 3000

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: ${JSON.stringify(name)}, at: new Date().toISOString() })
})

app.listen(port, () => console.log(\`${name} listening on http://localhost:\${port}\`))
`,
    },
    {
      path: 'public/index.html',
      content: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(name)}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main>
    <h1>${escapeHtml(name)}</h1>
    <p>${escapeHtml(description || 'A new app, scaffolded by Goga.')}</p>
    <p class="hint">Health check: <code>/api/health</code></p>
  </main>
</body>
</html>
`,
    },
    {
      path: 'public/styles.css',
      content: `:root { color-scheme: dark; }
body {
  margin: 0; min-height: 100vh; display: grid; place-items: center;
  background: #0b0a11; color: #e9e7f2;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
main { max-width: 640px; padding: 32px; }
h1 { font-size: 28px; letter-spacing: -0.4px; margin: 0 0 12px; }
p { color: #9d97b3; line-height: 1.6; }
.hint { font-size: 13px; color: #6d6785; }
code { font-family: ui-monospace, Consolas, monospace; color: #9585ff; }
`,
    },
    {
      path: 'README.md',
      content: `# ${name}

${description || 'A new app, scaffolded by Goga.'}

## Run it

\`\`\`
npm install
npm start
\`\`\`

Then open http://localhost:3000
`,
    },
  ]
}

function escapeHtml(text: string): string {
  return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

export function templateFiles(template: BuildTemplate, name: string, description: string): TemplateFile[] {
  switch (template) {
    case 'vite-react': return viteReactFiles(name, description)
    case 'node-express': return nodeExpressFiles(name, description)
    default: return staticFiles(name, description)
  }
}

// ── scaffolding ─────────────────────────────────────────────────────────────

export interface ScaffoldInput {
  parentDir: string
  name: string
  template: BuildTemplate
  description: string
}

/**
 * Write a new project into `parentDir/name`. Refuses to overwrite: if the folder exists and
 * is not empty, nothing is written and the user is told to pick another name.
 */
export function scaffold(input: ScaffoldInput): BuildProject {
  const name = safeName(input.name)
  const parent = path.resolve(String(input.parentDir ?? '').trim())
  if (!parent) throw new Error('choose a folder to put the project in')
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new Error('that parent folder does not exist')
  const dir = path.join(parent, name)
  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir)
    if (entries.length) throw new Error(`${dir} already has files in it — pick another name, or open it as an existing project`)
  }
  const files = templateFiles(input.template, name, input.description)
  fs.mkdirSync(dir, { recursive: true })
  for (const file of files) {
    const target = insideRoot(dir, file.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.content, 'utf8')
  }
  const project: BuildProject = {
    id: nanoid(),
    name,
    dir,
    template: input.template,
    description: String(input.description ?? '').trim(),
    createdAt: new Date().toISOString(),
    files: files.map(f => f.path),
    lastBuild: null,
    devUrl: null,
    devPid: null,
    existing: false,
  }
  addProject(project)
  recordAudit('note', 'build-run', `scaffolded ${name} (${input.template}) in ${dir}: ${files.length} file(s)`)
  return project
}

/** Point Goga at a project that already exists, so it can build and run it. */
export function openExisting(dirInput: string): BuildProject {
  const dir = path.resolve(String(dirInput ?? '').trim())
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('that folder does not exist')
  const known = listProjects().find(p => p.dir === dir)
  if (known) return known
  let name = path.basename(dir)
  let template: BuildTemplate = 'static'
  let description = ''
  const pkgPath = path.join(dir, 'package.json')
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string; description?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
      name = pkg.name || name
      description = pkg.description || ''
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
      template = deps.vite || deps.react ? 'vite-react' : deps.express ? 'node-express' : 'static'
    } catch { /* an unreadable package.json is not fatal: the folder is still usable */ }
  }
  const project: BuildProject = {
    id: nanoid(), name, dir, template, description,
    createdAt: new Date().toISOString(), files: [], lastBuild: null,
    devUrl: null, devPid: null, existing: true,
  }
  addProject(project)
  recordAudit('note', 'build-run', `opened existing project ${name} at ${dir}`)
  return project
}

// ── building ────────────────────────────────────────────────────────────────

function buildCommand(project: BuildProject): { command: string; args: string[] } | null {
  const pkgPath = path.join(project.dir, 'package.json')
  if (!fs.existsSync(pkgPath)) return null
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }
    if (pkg.scripts?.build) return { command: 'npm', args: ['run', 'build'] }
  } catch { return null }
  return null
}

export async function buildProject(id: string): Promise<BuildProject> {
  const project = listProjects().find(p => p.id === id)
  if (!project) throw new Error('no such project')
  const cmd = buildCommand(project)
  if (!cmd) {
    const result = { at: new Date().toISOString(), ok: false, command: '(none)', output: 'This project has no package.json build script, so there is nothing to build. A static project is already runnable as it is.' }
    updateProject(id, { lastBuild: result })
    recordAudit('note', 'build-run', `${project.name}: no build script`)
    return { ...project, lastBuild: result }
  }
  recordAudit('note', 'build-run', `building ${project.name}: ${cmd.command} ${cmd.args.join(' ')}`)
  try {
    const { stdout, stderr } = await execute(cmd.command, cmd.args, {
      cwd: project.dir, windowsHide: true, timeout: BUILD_TIMEOUT_MS, maxBuffer: 8_000_000,
      env: builderEnvironment(process.env), shell: process.platform === 'win32',
    })
    const output = `${stdout}\n${stderr}`.trim().slice(-MAX_OUTPUT)
    const result = { at: new Date().toISOString(), ok: true, command: `${cmd.command} ${cmd.args.join(' ')}`, output }
    updateProject(id, { lastBuild: result })
    recordAudit('execute', 'build-run', `${project.name} built successfully`)
    return { ...project, lastBuild: result }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`.trim().slice(-MAX_OUTPUT)
    const result = { at: new Date().toISOString(), ok: false, command: `${cmd.command} ${cmd.args.join(' ')}`, output }
    updateProject(id, { lastBuild: result })
    recordAudit('error', 'build-run', `${project.name} failed to build`)
    return { ...project, lastBuild: result }
  }
}

// ── running ─────────────────────────────────────────────────────────────────

const running = new Map<string, ChildProcess>()

function devCommand(project: BuildProject): { command: string; args: string[]; url: string } | null {
  const pkgPath = path.join(project.dir, 'package.json')
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }
      if (pkg.scripts?.dev) return { command: 'npm', args: ['run', 'dev'], url: 'http://localhost:5173' }
      if (pkg.scripts?.start) return { command: 'npm', args: ['start'], url: 'http://localhost:3000' }
    } catch { /* fall through to the static case */ }
  }
  return null
}

/**
 * Start the project's own dev server and return the URL to preview. The process is tracked
 * so it can be stopped; it is killed when Goga quits.
 */
export async function runProject(id: string): Promise<BuildProject> {
  const project = listProjects().find(p => p.id === id)
  if (!project) throw new Error('no such project')
  if (running.has(id)) throw new Error('that project is already running — stop it first')
  const cmd = devCommand(project)
  if (!cmd) {
    // A static project needs no server: the file itself is the preview.
    const index = path.join(project.dir, 'index.html')
    if (!fs.existsSync(index)) throw new Error('this project has no dev script and no index.html, so there is nothing to preview')
    const url = `file:///${index.replace(/\\/g, '/')}`
    updateProject(id, { devUrl: url, devPid: null })
    recordAudit('note', 'build-run', `${project.name}: static preview at ${url}`)
    return { ...project, devUrl: url, devPid: null }
  }
  recordAudit('note', 'build-run', `starting ${project.name}: ${cmd.command} ${cmd.args.join(' ')}`)
  const child = spawn(cmd.command, cmd.args, {
    cwd: project.dir, windowsHide: true, env: builderEnvironment(process.env), shell: process.platform === 'win32',
  })
  running.set(id, child)
  child.on('exit', () => {
    running.delete(id)
    try { updateProject(id, { devUrl: null, devPid: null }) } catch { /* the store may be gone at quit */ }
  })
  child.on('error', () => { running.delete(id) })
  // Give the server a moment to bind its port before the user is sent to it.
  await new Promise<void>(resolve => setTimeout(resolve, 2500))
  const updated = updateProject(id, { devUrl: cmd.url, devPid: child.pid ?? null })
  recordAudit('execute', 'build-run', `${project.name} dev server started at ${cmd.url}`)
  return updated
}

export function stopProject(id: string): BuildProject {
  const child = running.get(id)
  const project = listProjects().find(p => p.id === id)
  if (!project) throw new Error('no such project')
  if (child?.pid) {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => { /* best effort */ })
    } else child.kill('SIGTERM')
  }
  running.delete(id)
  recordAudit('note', 'build-run', `${project.name} dev server stopped`)
  return updateProject(id, { devUrl: null, devPid: null })
}

export function stopAllProjects(): void {
  for (const id of [...running.keys()]) {
    try { stopProject(id) } catch { /* shutting down */ }
  }
}

export function forgetProject(id: string): void {
  stopProject(id)
  removeProject(id)
}
