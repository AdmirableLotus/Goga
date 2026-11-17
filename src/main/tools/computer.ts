import { ToolRegistry } from './registry'
import type { ToolResult } from './registry'
import { DesktopAdapter, WindowDiscoveryError } from '../adapters/desktop'
import { FocusManager } from '../services/focusManager'
import { plannerDiagnostic } from '../services/plannerDiagnostics'

const desktop = new DesktopAdapter()
const reg = ToolRegistry.getInstance()

reg.register({
  name: 'computer.screenshot',
  description: 'Take a screenshot of the screen or a specific display. Returns base64 PNG.',
  parameters: { type: 'object', properties: { displayId: { type: 'number', description: 'Optional display index. Omit for primary.' } } },
  riskLevel: 'low', reversible: true, category: 'computer'
}, async (p) => {
  const r = await desktop.screenshot(p.displayId as number | undefined)
  return { success: true, data: r }
})

reg.register({
  name: 'computer.activeWindow',
  description: 'Get the title, owner app, PID and bounds of the currently focused window.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'computer'
}, async (_p, ctx) => {
  if (ctx.mode === 'read-only-observation') {
    return { success: true, data: await desktop.observeWindowIdentity(ctx.abortSignal) }
  }
  const r = await desktop.activeWindow()
  return { success: true, data: r }
})

reg.register({
  name: 'computer.windowList',
  description: 'List all visible top-level windows with their titles, PIDs and bounds.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'computer'
}, async () => {
  const r = await desktop.windowList()
  return { success: true, data: r }
})

reg.register({
  name: 'computer.focusWindow',
  description: 'Bring a window to the foreground by title substring or PID.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Partial window title to match.' },
      pid:   { type: 'number', description: 'Process ID of the window.' }
    }
  },
  riskLevel: 'low', reversible: true, category: 'computer'
}, async (p) => {
  const r = await desktop.focusWindow(p.title as string | undefined, p.pid as number | undefined)
  return { success: true, data: r }
})

reg.register({
  name: 'computer.uiElements',
  description: 'Enumerate interactive UI elements (buttons, inputs, links) in the focused or named window using UIAutomation. Returns name, role, center coordinates.',
  parameters: {
    type: 'object',
    properties: {
      windowTitle: { type: 'string', description: 'Optional window title to scan. Defaults to focused window.' }
    }
  },
  riskLevel: 'low', reversible: true, category: 'computer'
}, async (p, ctx) => {
  if (ctx.mode === 'read-only-observation') {
    const r = await desktop.observeWindowText(p.windowTitle as string, p.expectedPid as number, p.expectedHwnd as number, ctx.abortSignal)
    return { success: true, data: r }
  }
  const r = await desktop.uiElements(p.windowTitle as string | undefined)
  return { success: true, data: r }
})

reg.register({
  name: 'computer.click',
  description: 'Move the mouse to (x, y) and click. Use computer.uiElements to find coordinates first. ' +
    'REQUIRES pid and hwnd. Verifies foreground window matches both before clicking.',
  parameters: {
    type: 'object',
    properties: {
      x:           { type: 'number', description: 'Screen X coordinate.' },
      y:           { type: 'number', description: 'Screen Y coordinate.' },
      button:      { type: 'string', enum: ['left', 'right'], description: 'Mouse button. Default: left.' },
      pid:         { type: 'number', description: 'REQUIRED. Process ID of the target window.' },
      hwnd:        { type: 'number', description: 'REQUIRED. Native window handle.' },
      windowTitle: { type: 'string', description: 'Optional secondary evidence.' }
    },
    required: ['x', 'y', 'pid', 'hwnd']
  },
  riskLevel: 'medium', reversible: true, category: 'computer'
}, async (p, ctx) => {
  const pid  = p.pid  as number | undefined
  const hwnd = p.hwnd as number | undefined
  if (!pid)  return { success: false, error: 'computer.click: target_required — pid is mandatory.' }
  if (!hwnd) return { success: false, error: 'computer.click: target_required — hwnd is mandatory.' }
  const target = { pid, hwnd, title: p.windowTitle as string | undefined }
  const guard = await focus.focusGuardedType(
    target,
    () => desktop.click(p.x as number, p.y as number, p.button as 'left' | 'right' | undefined).then(() => {}),
    ctx.abortSignal,
    'coordinate'
  )
  if (!guard.allowed) return { success: false, error: `computer.click blocked: ${guard.reason}` }
  return { success: true, data: { x: p.x, y: p.y, button: p.button ?? 'left' } }
})

