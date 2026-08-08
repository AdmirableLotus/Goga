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
      case 'snapshot':      return this.snapshot(params.includeUiTree as boolean | undefined)
      case 'accessibilityTree': return this.accessibilityTree(params.windowTitle as string | undefined, params.maxDepth as number | undefined)
      case 'findElement':   return this.findElement(params as { name?: string; role?: string; automationId?: string; windowTitle?: string })
      case 'invoke':        return this.invoke(params as { name?: string; role?: string; automationId?: string; windowTitle?: string })
      case 'setValue':      return this.setValue(params as { name?: string; role?: string; automationId?: string; windowTitle?: string }, params.value as string)
      case 'wait':          return this.wait(params as Parameters<DesktopAdapter['wait']>[0])
      case 'restoreWindow': return this.restoreWindow(params.pid as number)
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

  // â”€â”€ Phase A: Snapshot & Accessibility â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // ── Phase B: Window restore (used by FocusManager only) ──────────────────

  /** SW_RESTORE (9) — unminimizes without activating, so FocusManager
   *  can follow up with SetForegroundWindow cleanly. */
  async restoreWindow(pid: number): Promise<{ restored: boolean }> {
    const ps = `
      Add-Type @"
        using System; using System.Runtime.InteropServices;
        public class WinRestore {
          [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
        }
"@
      Add-Type -AssemblyName UIAutomationClient
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      $win = $null
      foreach($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)){
        if($w.Current.ProcessId -eq ${pid}){ $win = $w; break }
      }
      if ($win) {
        $hwnd = [IntPtr]$win.Current.NativeWindowHandle
        [WinRestore]::ShowWindow($hwnd, 9) | Out-Null
        Write-Output 'ok'
      } else { Write-Output 'not-found' }
    `
    const result = (await this.runPS(ps)).trim()
    return { restored: result === 'ok' }
  }

  async getCursorPos(): Promise<{ x: number; y: number }> {
    const ps = `
      Add-Type @"
        using System; using System.Runtime.InteropServices;
        public class CursorPos {
          [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
          public struct POINT { public int X; public int Y; }
        }
"@
      $p = New-Object CursorPos+POINT
      [CursorPos]::GetCursorPos([ref]$p) | Out-Null
      "$($p.X),$($p.Y)"
    `
    try {
      const raw = (await this.runPS(ps)).trim()
      const [x, y] = raw.split(',').map(Number)
      return { x: isNaN(x) ? 0 : x, y: isNaN(y) ? 0 : y }
    } catch { return { x: 0, y: 0 } }
  }

  async getScreenDimensions(): Promise<{ width: number; height: number }> {
    const ps = `
      Add-Type -AssemblyName System.Windows.Forms
      $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      "$($s.Width),$($s.Height)"
    `
    try {
      const raw = (await this.runPS(ps)).trim()
      const [width, height] = raw.split(',').map(Number)
      return { width: isNaN(width) ? 1920 : width, height: isNaN(height) ? 1080 : height }
    } catch { return { width: 1920, height: 1080 } }
  }

  async snapshot(includeUiTree = false): Promise<import('../../shared/types').DesktopSnapshot> {
    // Run all fast observations in parallel
    const [ss, activeWin, windows, cursor, screen] = await Promise.all([
      this.screenshot().catch(() => ({ base64: '', timestamp: Date.now() })),
      this.activeWindow().catch(() => ({ title: '', owner: '', pid: 0 })),
      this.windowList().catch(() => []),
      this.getCursorPos().catch(() => ({ x: 0, y: 0 })),
      this.getScreenDimensions().catch(() => ({ width: 1920, height: 1080 })),
    ])

    const snap: import('../../shared/types').DesktopSnapshot = {
      timestamp: Date.now(),
      screenWidth: screen.width,
      screenHeight: screen.height,
      cursorX: cursor.x,
      cursorY: cursor.y,
      activeWindow: {
        title: activeWin.title,
        owner: activeWin.owner,
        pid: activeWin.pid,
        bounds: (activeWin as ActiveWindowResult).bounds ?? { x: 0, y: 0, width: 0, height: 0 }
      },
      visibleWindows: windows.map(w => ({
        title: w.title, owner: w.owner, pid: w.pid,
        bounds: w.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
      }))
    }

    if (includeUiTree) {
      snap.uiTree = await this.accessibilityTree().catch(() => [])
      // Find focused element
      const focused = this.findFocused(snap.uiTree)
      if (focused) snap.focusedElement = { automationId: focused.automationId, name: focused.name, role: focused.role }
    }

    return snap
  }

  private findFocused(nodes: import('../../shared/types').AccessibilityNode[]): import('../../shared/types').AccessibilityNode | undefined {
    for (const n of nodes) {
      if (n.focused) return n
      if (n.children) {
        const found = this.findFocused(n.children)
        if (found) return found
      }
    }
    return undefined
  }

  async accessibilityTree(windowTitle?: string, maxDepth = 4): Promise<import('../../shared/types').AccessibilityNode[]> {
    const winSelect = windowTitle
      ? `$win = $null; foreach($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)){ $wb=$w.Current.BoundingRectangle; if($w.Current.Name -like '*${windowTitle.replace(/'/g, "''")}*' -and -not [double]::IsInfinity($wb.X) -and $wb.Width -gt 0){ $win = $w; break } }`
      : `$win = [System.Windows.Automation.AutomationElement]::FocusedElement`

    const ps = `
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      ${winSelect}
      if (-not $win) { $win = [System.Windows.Automation.AutomationElement]::FocusedElement }
      if (-not $win) { Write-Output '[]'; exit }

      function Get-Node($el, $depth) {
        if ($depth -gt ${maxDepth}) { return $null }
        $b = $el.Current.BoundingRectangle
        # Skip elements with invalid/infinite bounds (off-screen virtual elements)
        if ([double]::IsInfinity($b.X) -or [double]::IsNaN($b.X) -or $b.Width -lt 0) { return $null }
        $cx = if($b.Width -gt 0){ [int]($b.X + $b.Width/2) } else { 0 }
        $cy = if($b.Height -gt 0){ [int]($b.Y + $b.Height/2) } else { 0 }
        $val = try { [string]$el.GetCurrentPropertyValue([System.Windows.Automation.ValuePattern]::ValueProperty) } catch { $null }
        $node = [PSCustomObject]@{
          automationId = $el.Current.AutomationId
          name         = $el.Current.Name
          role         = $el.Current.ControlType.ProgrammaticName -replace 'ControlType\.',''
          x            = $cx
          y            = $cy
          width        = [int][Math]::Max(0, [Math]::Min($b.Width, 9999))
          height       = [int][Math]::Max(0, [Math]::Min($b.Height, 9999))
          value        = $val
          enabled      = $el.Current.IsEnabled
          focused      = $el.Current.HasKeyboardFocus
          children     = @()
        }
        $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($kid in $kids) {
          $child = Get-Node $kid ($depth + 1)
          if ($child) { $node.children += $child }
        }
        return $node
      }

      $tree = Get-Node $win 0
      if ($tree) { $tree | ConvertTo-Json -Depth 10 -Compress } else { Write-Output '[]' }
    `
    try {
      const raw = await this.runPS(ps)
      const parsed = JSON.parse(raw.trim() || '[]')
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      return arr.map((n: Record<string, unknown>) => this.mapNode(n))
    } catch { return [] }
  }

  private mapNode(n: Record<string, unknown>): import('../../shared/types').AccessibilityNode {
    const children = Array.isArray(n.children)
      ? (n.children as Record<string, unknown>[]).map(c => this.mapNode(c))
      : []
    return {
      automationId: String(n.automationId ?? ''),
      name: String(n.name ?? ''),
      role: String(n.role ?? ''),
      bounds: {
        x: Number(n.x) - Math.floor(Number(n.width) / 2),
        y: Number(n.y) - Math.floor(Number(n.height) / 2),
        width: Number(n.width),
        height: Number(n.height)
      },
      value: n.value ? String(n.value) : undefined,
      enabled: Boolean(n.enabled),
      focused: Boolean(n.focused),
      children: children.length > 0 ? children : undefined
    }
  }

  async findElement(query: {
    name?: string
    role?: string
    automationId?: string
    windowTitle?: string
  }): Promise<import('../../shared/types').AccessibilityNode | null> {
    const conditions: string[] = []
    if (query.automationId) conditions.push(`$candidate.Current.AutomationId -eq '${query.automationId.replace(/'/g, "''")}' `)
    if (query.name)         conditions.push(`$candidate.Current.Name -like '*${query.name.replace(/'/g, "''")}*'`)
    if (query.role)         conditions.push(`$candidate.Current.ControlType.ProgrammaticName -like '*${query.role.replace(/'/g, "''")}*'`)

    if (conditions.length === 0) return null
    const where = conditions.join(' -and ')

    const winSelect = query.windowTitle
      ? `$win = $null; foreach($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)){ $wb=$w.Current.BoundingRectangle; if($w.Current.Name -like '*${query.windowTitle.replace(/'/g, "''")}*' -and -not [double]::IsInfinity($wb.X) -and $wb.Width -gt 0){ $win = $w; break } }`
      : `$win = [System.Windows.Automation.AutomationElement]::FocusedElement`

    const ps = `
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      ${winSelect}
      if (-not $win) { $win = $root }
      $el = $null
      foreach($candidate in $win.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition)){
        if(${where}){ $el = $candidate; break }
      }
      if ($el) {
        $b = $el.Current.BoundingRectangle
        $cx = if($b.Width -gt 0 -and -not [double]::IsInfinity($b.X)){ [int]($b.X + $b.Width/2) } else { 0 }
        $cy = if($b.Height -gt 0 -and -not [double]::IsInfinity($b.Y)){ [int]($b.Y + $b.Height/2) } else { 0 }
        $val = try { [string]$el.GetCurrentPropertyValue([System.Windows.Automation.ValuePattern]::ValueProperty) } catch { $null }
        [PSCustomObject]@{
          automationId = $el.Current.AutomationId
          name         = $el.Current.Name
          role         = $el.Current.ControlType.ProgrammaticName -replace 'ControlType\.',''
          x            = $cx
          y            = $cy
          width        = [int][Math]::Max(0,[Math]::Min($b.Width,9999))
          height       = [int][Math]::Max(0,[Math]::Min($b.Height,9999))
          value        = $val
          enabled      = $el.Current.IsEnabled
          focused      = $el.Current.HasKeyboardFocus
        } | ConvertTo-Json -Compress
      } else { Write-Output 'null' }
    `
    try {
      const raw = (await this.runPS(ps)).trim()
      if (!raw || raw === 'null') return null
      const n = JSON.parse(raw) as Record<string, unknown>
      return this.mapNode({ ...n, children: [] })
    } catch { return null }
  }

  // Trigger UIAutomation InvokePattern on an element â€” no coordinates needed
  // IMPORTANT: re-resolves element fresh every call â€” never uses stale IDs
  async invoke(query: { name?: string; role?: string; automationId?: string; windowTitle?: string }): Promise<{ invoked: boolean; element: string }> {
    const el = await this.findElement(query)
    if (!el) throw new Error(`invoke: element not found â€” ${JSON.stringify(query)}`)

    const idFilter = el.automationId
      ? `$candidate.Current.AutomationId -eq '${el.automationId.replace(/'/g, "''")}' `
      : `$candidate.Current.Name -eq '${el.name.replace(/'/g, "''")}' -and $candidate.Current.ControlType.ProgrammaticName -like '*${el.role}*'`

    const winSelectInvoke = query.windowTitle
      ? `$win = $null; foreach($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)){ $wb=$w.Current.BoundingRectangle; if($w.Current.Name -like '*${(query.windowTitle).replace(/'/g, "''")}*' -and -not [double]::IsInfinity($wb.X) -and $wb.Width -gt 0){ $win = $w; break } }`
      : `$win = [System.Windows.Automation.AutomationElement]::FocusedElement`

    const ps = `
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      ${winSelectInvoke}
      if (-not $win) { $win = $root }
      $el = $null
      foreach($candidate in $win.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition)){
        if(${idFilter}){ $el = $candidate; break }
      }
      if ($el) {
        try {
          $pattern = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
          $pattern.Invoke()
          Write-Output 'ok'
        } catch {
          # Fallback: simulate click at element center
          $b = $el.Current.BoundingRectangle
          $cx = [int]($b.X + $b.Width/2)
          $cy = [int]($b.Y + $b.Height/2)
          Add-Type @"
            using System; using System.Runtime.InteropServices;
            public class MouseClick {
              [DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);
            }
"@
          [MouseClick]::mouse_event(0x8001, $cx, $cy, 0, 0)  # MOUSEEVENTF_ABSOLUTE|LEFTDOWN
          [MouseClick]::mouse_event(0x8002, $cx, $cy, 0, 0)  # MOUSEEVENTF_ABSOLUTE|LEFTUP
          Write-Output 'click-fallback'
        }
      } else { Write-Output 'not-found' }
    `
    const result = (await this.runPS(ps)).trim()
    if (result === 'not-found') throw new Error(`invoke: element not found after re-resolve â€” ${JSON.stringify(query)}`)
    return { invoked: true, element: el.name }
  }

  // Set value via UIAutomation ValuePattern â€” more reliable than keyboard.type for form inputs
  // Re-resolves element fresh every call
  async setValue(query: { name?: string; role?: string; automationId?: string; windowTitle?: string }, value: string): Promise<{ set: boolean; element: string }> {
    const el = await this.findElement(query)
    if (!el) throw new Error(`setValue: element not found â€” ${JSON.stringify(query)}`)

    const idFilterSV = el.automationId
      ? `$candidate.Current.AutomationId -eq '${el.automationId.replace(/'/g, "''")}' `
      : `$candidate.Current.Name -eq '${el.name.replace(/'/g, "''")}' -and $candidate.Current.ControlType.ProgrammaticName -like '*${el.role}*'`

    const winSelectSV = query.windowTitle
      ? `$win = $null; foreach($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)){ $wb=$w.Current.BoundingRectangle; if($w.Current.Name -like '*${(query.windowTitle).replace(/'/g, "''")}*' -and -not [double]::IsInfinity($wb.X) -and $wb.Width -gt 0){ $win = $w; break } }`
      : `$win = [System.Windows.Automation.AutomationElement]::FocusedElement`

    const escaped = value.replace(/'/g, "''")
    const ps = `
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      ${winSelectSV}
      if (-not $win) { $win = $root }
      $el = $null
      foreach($candidate in $win.FindAll([System.Windows.Automation.TreeScope]::Subtree, [System.Windows.Automation.Condition]::TrueCondition)){
        if(${idFilterSV}){ $el = $candidate; break }
      }
      if ($el) {
        try {
          $pattern = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
          $pattern.SetValue('${escaped}')
          Write-Output 'ok'
        } catch {
          Write-Output "error: $_"
        }
      } else { Write-Output 'not-found' }
    `
    const result = (await this.runPS(ps)).trim()
    if (result === 'not-found') throw new Error(`setValue: element not found after re-resolve â€” ${JSON.stringify(query)}`)
    if (result.startsWith('error:')) throw new Error(`setValue failed: ${result}`)
    return { set: true, element: el.name }
  }

  // Poll for a condition with timeout and AbortSignal support
  async wait(condition: {
    type: 'element' | 'window' | 'element_gone'
    name?: string
    role?: string
    automationId?: string
    windowTitle?: string
    timeoutMs?: number
  }, abortSignal?: AbortSignal): Promise<{ found: boolean; timedOut: boolean }> {
    const timeout = condition.timeoutMs ?? 10_000
    const interval = 400
    const start = Date.now()

    while (Date.now() - start < timeout) {
      if (abortSignal?.aborted) return { found: false, timedOut: false }

      if (condition.type === 'window') {
        const wins = await this.windowList().catch(() => [])
        const found = wins.some(w => w.title.toLowerCase().includes((condition.windowTitle ?? '').toLowerCase()))
        if (found) return { found: true, timedOut: false }
      } else if (condition.type === 'element') {
        const el = await this.findElement({
          name: condition.name,
          role: condition.role,
          automationId: condition.automationId,
          windowTitle: condition.windowTitle
        }).catch(() => null)
        if (el) return { found: true, timedOut: false }
      } else if (condition.type === 'element_gone') {
        const el = await this.findElement({
          name: condition.name,
          role: condition.role,
          automationId: condition.automationId,
          windowTitle: condition.windowTitle
        }).catch(() => null)
        if (!el) return { found: true, timedOut: false }
      }

      await new Promise(r => setTimeout(r, interval))
    }

    return { found: false, timedOut: true }
  }

  private runPS(script: string): Promise<string> {
    // Write to a temp .ps1 file â€” EncodedCommand silently drops function
    // definitions in complex scripts; -File does not have this limitation.
    const os  = require('os')  as typeof import('os')
    const fss = require('fs')  as typeof import('fs')
    const path = require('path') as typeof import('path')
    const tmp = path.join(os.tmpdir(), 'goga-ps-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.ps1')
    fss.writeFileSync(tmp, script, 'utf8')
    return new Promise((resolve, reject) => {
      let out = ''
      let err = ''
      const proc = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp],
        { windowsHide: true, env: { ...process.env } }
      )
      proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
      proc.stderr.on('data', (d: Buffer) => { err += d.toString() })
      proc.on('close', code => {
        try { fss.unlinkSync(tmp) } catch { /* ignore */ }
        if (code !== 0 && err) reject(new Error(err.trim()))
        else resolve(out)
      })
      proc.on('error', (e) => { try { fss.unlinkSync(tmp) } catch { /* ignore */ }; reject(e) })
    })
  }
}
