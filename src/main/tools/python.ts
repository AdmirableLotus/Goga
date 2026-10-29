import { shell } from 'electron'
import { ToolRegistry } from './registry'
import { findPython, runPython, workDir } from '../services/python'
import { LogService } from '../services/logs'

const reg = ToolRegistry.getInstance()
const log = LogService.getInstance()

reg.register({
  name: 'python.run',
  description: 'Run a short Python 3 script for real computation: engineering maths, data analysis, or a chart. To show a chart, use matplotlib and savefig("plot.png") — saved PNGs are opened for the user to see. Returns stdout and any errors. No internet access inside the script.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'The full Python script. Print results; save plots with matplotlib.pyplot.savefig("name.png").' },
    },
    required: ['code'],
  },
  // Powerful like a shell command; under the user's auto-approve setting it runs without a prompt,
  // and asks when approvals are turned up. It runs isolated (python -I) in its own folder.
  riskLevel: 'high', reversible: false, category: 'process',
}, async (p, ctx) => {
  const python = findPython()
  if (!python) return { success: false, error: 'Python is not installed on this PC. Install Python 3 from python.org, then try again.' }
  try {
    const dir = workDir()
    const result = await runPython(String(p.code ?? ''), python, dir, ctx.abortSignal)
    // Show plots — this helps a visual learner see the result, not just read numbers.
    for (const img of result.images) shell.openPath(img).catch(() => {})
    log.info(`python.run ${result.ok ? 'ok' : 'failed'}${result.images.length ? `, ${result.images.length} image(s)` : ''}`)
    return {
      success: result.ok,
      data: { stdout: result.stdout, stderr: result.stderr, images: result.images.map(i => i.split(/[\\/]/).pop()), opened: result.images.length },
      ...(result.ok ? {} : { error: result.stderr || 'Python exited with an error.' }),
    }
  } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) } }
})