reg.register({
  name: 'computer.doubleClick',
  description: 'Double-click at (x, y). REQUIRES pid and hwnd. Verifies foreground window before clicking.',
  parameters: {
    type: 'object',
    properties: {
      x:           { type: 'number' },
      y:           { type: 'number' },
      pid:         { type: 'number', description: 'REQUIRED. Process ID of the target window.' },
      hwnd:        { type: 'number', description: 'REQUIRED. Native window handle.' },
      windowTitle: { type: 'string', description: 'Optional secondary evidence.' }
    },
    required: ['x', 'y', 'pid', 'hwnd']
  },
  riskLevel: 'medium', reversible: true, category: 'computer'
}, async (p, ctx) => {
  const pid  = p.pid  as number | undefined
  const hwnd = p.hwnd as number | undefined
  if (!pid)  return { success: false, error: 'computer.doubleClick: target_required — pid is mandatory.' }
  if (!hwnd) return { success: false, error: 'computer.doubleClick: target_required — hwnd is mandatory.' }
  const target = { pid, hwnd, title: p.windowTitle as string | undefined }
  const guard = await focus.focusGuardedType(
    target,
    () => desktop.doubleClick(p.x as number, p.y as number).then(() => {}),
    ctx.abortSignal,
    'coordinate'
  )
  if (!guard.allowed) return { success: false, error: `computer.doubleClick blocked: ${guard.reason}` }
  return { success: true, data: { x: p.x, y: p.y } }
})

reg.register({
  name: 'computer.rightClick',
  description: 'Right-click at (x, y) to open a context menu. REQUIRES pid and hwnd. Verifies foreground window before clicking.',
  parameters: {
    type: 'object',
    properties: {
      x:           { type: 'number' },
      y:           { type: 'number' },
      pid:         { type: 'number', description: 'REQUIRED. Process ID of the target window.' },
      hwnd:        { type: 'number', description: 'REQUIRED. Native window handle.' },
      windowTitle: { type: 'string', description: 'Optional secondary evidence.' }
    },
    required: ['x', 'y', 'pid', 'hwnd']
  },
  riskLevel: 'medium', reversible: true, category: 'computer'
}, async (p, ctx) => {
  const pid  = p.pid  as number | undefined
  const hwnd = p.hwnd as number | undefined
  if (!pid)  return { success: false, error: 'computer.rightClick: target_required — pid is mandatory.' }
  if (!hwnd) return { success: false, error: 'computer.rightClick: target_required — hwnd is mandatory.' }
  const target = { pid, hwnd, title: p.windowTitle as string | undefined }
  const guard = await focus.focusGuardedType(
    target,
    () => desktop.click(p.x as number, p.y as number, 'right').then(() => {}),
    ctx.abortSignal,
    'coordinate'
  )
  if (!guard.allowed) return { success: false, error: `computer.rightClick blocked: ${guard.reason}` }
  return { success: true, data: { x: p.x, y: p.y, button: 'right' } }
})

reg.register({
  name: 'computer.drag',
  description: 'Click and drag from one point to another. REQUIRES pid and hwnd. Verifies foreground window before dragging.',
  parameters: {
    type: 'object',
    properties: {
      fromX:       { type: 'number' }, fromY: { type: 'number' },
      toX:         { type: 'number' }, toY:   { type: 'number' },
      pid:         { type: 'number', description: 'REQUIRED. Process ID of the target window.' },
      hwnd:        { type: 'number', description: 'REQUIRED. Native window handle.' },
      windowTitle: { type: 'string', description: 'Optional secondary evidence.' }
    },
    required: ['fromX', 'fromY', 'toX', 'toY', 'pid', 'hwnd']
  },
  riskLevel: 'medium', reversible: true, category: 'computer'
}, async (p, ctx) => {
  const pid  = p.pid  as number | undefined
  const hwnd = p.hwnd as number | undefined
  if (!pid)  return { success: false, error: 'computer.drag: target_required — pid is mandatory.' }
  if (!hwnd) return { success: false, error: 'computer.drag: target_required — hwnd is mandatory.' }
  const target = { pid, hwnd, title: p.windowTitle as string | undefined }
  const guard = await focus.focusGuardedType(
    target,
    () => desktop.drag(p.fromX as number, p.fromY as number, p.toX as number, p.toY as number).then(() => {}),
    ctx.abortSignal,
    'coordinate'
  )
  if (!guard.allowed) return { success: false, error: `computer.drag blocked: ${guard.reason}` }
  return { success: true, data: { from: { x: p.fromX, y: p.fromY }, to: { x: p.toX, y: p.toY } } }
})

