# Notepad HWND discovery + safe cleanup diagnostic
# Verifies: windowByTitleDiff returns exactly one new HWND.
# Closes only that HWND via WM_CLOSE. Never kills the host PID.
# Polls IsWindow(hwnd) until false. Confirms baseline HWNDs unchanged.

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class WinEnum {
    public delegate bool EnumWndProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWndProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int  GetWindowThreadProcessId(IntPtr hwnd, out int pid);
    [DllImport("user32.dll")] public static extern int  GetWindowText(IntPtr hwnd, StringBuilder sb, int n);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);

    public static List<long[]> Snapshot() {
        var result = new List<long[]>();
        EnumWindows((h, l) => {
            if (IsWindowVisible(h)) {
                int pid = 0;
                GetWindowThreadProcessId(h, out pid);
                result.Add(new long[] { h.ToInt64(), pid });
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
    public static string GetTitle(long hwnd) {
        var sb = new StringBuilder(512);
        GetWindowText(new IntPtr(hwnd), sb, 512);
        return sb.ToString();
    }
}
"@

function Get-Win32Windows {
    $pairs = [WinEnum]::Snapshot()
    $out = @()
    foreach ($p in $pairs) {
        $title = [WinEnum]::GetTitle($p[0])
        if ($title.Length -gt 0) {
            $out += [PSCustomObject]@{ hwnd = $p[0]; pid = [int]$p[1]; title = $title }
        }
    }
    return $out
}

# ── Baseline ──────────────────────────────────────────────────────────────────
Write-Host "=== BASELINE ==="
$baseline = Get-Win32Windows
$baselineSet = [System.Collections.Generic.HashSet[long]]::new()
foreach ($w in $baseline) { $baselineSet.Add($w.hwnd) | Out-Null }
Write-Host "  Visible windows: $($baseline.Count)"
$baselineNotepad = $baseline | Where-Object { $_.title -match 'Notepad' }
Write-Host "  Existing Notepad windows: $($baselineNotepad.Count)"
foreach ($w in $baselineNotepad) {
    $hx = $w.hwnd.ToString("X")
    Write-Host "    hwnd=0x$hx pid=$($w.pid) title=$($w.title)"
}

# ── Launch ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== LAUNCH ==="
$proc = Start-Process notepad.exe -PassThru
$launcherPid = $proc.Id
Write-Host "  launcher PID = $launcherPid"

# ── Poll for exactly one new Notepad HWND ─────────────────────────────────────
Write-Host ""
Write-Host "=== POLL: waiting for exactly one new Notepad HWND (10s max) ==="
$newNotepadWindows = @()
$deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    $current = Get-Win32Windows
    $candidates = @()
    foreach ($w in $current) {
        if (-not $baselineSet.Contains($w.hwnd) -and $w.title -match 'Notepad') {
            $candidates += $w
        }
    }
    if ($candidates.Count -gt 0) {
        $newNotepadWindows = $candidates
        break
    }
}

Write-Host "  New Notepad windows found: $($newNotepadWindows.Count)"
foreach ($w in $newNotepadWindows) {
    $hx = $w.hwnd.ToString("X")
    Write-Host "    hwnd=0x$hx pid=$($w.pid) title=$($w.title)"
}

if ($newNotepadWindows.Count -eq 0) {
    Write-Host "  ERROR: zero new Notepad windows — cannot proceed"
    Stop-Process -Id $launcherPid -Force -ErrorAction SilentlyContinue
    exit 1
}
if ($newNotepadWindows.Count -gt 1) {
    Write-Host "  ERROR: multiple new Notepad windows — ambiguous, cannot proceed safely"
    Stop-Process -Id $launcherPid -Force -ErrorAction SilentlyContinue
    exit 1
}

$testWindow = $newNotepadWindows[0]
$testHwnd   = [IntPtr]$testWindow.hwnd
$testPid    = $testWindow.pid
$hxTest     = $testWindow.hwnd.ToString("X")

Write-Host ""
Write-Host "=== IDENTITY (exactly one new window) ==="
Write-Host "  Test HWND       = 0x$hxTest  ($($testWindow.hwnd))"
Write-Host "  Owner PID       = $testPid"
Write-Host "  Title           = $($testWindow.title)"
Write-Host "  Launcher PID    = $launcherPid"
Write-Host "  PIDs match      = $($testPid -eq $launcherPid)"
Write-Host "  NOTE: will close HWND only — never kill host PID $testPid"

# ── Cleanup: WM_CLOSE to exact HWND only ─────────────────────────────────────
Write-Host ""
Write-Host "=== CLEANUP: WM_CLOSE to exact test HWND 0x$hxTest ==="
[WinEnum]::PostMessage($testHwnd, [uint32]0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
Write-Host "  WM_CLOSE sent"

# Poll IsWindow until false (max 5s)
$closeDeadline = (Get-Date).AddSeconds(5)
$gone = $false
while ((Get-Date) -lt $closeDeadline) {
    Start-Sleep -Milliseconds 200
    if (-not [WinEnum]::IsWindow($testHwnd)) { $gone = $true; break }
}

# Handle save dialog via scoped UIAutomation on ownerPid only
if (-not $gone) {
    Write-Host "  Window still open - checking for save dialog on pid=$testPid"
    Add-Type -AssemblyName UIAutomationClient
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $dontSave1 = "Don't Save"
    $dontSave2 = "Don't save"
    foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($w.Current.ProcessId -eq $testPid) {
            foreach ($btn in $w.FindAll([System.Windows.Automation.TreeScope]::Subtree,
                [System.Windows.Automation.Condition]::TrueCondition)) {
                $n = $btn.Current.Name
                if ($n -eq $dontSave1 -or $n -eq "No" -or $n -eq $dontSave2) {
                    Write-Host "  Found save dialog button: $n"
                    try {
                        $pat = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
                        $pat.Invoke()
                    } catch {}
                }
            }
        }
    }
    Start-Sleep -Milliseconds 600
    $gone = -not [WinEnum]::IsWindow($testHwnd)
}

Write-Host "  IsWindow(0x$hxTest) = $(-not $gone) => gone=$gone"

# ── Verify baseline HWNDs unchanged ──────────────────────────────────────────
Write-Host ""
Write-Host "=== BASELINE VERIFICATION: all $($baseline.Count) baseline HWNDs still valid ==="
$missing = @()
foreach ($w in $baseline) {
    if (-not [WinEnum]::IsWindow([IntPtr]$w.hwnd)) {
        $hxB = $w.hwnd.ToString("X")
        $missing += "hwnd=0x$hxB pid=$($w.pid) title=$($w.title)"
    }
}
if ($missing.Count -eq 0) {
    Write-Host "  All baseline HWNDs intact. Host PID $testPid was NOT killed."
} else {
    Write-Host "  WARNING: $($missing.Count) baseline HWND(s) gone:"
    foreach ($m in $missing) { Write-Host "    $m" }
}

# Confirm host PID status
$hostStillRunning = $null -ne (Get-Process -Id $testPid -ErrorAction SilentlyContinue)
Write-Host "  Host PID $testPid still running: $hostStillRunning"
# Note: if the test window was the host's only window, the host process may exit
# naturally after WM_CLOSE. This is acceptable — we did not use taskkill/Stop-Process.
$hostExitedCleanly = -not $hostStillRunning

Write-Host ""
if ($gone -and $missing.Count -eq 0) {
    if ($hostStillRunning) {
        Write-Host "=== RESULT: PASS — test HWND closed, baseline intact, host PID alive ==="
    } else {
        Write-Host "=== RESULT: PASS — test HWND closed, baseline intact, host exited cleanly (no taskkill used) ==="
    }
    exit 0
} else {
    Write-Host "=== RESULT: FAIL ==="
    Write-Host "  gone=$gone missing=$($missing.Count)"
    exit 1
}
