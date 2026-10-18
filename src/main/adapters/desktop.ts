import type { ToolAdapter } from './base'
import screenshot from 'screenshot-desktop'
import { mouse, keyboard, Key, Button, straightTo, Point } from '@nut-tree-fork/nut-js'
import { spawn } from 'child_process'
import { plannerDiagnostic, consumePowerShellDiagnostics } from '../services/plannerDiagnostics'
import { FILENAME_INPUT_GUARD_PS } from './filenameInputGuard'

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

export class WindowDiscoveryError extends Error {
  constructor(public readonly kind: 'enumeration' | 'parsing', detail: string) {
    super(`discovery_${kind}_error: ${detail}`)
    this.name = 'WindowDiscoveryError'
  }
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

  /** Returns the foreground window's PID, HWND, and title via Win32 APIs.
   *  Uses GetForegroundWindow + GetWindowThreadProcessId — no UIAutomation overhead.
   *  hwnd is the raw HWND integer (IntPtr value). Returns hwnd=0 on failure. */
  async activeWindowWithHwnd(): Promise<{ pid: number; hwnd: number; title: string }> {
    const ps = `
      Add-Type @"
        using System; using System.Runtime.InteropServices; using System.Text;
        public class FgWin {
          [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
          [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
          [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
        }
"@
      $hwnd = [FgWin]::GetForegroundWindow()
      $pid  = 0
      [FgWin]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
      $sb = New-Object System.Text.StringBuilder 512
      [FgWin]::GetWindowText($hwnd, $sb, 512) | Out-Null
      "$([int64]$hwnd)|$pid|$($sb.ToString())"
    `
    try {
      const raw = (await this.runPS(ps)).trim()
      const parts = raw.split('|')
      const hwnd  = parseInt(parts[0] ?? '0', 10)
      const pid   = parseInt(parts[1] ?? '0', 10)
      const title = parts.slice(2).join('|')
      return { hwnd: isNaN(hwnd) ? 0 : hwnd, pid: isNaN(pid) ? 0 : pid, title }
    } catch { return { hwnd: 0, pid: 0, title: '' } }
  }

  /** Enumerate all visible top-level windows for a given PID using Win32 EnumWindows.
   *  Win32 is used instead of UIAutomation because UIAutomation can return
   *  zero/infinite bounds for windows owned by single-instance host processes
   *  (e.g. Windows 11 Notepad routes new windows to an existing host PID). */
  async windowsByPid(pid: number): Promise<Array<{ hwnd: number; title: string; pid: number }>> {
    const ps = `
      Add-Type @"
        using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
        public static class WBP {
          public delegate bool EWP(IntPtr h, IntPtr l);
          [DllImport("user32.dll")] public static extern bool EnumWindows(EWP cb, IntPtr l);
          [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
          [DllImport("user32.dll")] public static extern int  GetWindowThreadProcessId(IntPtr h, out int p);
          [DllImport("user32.dll")] public static extern int  GetWindowText(IntPtr h, StringBuilder s, int n);
          public static List<long[]> ForPid(int pid) {
            var r = new List<long[]>();
            EnumWindows((h, l) => {
              if (IsWindowVisible(h)) {
                int p2 = 0; GetWindowThreadProcessId(h, out p2);
                if (p2 == pid) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); r.Add(new long[]{ h.ToInt64(), p2, sb.Length }); }
              }
              return true;
            }, IntPtr.Zero);
            return r;
          }
          public static string GetTitle(long hwnd) { var sb = new StringBuilder(512); GetWindowText(new IntPtr(hwnd), sb, 512); return sb.ToString(); }
        }
"@
      $rows = [WBP]::ForPid(${pid})
      $out = @()
      foreach ($r in $rows) {
        $title = [WBP]::GetTitle($r[0])
        if ($title.Length -gt 0) { $out += [PSCustomObject]@{ hwnd = $r[0]; pid = [int]$r[1]; title = $title } }
      }
      if ($out.Count -gt 0) { $out | ConvertTo-Json -Compress } else { Write-Output '[]' }
    `
    try {
      const raw = (await this.runPS(ps)).trim()
      if (!raw || raw === '[]' || raw === 'null') return []
      const parsed = JSON.parse(raw)
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      return arr
        .map((w: Record<string, unknown>) => ({ hwnd: Number(w.hwnd), title: String(w.title ?? ''), pid: Number(w.pid) }))
        .filter((w: { hwnd: number }) => w.hwnd !== 0)
    } catch { return [] }
  }

