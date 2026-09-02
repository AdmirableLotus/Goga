import type { ToolAdapter } from './base'
import screenshot from 'screenshot-desktop'
import { mouse, keyboard, Key, Button, straightTo, Point } from '@nut-tree-fork/nut-js'
import { spawn } from 'child_process'

export interface ScreenshotResult {
  base64: string
  width?: number
  height?: number
  timestamp: number
}

export interface ActiveWindowResult {
  title: string
  owner: string
  pid: number
  bounds?: { x: number; y: number; width: number; height: number }
}

export interface WindowInfo {
  title: string
  owner: string
  pid: number
  bounds?: { x: number; y: number; width: number; height: number }
}

export interface UIElement {
  name: string
  role: string
  x: number
  y: number
  width: number
  height: number
  value?: string
  enabled: boolean
}

export class DesktopAdapter implements ToolAdapter {
  readonly name = 'desktop'
  readonly enabled = true

  async execute(params: Record<string, unknown>): Promise<unknown> {
    const op = params.op as string
    switch (op) {
      case 'screenshot':    return this.screenshot(params.displayId as number | undefined)
      case 'moveCursor':    return this.moveCursor(params.x as number, params.y as number)
      case 'click':         return this.click(params.x as number, params.y as number, params.button as 'left' | 'right' | undefined)
      case 'doubleClick':   return this.doubleClick(params.x as number, params.y as number)
      case 'rightClick':    return this.click(params.x as number, params.y as number, 'right')
      case 'drag':          return this.drag(params.fromX as number, params.fromY as number, params.toX as number, params.toY as number)
      case 'scroll':        return this.scroll(params.x as number, params.y as number, params.direction as 'up' | 'down' | 'left' | 'right', params.amount as number | undefined)
      case 'typeText':      return this.typeText(params.text as string)
      case 'pressKey':      return this.pressKey(params.key as string)
      case 'shortcut':      return this.shortcut(params.keys as string[])
      case 'activeWindow':  return this.activeWindow()
      case 'windowList':    return this.windowList()
      case 'focusWindow':   return this.focusWindow(params.title as string | undefined, params.pid as number | undefined)
      case 'uiElements':    return this.uiElements(params.windowTitle as string | undefined)
      case 'listDisplays':  return this.listDisplays()
      case 'clipboardRead': return this.clipboardRead()
      case 'clipboardWrite':return this.clipboardWrite(params.text as string)
      default: throw new Error(`Unknown desktop op: ${op}`)
    }
  }

  async screenshot(displayId?: number): Promise<ScreenshotResult> {
    const opts = displayId !== undefined ? { screen: displayId } : {}
    const imgBuffer: Buffer = await screenshot(opts)
    return { base64: imgBuffer.toString('base64'), timestamp: Date.now() }
  }

  async moveCursor(x: number, y: number): Promise<{ x: number; y: number }> {
    await mouse.move(straightTo(new Point(x, y)))
    return { x, y }
  }

  async click(x: number, y: number, button: 'left' | 'right' = 'left'): Promise<{ x: number; y: number; button: string }> {
    await mouse.move(straightTo(new Point(x, y)))
    await mouse.click(button === 'right' ? Button.RIGHT : Button.LEFT)
    return { x, y, button }
  }

  async doubleClick(x: number, y: number): Promise<{ x: number; y: number }> {
    await mouse.move(straightTo(new Point(x, y)))
    await mouse.doubleClick(Button.LEFT)
    return { x, y }
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number): Promise<{ from: { x: number; y: number }; to: { x: number; y: number } }> {
    await mouse.move(straightTo(new Point(fromX, fromY)))
    await mouse.pressButton(Button.LEFT)
    await mouse.move(straightTo(new Point(toX, toY)))
    await mouse.releaseButton(Button.LEFT)
    return { from: { x: fromX, y: fromY }, to: { x: toX, y: toY } }
  }

  async scroll(x: number, y: number, direction: 'up' | 'down' | 'left' | 'right' = 'down', amount = 3): Promise<{ x: number; y: number; direction: string; amount: number }> {
    await mouse.move(straightTo(new Point(x, y)))
    if (direction === 'down') await mouse.scrollDown(amount)
    else if (direction === 'up') await mouse.scrollUp(amount)
    else if (direction === 'left') await mouse.scrollLeft(amount)
    else await mouse.scrollRight(amount)
    return { x, y, direction, amount }
  }

  async typeText(text: string): Promise<{ typed: string }> {
    await keyboard.type(text)
    return { typed: text }
  }

  async pressKey(keyName: string): Promise<{ key: string }> {
    const k = Key[keyName as keyof typeof Key]
    if (k === undefined) throw new Error(`Unknown key: ${keyName}`)
    await keyboard.pressKey(k)
    await keyboard.releaseKey(k)
    return { key: keyName }
  }

  async shortcut(keys: string[]): Promise<{ keys: string[] }> {
    const resolved = keys.map(k => {
      const key = Key[k as keyof typeof Key]
      if (key === undefined) throw new Error(`Unknown key: ${k}`)
      return key
    })
    await keyboard.pressKey(...resolved)
    await keyboard.releaseKey(...resolved)
    return { keys }
  }