reg.register({
  name: 'computer.scroll',
  description: 'Scroll the mouse wheel at (x, y).',
  parameters: {
    type: 'object',
    properties: {
      x:         { type: 'number' },
      y:         { type: 'number' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount:    { type: 'number', description: 'Number of scroll steps. Default: 3.' }
    },
    required: ['x', 'y', 'direction']
  },
  riskLevel: 'low', reversible: true, category: 'computer'
}, async (p) => {
  const r = await desktop.scroll(p.x as number, p.y as number, p.direction as 'up' | 'down' | 'left' | 'right', p.amount as number | undefined)
  return { success: true, data: r }
})

reg.register({
  name: 'computer.windowsByPid',
  description: 'List all visible top-level windows owned by a specific PID using Win32 EnumWindows. ' +
    'NOTE: on Windows 11, single-instance apps (e.g. Notepad) route new windows to an existing host process. ' +
    'The launcher PID from process.start may own zero windows. ' +
    'Use computer.windowByTitleDiff instead when the launcher PID is unknown or may differ from the window owner.',
  parameters: {
    type: 'object',
    properties: {
      pid: { type: 'number', description: 'Process ID to enumerate windows for.' }
    },
    required: ['pid']
  },
  riskLevel: 'low', reversible: true, category: 'computer'
}, async (p) => {
  const r = await desktop.windowsByPid(p.pid as number)
  return { success: true, data: r }
})

reg.register({
  name: 'computer.windowByTitleDiff',
  description: 'Find a newly appeared visible window by title substring using Win32 EnumWindows, ' +
    'excluding a baseline set of HWNDs captured before launch. ' +
    'Returns the real owner PID and HWND regardless of which process launched the app. ' +
    'Use after process.start when the launcher PID may differ from the window-owner PID (e.g. Windows 11 Notepad). ' +
    'Call computer.snapshotHwnds before launching to get the baseline, then call this after launch.',
  parameters: {
    type: 'object',
    properties: {
      titleSubstring:  { type: 'string',  description: 'Title substring to match (regex-safe).' },
      baselineHwnds:   { type: 'array', items: { type: 'number' }, description: 'Array of HWND integers present before launch. Exclude these from results.' }
    },
    required: ['titleSubstring']
  },
  riskLevel: 'low', reversible: true, category: 'computer'
}, async (p) => {
  const baseline = new Set<number>((p.baselineHwnds as number[] | undefined) ?? [])
  const r = await desktop.windowByTitleDiff(p.titleSubstring as string, baseline)
  return { success: r !== null, data: r }
})

reg.register({
  name: 'computer.snapshotHwnds',
  description: 'Snapshot all current visible top-level window HWNDs using Win32 EnumWindows. ' +
    'Call before launching a process, then pass the result as baselineHwnds to computer.windowByTitleDiff.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'computer'
}, async () => {
  // windowByTitleDiff with empty string matches all visible windows; we just want their HWNDs
  const all = await desktop.windowByTitleDiff('', new Set())
  // That only returns the first match — use windowsByPid with a broad approach:
  // call the underlying Win32 snapshot by querying all windows via windowList
  // windowList uses UIAutomation which may miss some; use a dedicated PS call instead.
  const { spawn: sp } = require('child_process') as typeof import('child_process')
  const os2 = require('os') as typeof import('os')
  const fs2 = require('fs') as typeof import('fs')
  const path2 = require('path') as typeof import('path')
  const script = `
    Add-Type @"
      using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
      public static class SNPH {
        public delegate bool EWP(IntPtr h, IntPtr l);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EWP cb, IntPtr l);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern int  GetWindowThreadProcessId(IntPtr h, out int p);
        public static List<long> All() {
          var r = new List<long>();
          EnumWindows((h, l) => { if (IsWindowVisible(h)) { int p2=0; GetWindowThreadProcessId(h,out p2); r.Add(h.ToInt64()); } return true; }, IntPtr.Zero);
          return r;
        }
      }
"@
    $hwnds = [SNPH]::All()
    $hwnds -join ','
  `
  const tmp = path2.join(os2.tmpdir(), 'goga-snap-' + Date.now() + '.ps1')
  fs2.writeFileSync(tmp, script, 'utf8')
  const hwnds: number[] = await new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    const proc = sp('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp], { windowsHide: true })
    proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { err += d.toString() })
    proc.on('close', code => {
      try { fs2.unlinkSync(tmp) } catch {}
      if (err || code !== 0) {
        plannerDiagnostic('windows.baseline.enumeration_error', { exitCode: code, stderr: err.trim() })
        reject(new WindowDiscoveryError('enumeration', err.trim() || `Baseline helper exited with code ${code}`))
        return
      }
      const tokens = out.trim().split(',')
      if (out.trim() && tokens.some(t => !/^\d+$/.test(t) || !Number.isSafeInteger(Number(t)))) {
        plannerDiagnostic('windows.baseline.parsing_error', { raw: out })
        reject(new WindowDiscoveryError('parsing', 'Invalid baseline HWND output'))
        return
      }
      resolve(tokens.map(Number).filter(n => !isNaN(n) && n !== 0))
    })
    proc.on('error', e => {
      try { fs2.unlinkSync(tmp) } catch {}
      plannerDiagnostic('windows.baseline.enumeration_error', { error: e.message })
      reject(new WindowDiscoveryError('enumeration', e.message))
    })
  })
  plannerDiagnostic('windows.baseline', { hwnds })
  return { success: true, data: { hwnds } }
})