  /** Find a visible top-level window by title substring using Win32 EnumWindows,
   *  excluding any HWNDs present in baselineHwnds.
   *  Returns the real owner PID+HWND regardless of which process launched the app.
   *  Use after process.start to resolve the actual window identity. */
  async windowByTitleDiff(
    titleSubstring: string,
    baselineHwnds: Set<number> = new Set()
  ): Promise<{ hwnd: number; pid: number; title: string } | null> {
    const escaped = titleSubstring.replace(/\\/g, '\\\\').replace(/'/g, "''")
    const diagnostic = { discoveryId: `window-diff-${Date.now()}-${Math.random().toString(36).slice(2)}`, enumerationError: false }
    const tracing = !!process.env.GOGA_PLANNER_TRACE
    plannerDiagnostic('windows.discovery.start', { discoveryId: diagnostic.discoveryId, titleSubstring, baselineHwnds: [...baselineHwnds] })
    const ps = `
      $ErrorActionPreference = 'Stop'
      Add-Type @"
        using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
        public static class WTD {
          public class Observation { public long hwnd; public int pid; public string title; public string className; public bool visible; public string timestamp; }
          public static List<Observation> Observations = new List<Observation>();
          public static bool EnumerationSucceeded;
          public static int EnumerationError;
          public delegate bool EWP(IntPtr h, IntPtr l);
          [DllImport("user32.dll", SetLastError=true)] public static extern bool EnumWindows(EWP cb, IntPtr l);
          [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
          [DllImport("user32.dll")] public static extern int  GetWindowThreadProcessId(IntPtr h, out int p);
          [DllImport("user32.dll")] public static extern int  GetWindowText(IntPtr h, StringBuilder s, int n);
          [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
          public static List<long[]> All() {
            var r = new List<long[]>();
            EnumerationSucceeded = EnumWindows((h, l) => {
              if (${tracing ? 'true' : 'false'}) {
                int observedPid; GetWindowThreadProcessId(h, out observedPid);
                var observedTitle = new StringBuilder(512); GetWindowText(h, observedTitle, 512);
                var observedClass = new StringBuilder(256); GetClassName(h, observedClass, 256);
                Observations.Add(new Observation { hwnd=h.ToInt64(), pid=observedPid, title=observedTitle.ToString(), className=observedClass.ToString(), visible=IsWindowVisible(h), timestamp=DateTime.UtcNow.ToString("o") });
              }
              if (IsWindowVisible(h)) {
                int p2 = 0; GetWindowThreadProcessId(h, out p2);
                var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
                if (sb.Length > 0) r.Add(new long[]{ h.ToInt64(), p2 });
              }
              return true;
            }, IntPtr.Zero);
            EnumerationError = EnumerationSucceeded ? 0 : Marshal.GetLastWin32Error();
            return r;
          }
          public static string GetTitle(long hwnd) { var sb = new StringBuilder(512); GetWindowText(new IntPtr(hwnd), sb, 512); return sb.ToString(); }
        }
"@
      $rows = [WTD]::All()
      if (-not [WTD]::EnumerationSucceeded) { throw "EnumWindows failed: $([WTD]::EnumerationError)" }
      $out = @()
      foreach ($r in $rows) {
        $title = [WTD]::GetTitle($r[0])
        if ($title -match '${escaped}') { $out += [PSCustomObject]@{ hwnd = $r[0]; pid = [int]$r[1]; title = $title } }
      }
      ${tracing ? `
      $observations = @([WTD]::Observations | ForEach-Object {
        [PSCustomObject]@{ hwnd=$_.hwnd; pid=$_.pid; title=$_.title; className=$_.className; visible=$_.visible; timestamp=$_.timestamp; titleMatches=($_.title -match '${escaped}') }
      })
      @{ matches=@($out); observations=$observations; enumerationSucceeded=[WTD]::EnumerationSucceeded; enumerationError=[WTD]::EnumerationError } | ConvertTo-Json -Depth 6 -Compress
      ` : `if ($out.Count -gt 0) { $out | ConvertTo-Json -Compress } else { Write-Output '[]' }`}
    `
    let stage = 'enumeration'
    try {
      const raw = (await this.runPS(ps, diagnostic)).trim()
      if (diagnostic.enumerationError) throw new WindowDiscoveryError('enumeration', 'PowerShell enumeration failed')
      stage = 'parsing'
      if (!raw) throw new WindowDiscoveryError('parsing', 'Empty enumeration output')
      if (raw === '[]' || raw === 'null') {
        plannerDiagnostic('windows.discovery.result', { discoveryId: diagnostic.discoveryId, outcome: diagnostic.enumerationError ? 'enumeration_error' : 'zero_candidates', candidateCount: 0 })
        return null
      }
      let parsed = JSON.parse(raw)
      if (tracing && parsed && !Array.isArray(parsed) && 'observations' in parsed) {
        if (parsed.enumerationSucceeded === false) {
          diagnostic.enumerationError = true
          plannerDiagnostic('windows.enumeration_error', { discoveryId: diagnostic.discoveryId, win32Error: parsed.enumerationError })
          throw new WindowDiscoveryError('enumeration', `EnumWindows failed: ${parsed.enumerationError}`)
        }
        const observations = parsed.observations.map((w: Record<string, unknown>) => {
          const reasons: string[] = []
          if (!w.visible) reasons.push('not_visible')
          if (!String(w.title ?? '').length) reasons.push('empty_title')
          if (!w.titleMatches) reasons.push('title_mismatch')
          if (Number(w.hwnd) === 0) reasons.push('zero_hwnd')
          if (baselineHwnds.has(Number(w.hwnd))) reasons.push('baseline_hwnd')
          return { ...w, accepted: reasons.length === 0, rejectionReasons: reasons }
        })
        plannerDiagnostic('windows.discovery.candidates', { discoveryId: diagnostic.discoveryId, observations, matches: parsed.matches })
        parsed = parsed.matches
      }
      const arr: Array<{ hwnd: number; pid: number; title: string }> =
        (Array.isArray(parsed) ? parsed : [parsed])
          .map((w: Record<string, unknown>) => {
            if (!w || !Number.isSafeInteger(Number(w.hwnd)) || !Number.isSafeInteger(Number(w.pid)) || Number(w.pid) <= 0 || typeof w.title !== 'string') {
              throw new WindowDiscoveryError('parsing', 'Invalid window HWND/PID/title output')
            }
            return { hwnd: Number(w.hwnd), pid: Number(w.pid), title: w.title }
          })
          .filter((w: { hwnd: number }) => w.hwnd !== 0 && !baselineHwnds.has(w.hwnd))
      // Exactly one new HWND required — zero or multiple is ambiguous and unsafe
      plannerDiagnostic('windows.discovery.result', { discoveryId: diagnostic.discoveryId, outcome: diagnostic.enumerationError ? 'enumeration_error' : arr.length === 0 ? 'zero_candidates' : arr.length === 1 ? 'unique_candidate' : 'multiple_candidates', candidateCount: arr.length, candidates: arr })
      if (arr.length !== 1) return null
      return arr[0]
    } catch (err) {
      const kind = err instanceof WindowDiscoveryError ? err.kind : stage as 'enumeration' | 'parsing'
      plannerDiagnostic(`windows.${kind}_error`, { discoveryId: diagnostic.discoveryId, error: err instanceof Error ? err.message : String(err) })
      throw err instanceof WindowDiscoveryError ? err : new WindowDiscoveryError(kind, err instanceof Error ? err.message : String(err))
    }
  }

  /** SetForegroundWindow by HWND using the keybd_event trick to bypass
   *  Windows UIPI foreground lock restriction, then reads the resulting
   *  foreground window — all in one PS call to avoid inter-process races.
   *  Returns the resulting foreground window's PID, HWND, and title. */
  async focusAndGetForeground(hwnd: number): Promise<{ pid: number; hwnd: number; title: string }> {
    const ps = `
      Add-Type @"
        using System; using System.Runtime.InteropServices; using System.Text;
        public class FGF {
          [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
          [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
          [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
          [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
          [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
          [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
          [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
          public static void ForceForeground(IntPtr hwnd) {
            keybd_event(0, 0, 0, UIntPtr.Zero);
            uint myThread = GetCurrentThreadId();
            IntPtr fg = GetForegroundWindow();
            int fgPidOut = 0;
            uint fgThread = (uint)GetWindowThreadProcessId(fg, out fgPidOut);
            if (fgThread != myThread) AttachThreadInput(myThread, fgThread, true);
            SetForegroundWindow(hwnd);
            if (fgThread != myThread) AttachThreadInput(myThread, fgThread, false);
          }
        }
"@
      [FGF]::ForceForeground([IntPtr]${hwnd})
      Start-Sleep -Milliseconds 150
      $fg = [FGF]::GetForegroundWindow()
      $pid = 0
      [FGF]::GetWindowThreadProcessId($fg, [ref]$pid) | Out-Null
      $sb = New-Object System.Text.StringBuilder 512
      [FGF]::GetWindowText($fg, $sb, 512) | Out-Null
      "$([int64]$fg)|$pid|$($sb.ToString())"
    `
    try {
      const raw = (await this.runPS(ps)).trim()
      const parts = raw.split('|')
      const hwndOut = parseInt(parts[0] ?? '0', 10)
      const pid     = parseInt(parts[1] ?? '0', 10)
      const title   = parts.slice(2).join('|')
      return { hwnd: isNaN(hwndOut) ? 0 : hwndOut, pid: isNaN(pid) ? 0 : pid, title }
    } catch { return { hwnd: 0, pid: 0, title: '' } }
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

  /**
   * Press Enter in a dialog by finding its default button via UIAutomation
   * and invoking it — no foreground required.
   */
  async pressEnterInDialog(hwnd: number): Promise<{ ok: boolean; reason?: string }> {
    // Win11 Notepad Save As: Save button is a WinUI3 XAML element — NativeWindowHandle is 0.
    // InvokePattern is the only reliable method. PostMessage WM_LBUTTONDOWN/UP is fallback only.
    const ps = `
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      Add-Type @"
        using System; using System.Runtime.InteropServices;
        public class BtnClick {
          public const int WM_LBUTTONDOWN = 0x0201; public const int WM_LBUTTONUP = 0x0202;
          [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
        }
"@
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      $hwndCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]${hwnd})
      $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $hwndCond)
      if (-not $win) { Write-Output 'err:window_not_found'; exit }
      # Find Save As dialog in subtree
      $dlgCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, 'Save as')
      $dlg = $win.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $dlgCond)
      $searchRoot = if ($dlg) { $dlg } else { $win }
      # Find Save button by name='Save' AND AutomationId='1' — avoids matching
      # file list items which also have AutomationId='1' but appear earlier in the tree.
      $btn = $null
      foreach ($el in $searchRoot.FindAll([System.Windows.Automation.TreeScope]::Subtree,
          [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($el.Current.Name -eq 'Save' -and $el.Current.AutomationId -eq '1') {
          $btn = $el; break
        }
      }
      # Fallback: name='Save' only
      if (-not $btn) {
        $nc = New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::NameProperty, 'Save')
        $btn = $searchRoot.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $nc)
      }
      if (-not $btn) { Write-Output 'err:button_not_found'; exit }
      # Save button is role=Pane with a real HWND — use PostMessage, not InvokePattern
      $btnHwnd = [IntPtr]$btn.Current.NativeWindowHandle
      if ($btnHwnd -ne [IntPtr]::Zero) {
        [BtnClick]::PostMessage($btnHwnd, [BtnClick]::WM_LBUTTONDOWN, [IntPtr]1, [IntPtr]0) | Out-Null
        [BtnClick]::PostMessage($btnHwnd, [BtnClick]::WM_LBUTTONUP,   [IntPtr]1, [IntPtr]0) | Out-Null
        Write-Output 'ok:hwnd_click'
        exit
      }
      # HWND is zero — try InvokePattern as last resort
      try {
        $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        Write-Output 'ok:invoke'
        exit
      } catch { $invokeErr = $_ }
      Write-Output "err:no_hwnd_invoke_failed:$invokeErr"
    `
    try {
      const raw = (await this.runPS(ps)).trim()
      if (raw.startsWith('ok')) return { ok: true }
      return { ok: false, reason: raw }
    } catch (e) { return { ok: false, reason: String(e) } }
  }

  /**
   * Trigger File > Save As in a Notepad window by HWND using UIAutomation.
   * Finds the menu bar and invokes Save As without requiring foreground focus.
   * Falls back to PostMessage WM_COMMAND if UIAutomation invoke fails.
   */
  async saveAsViaMenu(hwnd: number): Promise<{ ok: boolean; reason?: string }> {
    // Win11 Notepad: File menu items are only exposed after the File MenuItem is invoked.
    // Must invoke File first, then find and invoke 'Save as' from the expanded menu.
    const ps = `
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      $hwndCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]${hwnd})
      $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $hwndCond)
      if (-not $win) { Write-Output 'err:window_not_found'; exit }
      # Step 1: invoke the File menu item to expand it
      $fileCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, 'File')
      $fileMenu = $win.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $fileCond)
      if (-not $fileMenu) { Write-Output 'err:file_menu_not_found'; exit }
      try {
        $fileMenu.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      } catch {
        Write-Output "err:file_invoke_$_"; exit
      }
      # Wait for menu to fully render before searching for Save as.
      Start-Sleep -Milliseconds 500
      # Step 2: find 'Save as' and invoke it. Re-find fresh each attempt.
      # If InvokePattern throws, check whether the dialog appeared anyway
      # (Win11 WinUI3 menus sometimes throw but still act on the invoke).
      $saveCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, 'Save as')
      $dlgCheckCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, 'Save as')
      $lastErr = ''
      $invoked = $false
      for ($attempt = 0; $attempt -lt 4; $attempt++) {
        if ($attempt -gt 0) { Start-Sleep -Milliseconds 300 }
        # Check if dialog already opened (previous attempt may have worked despite throwing)
        $dlgCheck = $win.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $dlgCheckCond)
        if ($dlgCheck -and $dlgCheck.Current.ControlType.ProgrammaticName -eq 'ControlType.Window') {
          $invoked = $true; break
        }
        $saveItem = $root.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $saveCond)
        if (-not $saveItem) { continue }
        try {
          $saveItem.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
          $invoked = $true; break
        } catch { $lastErr = "$_" }
      }
      # Final dialog check after last attempt
      if (-not $invoked) {
        $dlgFinal = $win.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $dlgCheckCond)
        if ($dlgFinal -and $dlgFinal.Current.ControlType.ProgrammaticName -eq 'ControlType.Window') {
          $invoked = $true
        }
      }
      if ($invoked) { Write-Output 'ok:invoke' } else { Write-Output "err:save_as_invoke_$lastErr" }
    `
    try {
      const raw = (await this.runPS(ps)).trim()
      if (raw.startsWith('ok')) return { ok: true }
      return { ok: false, reason: raw }
    } catch (e) {
      return { ok: false, reason: String(e) }
    }
  }

  /**
   * Type text into a window's edit control by HWND using UIAutomation ValuePattern.
   * Does NOT require the window to be in the foreground.
   * Finds the first Edit control in the window's subtree and sets its value.
   * Returns { ok: true } on success, { ok: false, reason } on failure.
   */
  async typeIntoHwnd(hwnd: number, text: string): Promise<{ ok: boolean; reason?: string }> {
    const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "''")
    const ps = `
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      Add-Type @"
        using System; using System.Runtime.InteropServices;
        public class WMPaste {
          public const int WM_SETTEXT = 0x000C;
          public const int WM_PASTE  = 0x0302;
          [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, string l);
          [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
        }
"@
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      # Search Children first (top-level window), then full Subtree (Win11 dialog embedded in Notepad)
      $hwndCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]${hwnd})
      $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $hwndCond)
      if (-not $win) { $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $hwndCond) }
      if (-not $win) { Write-Output 'err:window_not_found'; exit }
      # Try Document first (Win11 WinUI3 Notepad), then Edit (classic Notepad)
      $docCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Document)
      $edit = $win.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $docCond)
      if (-not $edit) {
        $editCond = New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          [System.Windows.Automation.ControlType]::Edit)
        $edit = $win.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $editCond)
      }
      # Win11 Save As filename field: Pane with AutomationId='1001'
      if (-not $edit) {
        $aidCond = New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1001')
        $edit = $win.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $aidCond)
      }
      if (-not $edit) { Write-Output 'err:edit_not_found'; exit }
      # Try ValuePattern first
      $vp = $null
      try { $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) } catch {}
      if ($vp) {
        try { $vp.SetValue('${escaped}'); Write-Output 'ok:value'; exit } catch {}
      }
      # Fallback: WM_SETTEXT directly on the edit control's HWND
      $editHwnd = [IntPtr]$edit.Current.NativeWindowHandle
      if ($editHwnd -eq [IntPtr]::Zero) { $editHwnd = [IntPtr]${hwnd} }
      [WMPaste]::SendMessage($editHwnd, [WMPaste]::WM_SETTEXT, [IntPtr]::Zero, '${escaped}') | Out-Null
      Write-Output 'ok:settext'
    `
    try {
      const raw = (await this.runPS(ps)).trim()
      if (raw.startsWith('ok')) return { ok: true }
      return { ok: false, reason: raw }
    } catch (e) {
      return { ok: false, reason: String(e) }
    }
  }

  /** Read the current editable text of the filename field in the Save As dialog
   *  via UIA Name property on the field element (AutomationId='1001', non-Address).
   *  GetWindowText returns empty on WinUI3 Pane controls; UIA Name is authoritative. */
  async readFilenameFromSaveAs(notepadHwnd: number): Promise<{ ok: boolean; value?: string; reason?: string }> {
    const ps = `
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      $hwndCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]${notepadHwnd})
      $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $hwndCond)
      if (-not $win) { Write-Output 'err:window_not_found'; exit }
      $dlgCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, 'Save as')
      $dlg = $win.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $dlgCond)
      if (-not $dlg) { Write-Output 'err:dialog_not_found'; exit }
      $aidCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1001')
      $field = $null
      foreach ($el in $dlg.FindAll([System.Windows.Automation.TreeScope]::Subtree, $aidCond)) {
        if ($el.Current.Name -notmatch '^Address') { $field = $el; break }
      }
      if (-not $field) { Write-Output 'err:field_not_found'; exit }
      Write-Output "ok:$($field.Current.Name)"
    `
    try {
      const raw = (await this.runPS(ps)).trim()
      if (!raw.startsWith('ok:')) return { ok: false, reason: raw }
      return { ok: true, value: raw.slice(3) }
    } catch (e) { return { ok: false, reason: String(e) } }
  }

  /** Set the filename field in Win11 Notepad's Save As dialog via synthesized
   *  keyboard input — the only method that commits to the WinUI3 XAML internal
   *  state. ValuePattern throws "Unsupported Pattern"; WM_SETTEXT only updates
   *  the UIA accessibility cache, not the dialog's internal state.
   *  Brings Notepad to foreground, clicks the field HWND, Ctrl+A, SendKeys path.
   *  Reads back UIA Name to confirm. Returns { ok, actual }. */
  async setFilenameInSaveAs(notepadHwnd: number, destPath: string, expectedPid: number, signal?: AbortSignal): Promise<{ ok: boolean; actual?: string; reason?: string }> {
    if (signal?.aborted) return { ok: false, reason: 'filename_input_cancelled' }
    if (!notepadHwnd || !expectedPid) return { ok: false, reason: 'filename_input_target_required' }
    const fs = require('fs') as typeof import('fs')
    const traceEnabled = !!process.env.GOGA_PLANNER_TRACE && require('path').isAbsolute(process.env.GOGA_PLANNER_TRACE)
    const cancelPath = require('path').join(require('os').tmpdir(), `goga-filename-cancel-${require('crypto').randomUUID()}.flag`) as string
    const cancel = () => { try { fs.writeFileSync(cancelPath, 'cancelled') } catch { /* runPS also aborts its own helper process */ } }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    // Escape SendKeys special chars: + ^ % ~ ( ) { } [ ]
    const sendKeysEscaped = destPath.replace(/([+^%~(){}\[\]])/g, '{$1}')
    // Escape single-quotes for PowerShell string literals
    const psEscaped = destPath.replace(/'/g, "''")
    const sendKeysPs = sendKeysEscaped.replace(/'/g, "''")
    const ps = `
      $ErrorActionPreference = 'Stop'
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type @"
        using System; using System.Runtime.InteropServices;
        public class SKHelper {
          public const int WM_LBUTTONDOWN = 0x0201; public const int WM_LBUTTONUP = 0x0202;
          [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
          [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
          [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
          [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
          [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
          [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
          [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
          [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
          [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
          [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
          [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
          [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
          public static void ForceForeground(IntPtr hwnd) {
            uint myThread = GetCurrentThreadId();
            IntPtr fg = GetForegroundWindow();
            uint fgPid = 0;
            uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
            if (fgThread != myThread) AttachThreadInput(myThread, fgThread, true);
            SetForegroundWindow(hwnd);
            if (fgThread != myThread) AttachThreadInput(myThread, fgThread, false);
          }
        }
"@
      ${FILENAME_INPUT_GUARD_PS}
      function Get-FilenameForeground { [SKHelper]::GetForegroundWindow().ToInt64() }
      function Get-FilenameOwner([long]$Handle) { [uint32]$owner = 0; [SKHelper]::GetWindowThreadProcessId([IntPtr]$Handle, [ref]$owner) | Out-Null; $owner }
      function Test-FilenameWindow([long]$Handle) { [SKHelper]::IsWindow([IntPtr]$Handle) }
      function Test-FilenameChild([long]$Parent, [long]$Child) { [SKHelper]::IsChild([IntPtr]$Parent,[IntPtr]$Child) }
      function Send-FilenameKeys([string]$Keys) { [System.Windows.Forms.SendKeys]::SendWait($Keys) }
      $script:filenameStage = 'frame_before_lookup'
      $script:filenameDialog = $null
      $script:filenameField = $null
      function Get-FilenameIdentity([long]$Handle) {
        if ($Handle -eq 0) { return @{ hwnd=0; pid=$null; parentHwnd=$null; ownerHwnd=$null; rootHwnd=$null } }
        return @{ hwnd=$Handle; pid=(Get-FilenameOwner $Handle); parentHwnd=[SKHelper]::GetParent([IntPtr]$Handle).ToInt64(); ownerHwnd=[SKHelper]::GetWindow([IntPtr]$Handle,4).ToInt64(); rootHwnd=[SKHelper]::GetAncestor([IntPtr]$Handle,2).ToInt64() }
      }
      function Test-FilenameOwnerChain([long]$Child, [long]$Ancestor) {
        if ($Child -eq 0 -or $Ancestor -eq 0) { return $null }
        $cursor = [IntPtr]$Child
        for ($depth=0; $depth -lt 32; $depth++) {
          $cursor = [SKHelper]::GetWindow($cursor,4)
          if ($cursor -eq [IntPtr]::Zero) { return $false }
          if ($cursor.ToInt64() -eq $Ancestor) { return $true }
        }
        return $false
      }
      function Get-FilenameContext {
        if (${traceEnabled ? '$false' : '$true'}) { return @{} }
        try {
        $dialogHwnd = if ($script:filenameDialog) { [long]$script:filenameDialog.Current.NativeWindowHandle } else { 0 }
        $controlHwnd = if ($script:filenameField) { [long]$script:filenameField.Current.NativeWindowHandle } else { 0 }
        $foregroundHwnd = Get-FilenameForeground
        return @{
          observedAt=[DateTime]::UtcNow.ToString('o')
          expected=@{ hwnd=${notepadHwnd}; pid=${expectedPid} }
          frame=(Get-FilenameIdentity ${notepadHwnd})
          dialog=(Get-FilenameIdentity $dialogHwnd)
          filenameControl=(Get-FilenameIdentity $controlHwnd)
          foreground=(Get-FilenameIdentity $foregroundHwnd)
          dialogUiaPid=$(if ($script:filenameDialog) { $script:filenameDialog.Current.ProcessId } else { $null })
          filenameControlUiaPid=$(if ($script:filenameField) { $script:filenameField.Current.ProcessId } else { $null })
          relationships=@{
            dialogFoundInExactFrameSubtree=($null -ne $script:filenameDialog)
            filenameFoundInDialogSubtree=($null -ne $script:filenameField)
            dialogWin32OwnerChainContainsFrame=(Test-FilenameOwnerChain $dialogHwnd ${notepadHwnd})
            filenameIsChildOfFrame=$(if ($controlHwnd) { [SKHelper]::IsChild([IntPtr]${notepadHwnd},[IntPtr]$controlHwnd) } else { $null })
            filenameIsChildOfDialog=$(if ($dialogHwnd -and $controlHwnd) { [SKHelper]::IsChild([IntPtr]$dialogHwnd,[IntPtr]$controlHwnd) } else { $null })
            foregroundWin32OwnerChainContainsFrame=(Test-FilenameOwnerChain $foregroundHwnd ${notepadHwnd})
          }
        }
        } catch { return @{ snapshotError=$_.Exception.Message } }
      }
      function Write-FilenameDiagnostic($Data) {
        ${traceEnabled ? "try { Write-Output ('GOGA_FILENAME_DIAGNOSTIC:' + ($Data | ConvertTo-Json -Depth 10 -Compress)) } catch {}" : '# Trace disabled: no diagnostic output.'}
      }
      $cancelPath = '${cancelPath.replace(/'/g, "''")}'
      if (Test-Path -LiteralPath $cancelPath) { throw 'filename_input_cancelled' }
      $framePid = Get-FilenameOwner ${notepadHwnd}
      Assert-FilenameChecks 'frame_before_lookup' @(@{ reason='frame_pid'; expected=${expectedPid}; observed=$framePid; passed=($framePid -eq ${expectedPid}) }) (Get-FilenameContext)
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      $hwndCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]${notepadHwnd})
      $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $hwndCond)
      if (-not $win) { Write-Output 'err:window_not_found'; exit }
      $dlgCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, 'Save as')
      $dlg = $win.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $dlgCond)
      if (-not $dlg) { Write-Output 'err:dialog_not_found'; exit }
      $script:filenameDialog = $dlg
      # Record the exact native dialog: never substitute the frame or another
      # same-PID window when the dialog has no usable HWND.
      $dialogHwnd = [long]$dlg.Current.NativeWindowHandle
      Assert-FilenameChecks 'dialog_found' @(@{reason='dialog_hwnd_nonzero';expected='nonzero';observed=$dialogHwnd;passed=($dialogHwnd -ne 0)}) (Get-FilenameContext)
      $aidCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1001')
      # Filename field is ControlType.Pane with aid=1001 — exclude Address bar (Name starts
      # with 'Address') and Document control (also aid=1001 in some states, role=Document).
      $paneType = [System.Windows.Automation.ControlType]::Pane
      $field = $null
      foreach ($el in $dlg.FindAll([System.Windows.Automation.TreeScope]::Subtree, $aidCond)) {
        if ($el.Current.ControlType -eq $paneType -and $el.Current.Name -notmatch '^Address') {
          $field = $el; break
        }
      }
      if (-not $field) { Write-Output 'err:filename_field_not_found'; exit }
      $script:filenameField = $field
      $fieldHwnd = [IntPtr]$field.Current.NativeWindowHandle
      $controlHwnd = $fieldHwnd.ToInt64()
      Assert-FilenameChecks 'filename_control_found' @(@{ reason='filename_control_hwnd_nonzero'; expected='nonzero'; observed=$fieldHwnd.ToInt64(); passed=($fieldHwnd -ne [IntPtr]::Zero) }) (Get-FilenameContext)
      # Validate ownership before focusing the exact recorded Save As dialog.
      $identity = Get-FilenameInputChecks ${notepadHwnd} $dialogHwnd $controlHwnd ${expectedPid}
      Assert-FilenameChecks 'before_dialog_focus' $identity.checks (Get-FilenameContext)
      [SKHelper]::ForceForeground([IntPtr]$dialogHwnd)
      Start-Sleep -Milliseconds 200
      if (Test-Path -LiteralPath $cancelPath) { throw 'filename_input_cancelled' }
      $script:filenameStage = 'before_field_click'
      Assert-FilenameInputTarget ${notepadHwnd} $dialogHwnd $controlHwnd ${expectedPid}
      # Click the owned field to focus it
      [SKHelper]::PostMessage($fieldHwnd, [SKHelper]::WM_LBUTTONDOWN, [IntPtr]1, [IntPtr]0) | Out-Null
      [SKHelper]::PostMessage($fieldHwnd, [SKHelper]::WM_LBUTTONUP,   [IntPtr]1, [IntPtr]0) | Out-Null
      Start-Sleep -Milliseconds 150
      try { $field.SetFocus() } catch {}
      Start-Sleep -Milliseconds 150
      # Select all existing text and type the path
      $script:filenameStage = 'select_all'
      Invoke-GuardedFilenameKeys ${notepadHwnd} $dialogHwnd $controlHwnd ${expectedPid} $cancelPath '^a'
      Start-Sleep -Milliseconds 100
      $script:filenameStage = 'filename_path'
      Invoke-GuardedFilenameKeys ${notepadHwnd} $dialogHwnd $controlHwnd ${expectedPid} $cancelPath '${sendKeysPs}'
      # Wait for SendKeys to finish before polling — path length determines typing time.
      # 50ms per char is conservative; minimum 500ms regardless.
      $minWait = [Math]::Max(500, '${psEscaped}'.Length * 50)
      Start-Sleep -Milliseconds $minWait
      # Poll UIA Name until it stabilizes or matches (up to 3s additional)
      $expected = '${psEscaped}'
      $actual = ''
      for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 100
        $field2 = $null
        foreach ($el2 in $dlg.FindAll([System.Windows.Automation.TreeScope]::Subtree, $aidCond)) {
          if ($el2.Current.ControlType -eq $paneType -and $el2.Current.Name -notmatch '^Address') {
            $field2 = $el2; break
          }
        }
        $actual = if ($field2) { $field2.Current.Name } else { '' }
        if ($actual -eq $expected) { break }
      }
      Write-Output "ok:$actual"
    `
    try {
      const raw = (await this.runPS(ps, undefined, signal, true)).trim()
      if (signal?.aborted) return { ok: false, reason: 'filename_input_cancelled' }
      if (!raw.startsWith('ok:')) return { ok: false, reason: raw }
      const actual = raw.slice(3)
      return { ok: true, actual }
    } catch (e) { return { ok: false, reason: signal?.aborted ? 'filename_input_cancelled' : String(e) } }
    finally {
      signal?.removeEventListener('abort', cancel)
      try { fs.unlinkSync(cancelPath) } catch { /* absent unless cancellation occurred */ }
    }
  }

  /** Find the Save As dialog inside a Notepad window's UIA subtree.
   *  Win11 Notepad renders Save As as a WinUI3 in-process window — it never
   *  appears in Win32 EnumWindows. Search the Notepad window's own UIA tree.
   *  Returns the dialog element's HWND and the Notepad window's PID. */
  async findSaveAsInSubtree(ownerHwnd: number): Promise<{ hwnd: number; pid: number; title: string } | null> {
    const ps = `
      $ErrorActionPreference = 'Stop'
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $root = [System.Windows.Automation.AutomationElement]::RootElement
      $hwndCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]${ownerHwnd})
      $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $hwndCond)
      if (-not $win) { Write-Output 'null'; exit }
      $dlgCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, 'Save as')
      $dlg = $win.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $dlgCond)
      if (-not $dlg) { Write-Output 'null'; exit }
      $dlgHwnd = $dlg.Current.NativeWindowHandle
      # If dialog has no HWND of its own, use the owner window's HWND
      if ($dlgHwnd -eq 0) { $dlgHwnd = ${ownerHwnd} }
      "$dlgHwnd|$($win.Current.ProcessId)|$($dlg.Current.Name)"
    `
    let stage: 'enumeration' | 'parsing' = 'enumeration'
    try {
      const raw = (await this.runPS(ps)).trim()
      stage = 'parsing'
      if (raw === 'null') return null
      if (!raw) throw new WindowDiscoveryError('parsing', 'Empty dialog enumeration output')
      const parts = raw.split('|')
      const hwnd = parseInt(parts[0] ?? '0', 10)
      const pid  = parseInt(parts[1] ?? '0', 10)
      const title = parts.slice(2).join('|')
      if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1]) || !hwnd || !pid || parts.length < 3) {
        throw new WindowDiscoveryError('parsing', 'Invalid dialog HWND/PID output')
      }
      return { hwnd, pid, title }
    } catch (err) {
      plannerDiagnostic(`windows.${stage}_error`, { ownerHwnd, error: err instanceof Error ? err.message : String(err) })
      throw err instanceof WindowDiscoveryError ? err : new WindowDiscoveryError(stage, err instanceof Error ? err.message : String(err))
    }
  }

