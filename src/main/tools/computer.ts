import { ToolRegistry } from './registry'
import type { ToolResult } from './registry'
import { DesktopAdapter } from '../adapters/desktop'
import { FocusManager } from '../services/focusManager'

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
}, async () => {
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
}, async (p) => {
  const r = await desktop.uiElements(p.windowTitle as string | undefined)
  return { success: true, data: r }
})

reg.register({
  name: 'computer.click',
  description: 'Move the mouse to (x, y) and click. Use computer.uiElements to find coordinates first.',
  parameters: {
    type: 'object',
    properties: {
      x:      { type: 'number', description: 'Screen X coordinate.' },
      y:      { type: 'number', description: 'Screen Y coordinate.' },
      button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button. Default: left.' }
    },
    required: ['x', 'y']
  },
  riskLevel: 'medium', reversible: true, category: 'computer'
}, async (p) => {
  const r = await desktop.click(p.x as number, p.y as number, p.button as 'left' | 'right' | undefined)
  return { success: true, data: r }
})

reg.register({
  name: 'computer.doubleClick',
  description: 'Double-click at (x, y).',
  parameters: {
    type: 'object',
    properties: {
      x: { type: 'number' }, y: { type: 'number' }
    },
    required: ['x', 'y']
  },
  riskLevel: 'medium', reversible: true, category: 'computer'
}, async (p) => {
  const r = await desktop.doubleClick(p.x as number, p.y as number)
  return { success: true, data: r }
})

reg.register({
  name: 'computer.rightClick',
  description: 'Right-click at (x, y) to open a context menu.',
  parameters: {
    type: 'object',
    properties: { x: { type: 'number' }, y: { type: 'number' } },
    required: ['x', 'y']
  },
  riskLevel: 'medium', reversible: true, category: 'computer'
}, async (p) => {
  const r = await desktop.click(p.x as number, p.y as number, 'right')
  return { success: true, data: r }
})

reg.register({
  name: 'computer.drag',
  description: 'Click and drag from one point to another.',
  parameters: {
    type: 'object',
    properties: {
      fromX: { type: 'number' }, fromY: { type: 'number' },
      toX:   { type: 'number' }, toY:   { type: 'number' }
    },
    required: ['fromX', 'fromY', 'toX', 'toY']
  },
  riskLevel: 'medium', reversible: true, category: 'computer'
}, async (p) => {
  const r = await desktop.drag(p.fromX as number, p.fromY as number, p.toX as number, p.toY as number)
  return { success: true, data: r }
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
  name: 'computer.type',
  description: 'Type a string of text using the keyboard.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Text to type.' } },
    required: ['text']
  },
  riskLevel: 'medium', reversible: true, category: 'computer'
}, async (p) => {
  const r = await desktop.typeText(p.text as string)
  return { success: true, data: r }
})

reg.register({
  name: 'computer.key',
  description: 'Press a single key by name (e.g. Enter, Escape, Tab, F5, Delete, Home, End, PageUp, PageDown, Left, Right, Up, Down).',
  parameters: {
    type: 'object',
    properties: { key: { type: 'string', description: 'Key name matching nut-js Key enum.' } },
    required: ['key']
  },
  riskLevel: 'medium', reversible: true, category: 'computer'
}, async (p) => {
  const r = await desktop.pressKey(p.key as string)
  return { success: true, data: r }
})

reg.register({
  name: 'computer.shortcut',
  description: 'Press a keyboard shortcut (multiple keys simultaneously). E.g. ["LeftControl","C"] for Ctrl+C.',
  parameters: {
    type: 'object',
    properties: {
      keys: { type: 'array', items: { type: 'string' }, description: 'Array of key names to press together.' }
    },
    required: ['keys']
  },
  riskLevel: 'medium', reversible: true, category: 'computer'
}, async (p) => {
  const r = await desktop.shortcut(p.keys as string[])
  return { success: true, data: r }
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

export function registerComputerTools() {
  // Side-effect: all registrations above run on import
  return ToolRegistry.getInstance()
}
