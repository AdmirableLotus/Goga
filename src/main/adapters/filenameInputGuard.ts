// Executed by the filename PowerShell helper immediately before each SendKeys.
// Wrappers isolate the native boundary so the real guard can be tested without
// generating keyboard input or opening a window.
export const FILENAME_INPUT_GUARD_PS = `
function Invoke-GuardedFilenameKeys([long]$ExpectedHwnd, [int]$ExpectedPid, [string]$CancelPath, [string]$Keys) {
  if (Test-Path -LiteralPath $CancelPath) { throw 'filename_input_cancelled' }
  $foreground = Get-FilenameForeground
  if ($ExpectedHwnd -eq 0 -or $ExpectedPid -le 0 -or $foreground -ne $ExpectedHwnd -or
      (Get-FilenameOwner $ExpectedHwnd) -ne $ExpectedPid -or
      (Get-FilenameOwner $foreground) -ne $ExpectedPid) { throw 'filename_input_target_mismatch' }
  if (Test-Path -LiteralPath $CancelPath) { throw 'filename_input_cancelled' }
  Send-FilenameKeys $Keys
}
`