  /** Returns the PID that owns the given HWND via GetWindowThreadProcessId.
   *  Returns 0 if the HWND is invalid or the call fails. */
  async pidOfHwnd(hwnd: number): Promise<number> {
    const ps = `
      Add-Type @"
        using System; using System.Runtime.InteropServices;
        public class POHI { [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int p); }
"@
      $p = 0
      [POHI]::GetWindowThreadProcessId([IntPtr]${hwnd}, [ref]$p) | Out-Null
      Write-Output $p
    `
    try {
      const raw = (await this.runPS(ps)).trim()
      const pid = parseInt(raw, 10)
      return isNaN(pid) ? 0 : pid
    } catch { return 0 }
  }

  /** Win32 IsWindow — returns false once the HWND has been destroyed. */
  async isWindow(hwnd: number, strict = false): Promise<boolean> {
    const ps = `
      $ErrorActionPreference = 'Stop'
      Add-Type @"
        using System; using System.Runtime.InteropServices;
        public class IW { [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h); }
"@
      if ([IW]::IsWindow([IntPtr]${hwnd})) { Write-Output 'true' } else { Write-Output 'false' }
    `
    try {
      const raw = (await this.runPS(ps)).trim()
      if (strict && raw !== 'true' && raw !== 'false') throw new Error('Invalid IsWindow output')
      return raw === 'true'
    } catch (err) { if (strict) throw err; return false }
  }

