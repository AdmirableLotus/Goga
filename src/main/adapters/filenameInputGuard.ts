// Executed by the filename PowerShell helper immediately before each SendKeys.
// Wrappers isolate the native boundary so the real guard can be tested without
// generating keyboard input or opening a window.
export const FILENAME_INPUT_GUARD_PS = `
function Assert-FilenameChecks([string]$Stage, $Checks, $Context) {
  $failed = @($Checks | Where-Object { -not $_.passed })
  Write-FilenameDiagnostic @{ stage=$Stage; checks=@($Checks); identities=$Context; rejected=($failed.Count -gt 0) }
  if ($failed.Count -gt 0) {
    $first = $failed[0]
    throw "filename_input_target_mismatch:$($first.reason) expected=$($first.expected) observed=$($first.observed)"
  }
}
function Get-FilenameInputChecks([long]$FrameHwnd, [long]$DialogHwnd, [long]$ControlHwnd, [int]$ExpectedPid) {
  $frameAlive = Test-FilenameWindow $FrameHwnd
  $dialogAlive = Test-FilenameWindow $DialogHwnd
  $controlAlive = Test-FilenameWindow $ControlHwnd
  $dialogOwned = Test-FilenameOwnerChain $DialogHwnd $FrameHwnd
  $controlInDialog = Test-FilenameChild $DialogHwnd $ControlHwnd
  $framePid = Get-FilenameOwner $FrameHwnd
  $dialogPid = Get-FilenameOwner $DialogHwnd
  $controlPid = Get-FilenameOwner $ControlHwnd
  $checks = @(
    @{ reason='frame_hwnd_nonzero'; expected='nonzero'; observed=$FrameHwnd; passed=($FrameHwnd -ne 0) },
    @{ reason='dialog_hwnd_nonzero'; expected='nonzero'; observed=$DialogHwnd; passed=($DialogHwnd -ne 0) },
    @{ reason='filename_control_hwnd_nonzero'; expected='nonzero'; observed=$ControlHwnd; passed=($ControlHwnd -ne 0) },
    @{ reason='expected_pid_positive'; expected='positive'; observed=$ExpectedPid; passed=($ExpectedPid -gt 0) },
    @{ reason='frame_exists'; expected=$true; observed=$frameAlive; passed=$frameAlive },
    @{ reason='dialog_exists'; expected=$true; observed=$dialogAlive; passed=$dialogAlive },
    @{ reason='filename_control_exists'; expected=$true; observed=$controlAlive; passed=$controlAlive },
    @{ reason='dialog_owned_by_frame'; expected=$true; observed=$dialogOwned; passed=($dialogOwned -eq $true) },
    @{ reason='filename_control_child_of_dialog'; expected=$true; observed=$controlInDialog; passed=$controlInDialog },
    @{ reason='frame_pid'; expected=$ExpectedPid; observed=$framePid; passed=($framePid -eq $ExpectedPid) },
    @{ reason='dialog_pid'; expected=$ExpectedPid; observed=$dialogPid; passed=($dialogPid -eq $ExpectedPid) },
    @{ reason='filename_control_pid'; expected=$ExpectedPid; observed=$controlPid; passed=($controlPid -eq $ExpectedPid) }
  )
  return @{ checks=$checks; frame=@{hwnd=$FrameHwnd;pid=$framePid;alive=$frameAlive}; dialog=@{hwnd=$DialogHwnd;pid=$dialogPid;alive=$dialogAlive}; filenameControl=@{hwnd=$ControlHwnd;pid=$controlPid;alive=$controlAlive}; dialogOwnedByFrame=$dialogOwned; filenameControlInDialog=$controlInDialog }
}
function Assert-FilenameInputTarget([long]$FrameHwnd, [long]$DialogHwnd, [long]$ControlHwnd, [int]$ExpectedPid) {
  $context = Get-FilenameContext
  $identity = Get-FilenameInputChecks $FrameHwnd $DialogHwnd $ControlHwnd $ExpectedPid
  $foreground = Get-FilenameForeground
  $foregroundPid = Get-FilenameOwner $foreground
  $checks = @($identity.checks) + @(
    @{ reason='foreground_hwnd'; expected=$DialogHwnd; observed=$foreground; passed=($foreground -eq $DialogHwnd) },
    @{ reason='foreground_pid'; expected=$ExpectedPid; observed=$foregroundPid; passed=($foregroundPid -eq $ExpectedPid) }
  )
  $context.expectedInput = @{frameHwnd=$FrameHwnd;dialogHwnd=$DialogHwnd;filenameControlHwnd=$ControlHwnd;pid=$ExpectedPid}
  $context.verifiedAtCheck = $identity
  $context.foregroundAtCheck = @{ hwnd=$foreground; pid=$foregroundPid }
  Assert-FilenameChecks $script:filenameStage $checks $context
}
function Invoke-GuardedFilenameKeys([long]$FrameHwnd, [long]$DialogHwnd, [long]$ControlHwnd, [int]$ExpectedPid, [string]$CancelPath, [string]$Keys) {
  if (Test-Path -LiteralPath $CancelPath) { throw 'filename_input_cancelled' }
  Assert-FilenameInputTarget $FrameHwnd $DialogHwnd $ControlHwnd $ExpectedPid
  if (Test-Path -LiteralPath $CancelPath) { throw 'filename_input_cancelled' }
  Send-FilenameKeys $Keys
}
`