reg.register({
  name: 'computer.type',
  description: 'Type text into a specific window. REQUIRES both pid (process ID) and hwnd (native window handle). ' +
    'Before any keystroke, verifies the foreground window matches both pid and hwnd exactly. ' +
    'Use computer.windowsByPid after launching a process to obtain the exact hwnd. ' +
    'If pid or hwnd is absent/zero, returns target_required and sends zero keystrokes. ' +
    'If the foreground pid or hwnd does not match, returns focus_lost and sends zero keystrokes. ' +
    'Never falls back to typing into the current foreground window.',
  parameters: {
    type: 'object',
    properties: {
      text:        { type: 'string', description: 'Text to type.' },
      pid:         { type: 'number', description: 'REQUIRED. Process ID of the target window.' },
      hwnd:        { type: 'number', description: 'REQUIRED. Native window handle (HWND). Obtain via computer.windowsByPid. Must match the foreground window exactly.' },
      windowTitle: { type: 'string', description: 'Optional secondary evidence. Title substring of the target window.' }
    },
    required: ['text', 'pid', 'hwnd']
  },
  riskLevel: 'medium', reversible: true, category: 'computer'
}, async (p, ctx) => {
  const pid  = p.pid  as number | undefined
  const hwnd = p.hwnd as number | undefined
  if (!pid) {
    return { success: false, error: 'computer.type: target_required — pid is mandatory.' }
  }
  if (!hwnd) {
    return { success: false, error: 'computer.type: target_required — hwnd is mandatory. Use computer.windowsByPid to obtain it.' }
  }
  const target = { pid, hwnd, title: p.windowTitle as string | undefined }
  const guard = await focus.focusGuardedType(
    target,
    () => desktop.typeText(p.text as string).then(() => {}),
    ctx.abortSignal,
    'input'
  )
  if (!guard.allowed) {
    return { success: false, error: `computer.type blocked: ${guard.reason}` }
  }
  return { success: true, data: { typed: p.text } }
})