  /** Win32 PostMessage(hwnd, WM_CLOSE, 0, 0) — unconditional close, does not
   *  require the window to be in the foreground. */
  async postClose(hwnd: number): Promise<{ requested: boolean; win32Error: number }> {
    const ps = `
      $ErrorActionPreference = 'Stop'
      Add-Type @"
        using System; using System.Runtime.InteropServices;
        public class PC {
          public const int WM_CLOSE = 0x0010;
          [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
        }
"@
      $requested = [PC]::PostMessage([IntPtr]${hwnd}, [PC]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
      $nativeError = if ($requested) { 0 } else { [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
      @{ requested=$requested; win32Error=$nativeError } | ConvertTo-Json -Compress
    `
    const result = JSON.parse((await this.runPS(ps)).trim())
    if (typeof result?.requested !== 'boolean' || !Number.isInteger(result.win32Error)) throw new Error('Invalid close-request output')
    return result
  }

  /**
   * Find visible top-level windows whose Win32 owner chain includes ownerHwnd.
   * Uses GetWindow(GW_OWNER) to walk the chain — PID and title alone cannot
   * establish ownership when multiple windows share a process.
   * Optionally filters by title substring (case-insensitive, empty = all).
   */
  async findOwnedDialogs(
    ownerHwnd: number,
    titleSubstring = ''
  ): Promise<Array<{ hwnd: number; pid: number; title: string }>> {
    const filterLine = titleSubstring
      ? `if ($title -notmatch '${titleSubstring.replace(/'/g, "''").replace(/\\/g, '\\\\')}') { return $true }`
      : ''
    const ps = [
      'Add-Type @"',
      '  using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;',
      '  public static class OWN {',
      '    public const int GW_OWNER = 4;',
      '    public delegate bool EWP(IntPtr h, IntPtr l);',
      '    [DllImport("user32.dll")] public static extern bool EnumWindows(EWP cb, IntPtr l);',
      '    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
      '    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, int cmd);',
      '    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int p);',
      '    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
      '    public static bool HasOwner(IntPtr h, long target) {',
      '      IntPtr cur = h;',
      '      for (int i = 0; i < 32; i++) {',
      '        cur = GetWindow(cur, GW_OWNER);',
      '        if (cur == IntPtr.Zero) return false;',
      '        if (cur.ToInt64() == target) return true;',
      '      }',
      '      return false;',
      '    }',
      '  }',
      '"@',
      `$target = [long]${ownerHwnd}`,
      '$out = [System.Collections.Generic.List[PSCustomObject]]::new()',
      '[OWN]::EnumWindows({',
      '  param($h, $l)',
      '  if ([OWN]::IsWindowVisible($h) -and [OWN]::HasOwner($h, $target)) {',
      '    $sb = New-Object System.Text.StringBuilder 512',
      '    [OWN]::GetWindowText($h, $sb, 512) | Out-Null',
      '    $title = $sb.ToString()',
      filterLine,
      '    $pid2 = 0',
      '    [OWN]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null',
      '    $out.Add([PSCustomObject]@{ hwnd = $h.ToInt64(); pid = [int]$pid2; title = $title })',
      '  }',
      '  return $true',
      '}, [IntPtr]::Zero) | Out-Null',
      'if ($out.Count -gt 0) { $out | ConvertTo-Json -Compress } else { Write-Output "[]" }',
    ].join('\n')
    try {
      const raw = (await this.runPS(ps)).trim()
      if (!raw || raw === '[]' || raw === 'null') return []
      const parsed = JSON.parse(raw)
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      return arr
        .map((w: Record<string, unknown>) => ({ hwnd: Number(w.hwnd), pid: Number(w.pid), title: String(w.title ?? '') }))
        .filter((w: { hwnd: number }) => w.hwnd !== 0)
    } catch { return [] }
  }

