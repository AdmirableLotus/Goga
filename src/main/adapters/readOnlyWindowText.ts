export interface WindowTextObservation {
  window: { hwnd: number; pid: number; title: string }
  texts: string[]
  truncated: boolean
}

export interface ObservedWindowIdentity {
  hwnd: number; pid: number; title: string; owner: string
}

/** Capture identity atomically enough to reject foreground changes during the read. */
export async function readActiveWindowIdentity(
  run: (script: string, signal?: AbortSignal) => Promise<string>, signal?: AbortSignal,
): Promise<ObservedWindowIdentity> {
  if (signal?.aborted) throw new Error('cancelled')
  const raw = await run(`
    $ErrorActionPreference = 'Stop'
    Add-Type @"
      using System; using System.Text; using System.Runtime.InteropServices;
      public class ObservedIdentity {
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
      }
"@
    $handle = [ObservedIdentity]::GetForegroundWindow()
    [uint32]$observedPid = 0
    [ObservedIdentity]::GetWindowThreadProcessId($handle, [ref]$observedPid) | Out-Null
    if ($handle -eq [IntPtr]::Zero -or $observedPid -eq 0) { throw 'No active window identity' }
    $title = New-Object System.Text.StringBuilder 2048
    [ObservedIdentity]::GetWindowText($handle, $title, $title.Capacity) | Out-Null
    $owner = [System.Diagnostics.Process]::GetProcessById([int]$observedPid).ProcessName
    $after = [ObservedIdentity]::GetForegroundWindow()
    [uint32]$afterPid = 0
    [ObservedIdentity]::GetWindowThreadProcessId($after, [ref]$afterPid) | Out-Null
    if ($after -ne $handle -or $afterPid -ne $observedPid) { throw 'Foreground changed during identity capture' }
    @{ hwnd=$handle.ToInt64(); pid=[int]$observedPid; title=$title.ToString(); owner=$owner } | ConvertTo-Json -Compress
  `, signal)
  if (signal?.aborted) throw new Error('cancelled')
  let data: ObservedWindowIdentity
  try { data = JSON.parse(raw) } catch { throw new Error('Invalid active-window identity JSON') }
  if (!data || !Number.isSafeInteger(data.hwnd) || data.hwnd <= 0 || !Number.isSafeInteger(data.pid) || data.pid <= 0 || typeof data.title !== 'string' || typeof data.owner !== 'string') {
    throw new Error('Invalid active-window identity')
  }
  return data
}

/** Exact foreground HWND, with no activation, keyboard, mouse or UIA mutation. */
export async function readActiveWindowText(
  run: (script: string, signal?: AbortSignal) => Promise<string>,
  title: string, pid: number, hwnd: number, signal?: AbortSignal,
): Promise<WindowTextObservation> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(hwnd) || hwnd <= 0 || typeof title !== 'string') throw new Error('Invalid observation target')
  if (signal?.aborted) throw new Error('cancelled')
  const script = `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type @"
      using System; using System.Runtime.InteropServices;
      public class ObservationWindow {
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
      }
"@
    function Assert-ObservedWindow([IntPtr]$actualHandle, [uint32]$actualPid) {
      if ($actualHandle -eq [IntPtr]::Zero -or $actualHandle.ToInt64() -ne ${hwnd} -or $actualPid -ne ${pid}) { throw 'Observation foreground HWND/PID changed' }
    }
    $handle = [ObservationWindow]::GetForegroundWindow()
    [uint32]$observedPid = 0
    [ObservationWindow]::GetWindowThreadProcessId($handle, [ref]$observedPid) | Out-Null
    Assert-ObservedWindow $handle $observedPid
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    if (-not $window -or $window.Current.NativeWindowHandle -ne ${hwnd} -or $window.Current.ProcessId -ne ${pid} -or $window.Current.Name -cne '${title.replace(/'/g, "''")}') { throw 'Observation UI window identity mismatch' }
    $script:texts = New-Object 'System.Collections.Generic.List[string]'
    $script:seen = New-Object 'System.Collections.Generic.HashSet[string]'
    $script:visited = 0
    $script:characters = 0
    function Add-ObservedText([string]$text) {
      if (-not $text -or $script:characters -ge 6000) { return }
      $text = $text.Substring(0, [Math]::Min($text.Length, 6000 - $script:characters))
      if ($script:seen.Add($text)) { $script:texts.Add($text); $script:characters += $text.Length }
    }
    function Read-ObservedNode($element, [int]$depth) {
      if ($depth -gt 8 -or $script:visited -ge 200 -or $script:characters -ge 6000) { return }
      $script:visited++
      if ($element.Current.IsPassword -or $element.Current.IsOffscreen) { return }
      Add-ObservedText $element.Current.Name
      if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Document -or $element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text) {
        $pattern = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
          Add-ObservedText $pattern.DocumentRange.GetText(1200)
        }
      }
      foreach ($child in $element.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
        Read-ObservedNode $child ($depth + 1)
        if ($script:visited -ge 200 -or $script:characters -ge 6000) { break }
      }
    }
    Read-ObservedNode $window 0
    $after = [ObservationWindow]::GetForegroundWindow()
    [uint32]$afterPid = 0
    [ObservationWindow]::GetWindowThreadProcessId($after, [ref]$afterPid) | Out-Null
    Assert-ObservedWindow $after $afterPid
    [PSCustomObject]@{
      window = @{ hwnd = $handle.ToInt64(); pid = [int]$observedPid; title = $window.Current.Name }
      texts = @($script:texts.ToArray())
      truncated = ($script:visited -ge 200 -or $script:characters -ge 6000)
    } | ConvertTo-Json -Depth 4 -Compress
  `
  const raw = await run(script, signal)
  if (signal?.aborted) throw new Error('cancelled')
  let data: WindowTextObservation
  try { data = JSON.parse(raw) } catch { throw new Error('Invalid observation UI JSON') }
  if (!data || data.window?.pid !== pid || data.window.title !== title || data.window.hwnd !== hwnd
      || !Array.isArray(data.texts) || data.texts.some(text => typeof text !== 'string') || data.texts.length > 400
      || data.texts.join('').length > 6000 || typeof data.truncated !== 'boolean') {
    throw new Error('Invalid observation UI result or target mismatch')
  }
  return data
}