reg.register({
  name: 'computer.key',
  description: 'Press a single key by name (e.g. Enter, Escape, Tab, F5, Delete, Home, End, PageUp, PageDown, Left, Right, Up, Down). ' +
    'REQUIRES pid and hwnd. Verifies foreground window matches both before sending any keystroke.',
  parameters: {
    type: 'object',
    properties: {
      key:         { type: 'string', description: 'Key name matching nut-js Key enum.' },
      pid:         { type: 'number', description: 'REQUIRED. Process ID of the target window.' },
      hwnd:        { type: 'number', description: 'REQUIRED. Native window handle.' },
      windowTitle: { type: 'string', description: 'Optional secondary evidence.' }
    },
    required: ['key', 'pid', 'hwnd']
  },
  riskLevel: 'medium', reversible: true, category: 'computer'
}, async (p, ctx) => {
  const pid  = p.pid  as number | undefined
  const hwnd = p.hwnd as number | undefined
  if (!pid)  return { success: false, error: 'computer.key: target_required — pid is mandatory.' }
  if (!hwnd) return { success: false, error: 'computer.key: target_required — hwnd is mandatory.' }
  const target = { pid, hwnd, title: p.windowTitle as string | undefined }
  const guard = await focus.focusGuardedType(
    target,
    () => desktop.pressKey(p.key as string).then(() => {}),
    ctx.abortSignal,
    'input'
  )
  if (!guard.allowed) return { success: false, error: `computer.key blocked: ${guard.reason}` }
  return { success: true, data: { key: p.key } }
})

reg.register({
  name: 'computer.shortcut',
  description: 'Press a keyboard shortcut (multiple keys simultaneously). E.g. ["LeftControl","C"] for Ctrl+C. ' +
    'REQUIRES pid and hwnd. Verifies foreground window matches both before sending any keystroke.',
  parameters: {
    type: 'object',
    properties: {
      keys:        { type: 'array', items: { type: 'string' }, description: 'Array of key names to press together.' },
      pid:         { type: 'number', description: 'REQUIRED. Process ID of the target window.' },
      hwnd:        { type: 'number', description: 'REQUIRED. Native window handle.' },
      windowTitle: { type: 'string', description: 'Optional secondary evidence.' }
    },
    required: ['keys', 'pid', 'hwnd']
  },
  riskLevel: 'medium', reversible: true, category: 'computer'
}, async (p, ctx) => {
  const pid  = p.pid  as number | undefined
  const hwnd = p.hwnd as number | undefined
  if (!pid)  return { success: false, error: 'computer.shortcut: target_required — pid is mandatory.' }
  if (!hwnd) return { success: false, error: 'computer.shortcut: target_required — hwnd is mandatory.' }
  const target = { pid, hwnd, title: p.windowTitle as string | undefined }
  const guard = await focus.focusGuardedType(
    target,
    () => desktop.shortcut(p.keys as string[]).then(() => {}),
    ctx.abortSignal,
    'input'
  )
  if (!guard.allowed) return { success: false, error: `computer.shortcut blocked: ${guard.reason}` }
  return { success: true, data: { keys: p.keys } }
})

reg.register({
  name: 'computer.clipboard.read',
  description: 'Read the current clipboard text content.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'medium', reversible: true, category: 'computer'
}, async () => {
  const r = await desktop.clipboardRead()
  return { success: true, data: r }
})

reg.register({
  name: 'computer.clipboard.write',
  description: 'Write text to the clipboard.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text']
  },
  riskLevel: 'medium', reversible: true, category: 'computer'
}, async (p) => {
  const r = await desktop.clipboardWrite(p.text as string)
  return { success: true, data: r }
})

const focus = FocusManager.getInstance()