  async activeWindow(): Promise<ActiveWindowResult> {
    const { default: activeWin } = await (new Function('return import("active-win")'))()
    const win = await activeWin()
    if (!win) return { title: '', owner: '', pid: 0 }
    return { title: win.title, owner: win.owner.name, pid: win.owner.processId, bounds: win.bounds }
  }

  async windowList(): Promise<WindowInfo[]> {
    const { default: activeWin } = await (new Function('return import("active-win")'))()
    const wins: WindowInfo[] = []
    // active-win doesn't enumerate all windows; use PowerShell for that
    const ps = `
      Add-Type -AssemblyName UIAutomationClient
      [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition
      ) | ForEach-Object {
        $b = $_.Current.BoundingRectangle
        [PSCustomObject]@{
          title = $_.Current.Name
          pid   = $_.Current.ProcessId
          x     = [int]$b.X; y = [int]$b.Y
          w     = [int]$b.Width; h = [int]$b.Height
        }
      } | ConvertTo-Json -Compress
    `
    const raw = await this.runPS(ps)
    try {
      const parsed = JSON.parse(raw)
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      for (const w of arr) {
        if (w.title) wins.push({ title: w.title, owner: '', pid: w.pid, bounds: { x: w.x, y: w.y, width: w.w, height: w.h } })
      }
    } catch { /* fallback: return active window only */ }
    if (wins.length === 0) {
      const active = await this.activeWindow()
      if (active.title) wins.push(active)
    }
    return wins
  }

  async focusWindow(title?: string, pid?: number): Promise<{ focused: boolean; title: string }> {
    const condition = pid ? `$_.Current.ProcessId -eq ${pid}` : `$_.Current.Name -like '*${(title ?? '').replace(/'/g, "''")}*'`
    const ps = `
      Add-Type -AssemblyName UIAutomationClient
      $win = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition
      ) | Where-Object { ${condition} } | Select-Object -First 1
      if ($win) {
        $hwnd = $win.Current.NativeWindowHandle
        Add-Type @"
          using System; using System.Runtime.InteropServices;
          public class W { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }
"@
        [W]::SetForegroundWindow([IntPtr]$hwnd)
        $win.Current.Name
      }
    `
    const result = await this.runPS(ps)
    return { focused: result.trim().length > 0, title: result.trim() }
  }

  async uiElements(windowTitle?: string): Promise<UIElement[]> {
    const scope = windowTitle
      ? `$root.FindFirst([System.Windows.Automation.TreeScope]::Children, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${windowTitle.replace(/'/g, "''")}')))`
      : `[System.Windows.Automation.AutomationElement]::FocusedElement.FindFirst([System.Windows.Automation.TreeScope]::Ancestors, [System.Windows.Automation.Condition]::TrueCondition)`
    const ps = `
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      $window = ${scope}
      if (-not $window) { $window = [System.Windows.Automation.AutomationElement]::FocusedElement }
      if (-not $window) { Write-Output '[]'; exit }
      $elements = $window.FindAll(
        [System.Windows.Automation.TreeScope]::Subtree,
        [System.Windows.Automation.Condition]::TrueCondition
      )
      $results = @()
      foreach ($el in $elements) {
        $b = $el.Current.BoundingRectangle
        if ($b.Width -gt 0 -and $b.Height -gt 0 -and $el.Current.Name -ne '') {
          $results += [PSCustomObject]@{
            name    = $el.Current.Name
            role    = $el.Current.ControlType.ProgrammaticName
            x       = [int]($b.X + $b.Width/2)
            y       = [int]($b.Y + $b.Height/2)
            width   = [int]$b.Width
            height  = [int]$b.Height
            value   = $el.Current.HelpText
            enabled = $el.Current.IsEnabled
          }
        }
      }
      $results | ConvertTo-Json -Compress
    `
    const raw = await this.runPS(ps)
    try {
      const parsed = JSON.parse(raw)
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      return arr.map((e: Record<string, unknown>) => ({
        name: String(e.name ?? ''),
        role: String(e.role ?? '').replace('ControlType.', ''),
        x: Number(e.x), y: Number(e.y),
        width: Number(e.width), height: Number(e.height),
        value: e.value ? String(e.value) : undefined,
        enabled: Boolean(e.enabled)
      }))
    } catch { return [] }
  }

  async listDisplays(): Promise<{ id: string | number; name: string }[]> {
    const displays = await screenshot.listDisplays()
    return displays.map(d => ({ id: d.id, name: d.name }))
  }

  async clipboardRead(): Promise<{ text: string }> {
    const text = await this.runPS('Get-Clipboard')
    return { text: text.trim() }
  }

  async clipboardWrite(text: string): Promise<{ written: boolean }> {
    const escaped = text.replace(/'/g, "''")
    await this.runPS(`Set-Clipboard -Value '${escaped}'`)
    return { written: true }
  }

  private runPS(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let out = ''
      let err = ''
      const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
      proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
      proc.stderr.on('data', (d: Buffer) => { err += d.toString() })
      proc.on('close', code => {
        if (code !== 0 && err) reject(new Error(err.trim()))
        else resolve(out)
      })
      proc.on('error', reject)
    })
  }
}