  /**
   * Search the UIAutomation subtree of a specific HWND for an element by name.
   * Scopes the search to exactly that window via NativeWindowHandleProperty —
   * never falls back to a global or title-based search.
   */
  async findElementByHwnd(
    hwnd: number,
    name: string,
    strict = false
  ): Promise<import('../../shared/types').AccessibilityNode | null> {
    const escapedName = name.replace(/'/g, "''")
    const ps = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName UIAutomationClient',
      'Add-Type -AssemblyName UIAutomationTypes',
      '$root = [System.Windows.Automation.AutomationElement]::RootElement',
      `$hwndCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, [int]${hwnd})`,
      '$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $hwndCond)',
      'if (-not $win) { Write-Output "null"; exit }',
      `$nameCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '${escapedName}')`,
      '$el = $win.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $nameCond)',
      'if ($el) {',
      '  $b = $el.Current.BoundingRectangle',
      '  $cx = if($b.Width -gt 0){ [int]($b.X + $b.Width/2) } else { 0 }',
      '  $cy = if($b.Height -gt 0){ [int]($b.Y + $b.Height/2) } else { 0 }',
      '  [PSCustomObject]@{',
      '    automationId = $el.Current.AutomationId',
      '    name         = $el.Current.Name',
      '    role         = $el.Current.ControlType.ProgrammaticName -replace "ControlType.",""',
      '    x = $cx; y = $cy',
      '    width  = [int][Math]::Max(0,[Math]::Min($b.Width,9999))',
      '    height = [int][Math]::Max(0,[Math]::Min($b.Height,9999))',
      '    value   = $null',
      '    enabled = $el.Current.IsEnabled',
      '    focused = $el.Current.HasKeyboardFocus',
      '  } | ConvertTo-Json -Compress',
      '} else { Write-Output "null" }',
    ].join('\n')
    try {
      const raw = (await this.runPS(ps)).trim()
      if (strict && !raw) throw new Error('Empty scoped dialog-lookup output')
      if (!raw || raw === 'null') return null
      const n = JSON.parse(raw) as Record<string, unknown>
      if (strict && (!n || Array.isArray(n) || typeof n.name !== 'string' || typeof n.role !== 'string')) throw new Error('Invalid scoped dialog-lookup output')
      return this.mapNode({ ...n, children: [] })
    } catch (err) { if (strict) throw err; return null }
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

  private runPS(script: string, diagnostic?: { discoveryId: string; enumerationError: boolean }, signal?: AbortSignal, filenameDiagnostics = false): Promise<string> {
    if (signal?.aborted) return Promise.reject(new Error('cancelled'))
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
      const abort = () => {
        proc.kill() // Only this owned PowerShell helper, never the Notepad host.
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
      proc.stderr.on('data', (d: Buffer) => { err += d.toString() })
      proc.on('close', code => {
        signal?.removeEventListener('abort', abort)
        if (filenameDiagnostics) out = consumePowerShellDiagnostics(out)
        try { fss.unlinkSync(tmp) } catch { /* ignore */ }
        if (diagnostic && (err || code !== 0)) {
          diagnostic.enumerationError = true
          plannerDiagnostic('windows.enumeration_error', { discoveryId: diagnostic.discoveryId, exitCode: code, stderr: err.trim() })
        }
        if (signal?.aborted) reject(new Error('cancelled'))
        else if (code !== 0) reject(new Error(err.trim() || `PowerShell helper exited with code ${code}`))
        else resolve(out)
      })
      proc.on('error', (e) => { signal?.removeEventListener('abort', abort); try { fss.unlinkSync(tmp) } catch { /* ignore */ }; reject(e) })
    })
  }
}