reg.register({
  name: 'computer.wait',
  description: 'Wait for a window or UI element to appear or disappear. Polls at 400ms intervals. Respects AbortSignal for immediate cancellation. Max duration 60s.',
  parameters: {
    type: 'object',
    properties: {
      type:         { type: 'string', enum: ['window', 'element', 'element_gone'], description: 'What to wait for.' },
      windowTitle:  { type: 'string', description: 'Window title substring to match.' },
      name:         { type: 'string', description: 'UI element name substring.' },
      role:         { type: 'string', description: 'UI element role (e.g. Button, Edit).' },
      automationId: { type: 'string', description: 'UIAutomation AutomationId.' },
      timeoutMs:    { type: 'number', description: 'Max wait in ms. Default: 10000. Max: 60000.' }
    },
    required: ['type']
  },
  riskLevel: 'low', reversible: true, category: 'computer'
}, async (p, ctx) => {
  const timeoutMs = Math.min(Number(p.timeoutMs ?? 10_000), 60_000)
  if (!['window', 'element', 'element_gone'].includes(p.type as string)) {
    return { success: false, error: `computer.wait: invalid type "${p.type}". Must be window|element|element_gone` }
  }
  const log = (await import('../services/logs')).LogService.getInstance()
  log.info(`computer.wait: type=${p.type} windowTitle=${p.windowTitle ?? ''} name=${p.name ?? ''} timeout=${timeoutMs}ms`)
  const r = await desktop.wait(
    {
      type: p.type as 'window' | 'element' | 'element_gone',
      windowTitle:  p.windowTitle  as string | undefined,
      name:         p.name         as string | undefined,
      role:         p.role         as string | undefined,
      automationId: p.automationId as string | undefined,
      timeoutMs
    },
    ctx.abortSignal
  )
  log.info(`computer.wait: result found=${r.found} timedOut=${r.timedOut}`)
  return { success: r.found, data: r, error: r.timedOut ? `Timed out after ${timeoutMs}ms` : undefined }
})

reg.register({
  name: 'computer.focus.state',
  description: 'Read current focus state: active window title/PID and focused accessibility element. No side effects.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'computer'
}, async (_p, ctx) => {
  const r = await focus.getFocusState()
  return { success: true, data: r }
})

reg.register({
  name: 'computer.focus.window',
  description: 'Bring a window to the foreground by title substring or PID. Handles minimized windows. Verifies via active-window state — does not trust SetForegroundWindow return value alone. Returns confidence score and verifiedBy sources.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Partial window title to match.' },
      pid:   { type: 'number', description: 'Process ID.' }
    }
  },
  riskLevel: 'medium', reversible: true, category: 'computer'
}, async (p, ctx) => {
  const r = await focus.focusWindow(
    { title: p.title as string | undefined, pid: p.pid as number | undefined },
    ctx.abortSignal
  )
  return { success: r.success, data: r, error: r.error }
})

reg.register({
  name: 'computer.focus.element',
  description: 'Focus a specific accessibility element inside a window. Uses UIAutomation InvokePattern — no coordinate clicks. Verifies via accessibility tree focused node. Returns confidence score and verifiedBy sources.',
  parameters: {
    type: 'object',
    properties: {
      windowTitle:  { type: 'string', description: 'Partial title of the host window.' },
      name:         { type: 'string', description: 'Partial element name.' },
      role:         { type: 'string', description: 'Element role (e.g. Edit, Button).' },
      automationId: { type: 'string', description: 'UIAutomation AutomationId.' }
    }
  },
  riskLevel: 'medium', reversible: true, category: 'computer'
}, async (p, ctx) => {
  const r = await focus.focusElement({
    windowTitle:  p.windowTitle as string | undefined,
    name:         p.name as string | undefined,
    role:         p.role as string | undefined,
    automationId: p.automationId as string | undefined
  }, ctx.abortSignal)
  return { success: r.success, data: r, error: r.error }
})

reg.register({
  name: 'computer.focus.ensure',
  description: 'Inspect current focus and act only if needed. Least-invasive: checks first, restores window if drifted, invokes element if required. Use this before any keyboard/input action. Returns confidence score and verifiedBy sources.',
  parameters: {
    type: 'object',
    properties: {
      windowTitle:  { type: 'string', description: 'Expected active window (partial title).' },
      name:         { type: 'string', description: 'Expected focused element name.' },
      role:         { type: 'string', description: 'Expected focused element role.' },
      automationId: { type: 'string', description: 'Expected focused element AutomationId.' }
    }
  },
  riskLevel: 'low', reversible: true, category: 'computer'
}, async (p, ctx) => {
  const r = await focus.ensureFocus({
    windowTitle:  p.windowTitle as string | undefined,
    name:         p.name as string | undefined,
    role:         p.role as string | undefined,
    automationId: p.automationId as string | undefined
  }, ctx.abortSignal)
  return { success: r.success, data: r, error: r.error }
})

