Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$children = $root.FindAll(
  [System.Windows.Automation.TreeScope]::Children,
  [System.Windows.Automation.Condition]::TrueCondition
)

foreach ($w in $children) {
  $name = $w.Current.Name
  $pid2  = $w.Current.ProcessId
  $hwnd = $w.Current.NativeWindowHandle
  if ($name.Length -gt 0) {
    Write-Output "HWND=$hwnd PID=$pid2 Title=$name"
  }
}