reg.register({
  name: 'computer.listMonitors',
  description:
    'Enumerate all connected monitors with their bounds, primary flag, scale factor, and device name. ' +
    'Bounds are in virtual-desktop coordinates — negative x/y is valid for monitors positioned left or above the primary. ' +
    'scaleFactor = effectiveDpi/96 (1.0=100%, 1.25=125%, 1.5=150%, 2.0=200%). ' +
    'Screenshot pixels are physical; mouse input coordinates are logical. ' +
    'Pixel-to-input conversion: inputX = monitor.bounds.x + round(pixelOffsetX / scaleFactor). ' +
    'WARNING: cross-monitor clicking is not yet end-to-end verified. Use for read-only enumeration and screenshots only. ' +
    'Also returns virtualDesktop bounds (left/top may be negative) spanning all monitors.',
  parameters: { type: 'object', properties: {} },
  riskLevel: 'low', reversible: true, category: 'computer'
}, async () => {
  const r = await desktop.listMonitors()
  return { success: true, data: r }
})

reg.register({
  name: 'computer.readScreenText',
  description:
    'Read a rectangle of the screen as plain text using Windows OCR — no vision model, no network. ' +
    'Give the region in logical screen pixels (the same space computer.click uses); omit it to read the whole primary screen. ' +
    'Returns the recognised text, its lines, and the region that was read. Use this instead of vision.analyze when you need exact wording, ' +
    'numbers, error messages or table values rather than a description of the screen.',
  parameters: {
    type: 'object',
    properties: {
      x:      { type: 'number', description: 'Left edge in logical screen pixels. Default: 0.' },
      y:      { type: 'number', description: 'Top edge in logical screen pixels. Default: 0.' },
      width:  { type: 'number', description: 'Region width in logical pixels. Default: the primary screen width.' },
      height: { type: 'number', description: 'Region height in logical pixels. Default: the primary screen height.' }
    }
  },
  riskLevel: 'low', reversible: true, category: 'computer'
}, async (p) => {
  let region = {
    x: p.x as number | undefined,
    y: p.y as number | undefined,
    width: p.width as number | undefined,
    height: p.height as number | undefined
  }
  // No region given: read the primary display, whose bounds come from the same monitor enumeration
  // the click coordinates use, so the default region lines up with what the user sees.
  if (region.width === undefined || region.height === undefined) {
    const monitors = await desktop.listMonitors()
    const primary = monitors.monitors.find(m => m.primary) ?? monitors.monitors[0]
    if (primary) {
      region = {
        x: region.x ?? primary.bounds.x,
        y: region.y ?? primary.bounds.y,
        width: region.width ?? primary.bounds.width,
        height: region.height ?? primary.bounds.height
      }
    }
  }
  const r = await desktop.readScreenText(region)
  return { success: true, data: r }
})

// ── Compound in-app actions ─────────────────────────────────────────────────
//
// "type X into Word" / "click Save in Notepad" used to narrate or mis-fire because the model
// had to chain window-discovery → focus → keystroke itself and rarely got the pid+hwnd right,
// so keystrokes could land in the wrong window. These two tools do the whole chain in one call,
// through the SAME focus guard as computer.type/click: they resolve the window by title, bring
// it to the foreground, and only then act — sending zero input if the wrong window is in front.

reg.register({
  name: 'computer.typeIntoApp',
  description: 'Type text into a named application window in ONE step: resolves the window by a title substring, brings it to the foreground, verifies focus, then types under the same focus guard as computer.type (zero keystrokes if the wrong window is in front). Use this for "type X into <app>" so keystrokes cannot land in the wrong window. Open the app first with process.start if it is not running. Reversible: only types text.',
  parameters: {
    type: 'object',
    properties: {
      text:  { type: 'string', description: 'The text to type.' },
      title: { type: 'string', description: 'A substring of the target window title, e.g. "Notepad", "Word", "Untitled".' }
    },
    required: ['text', 'title']
  },
  riskLevel: 'medium', reversible: true, category: 'computer'
}, async (p, ctx) => {
  const title = String(p.title ?? '').trim()
  const text = String(p.text ?? '')
  if (!title) return { success: false, error: 'computer.typeIntoApp: title is required to find the target window.' }
  const win = await desktop.windowByTitleDiff(title, new Set())
  if (!win) return { success: false, error: `computer.typeIntoApp: no visible window whose title contains "${title}". Open the app first (process.start), then retry.` }
  const focused = await focus.focusWindow({ title, pid: win.pid }, ctx.abortSignal)
  if (!focused.success) return { success: false, error: `computer.typeIntoApp: could not bring "${win.title}" to the foreground (${focused.error ?? focused.action}); nothing was typed.` }
  const guard = await focus.focusGuardedType(
    { pid: win.pid, hwnd: win.hwnd, title: win.title },
    () => desktop.typeText(text).then(() => {}),
    ctx.abortSignal,
    'input'
  )
  if (!guard.allowed) return { success: false, error: `computer.typeIntoApp blocked: ${guard.reason}; nothing was typed.` }
  return { success: true, data: { typed: text, window: win.title, pid: win.pid, hwnd: win.hwnd } }
})

reg.register({
  name: 'computer.clickInApp',
  description: 'Click a named control inside a named application window in ONE step: resolves the window by a title substring, brings it to the foreground, finds the control by its visible label (UIAutomation), then clicks its centre under the same focus guard as computer.click (no click if the wrong window is in front). Use this for "click <label> in <app>". Open the app first if it is not running.',
  parameters: {
    type: 'object',
    properties: {
      label: { type: 'string', description: 'The visible name of the control to click, e.g. "Save", "OK", "File".' },
      title: { type: 'string', description: 'A substring of the target window title, e.g. "Notepad", "Word".' },
      role:  { type: 'string', description: 'Optional role to disambiguate, e.g. "Button", "MenuItem".' }
    },
    required: ['label', 'title']
  },
  riskLevel: 'medium', reversible: false, category: 'computer'
}, async (p, ctx) => {
  const title = String(p.title ?? '').trim()
  const label = String(p.label ?? '').trim()
  if (!title) return { success: false, error: 'computer.clickInApp: title is required to find the target window.' }
  if (!label) return { success: false, error: 'computer.clickInApp: label is required to find the control.' }
  const win = await desktop.windowByTitleDiff(title, new Set())
  if (!win) return { success: false, error: `computer.clickInApp: no visible window whose title contains "${title}". Open the app first, then retry.` }
  const focused = await focus.focusWindow({ title, pid: win.pid }, ctx.abortSignal)
  if (!focused.success) return { success: false, error: `computer.clickInApp: could not foreground "${win.title}" (${focused.error ?? focused.action}); nothing was clicked.` }
  const elements = await desktop.uiElements(win.title)
  const wantRole = String(p.role ?? '').trim().toLowerCase()
  const norm = (s: string) => s.trim().toLowerCase()
  const roleOk = (e: typeof elements[number]) => !wantRole || norm(e.role) === wantRole
  const match = elements.find(e => e.enabled && norm(e.name) === norm(label) && roleOk(e))
    ?? elements.find(e => e.enabled && norm(e.name).includes(norm(label)) && roleOk(e))
  if (!match) return { success: false, error: `computer.clickInApp: no enabled control named "${label}"${wantRole ? ` (role ${wantRole})` : ''} in "${win.title}". Call computer.uiElements to see what is there.` }
  const cx = Math.round(match.x + match.width / 2)
  const cy = Math.round(match.y + match.height / 2)
  const guard = await focus.focusGuardedType(
    { pid: win.pid, hwnd: win.hwnd, title: win.title },
    () => desktop.click(cx, cy, 'left').then(() => {}),
    ctx.abortSignal,
    'coordinate'
  )
  if (!guard.allowed) return { success: false, error: `computer.clickInApp blocked: ${guard.reason}; nothing was clicked.` }
  return { success: true, data: { clicked: match.name, role: match.role, x: cx, y: cy, window: win.title } }
})

export function registerComputerTools() {
  // Side-effect: all registrations above run on import
  return ToolRegistry.getInstance()
}
