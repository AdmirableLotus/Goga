$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$debugFile = Join-Path $env:TEMP 'get-node-debug.txt'
"START $(Get-Date)" | Set-Content $debugFile

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$win = $null
foreach($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)){
    $wb = $w.Current.BoundingRectangle
    if($w.Current.Name -like '*Visual Studio Code*' -and -not [double]::IsInfinity($wb.X) -and $wb.Width -gt 0){
        $win = $w; break
    }
}

if(-not $win){
    "NO WINDOW FOUND" | Add-Content $debugFile
    Write-Output "[]"
    exit
}
"WINDOW: $($win.Current.Name)" | Add-Content $debugFile

function Get-Node {
    param($el, [int]$depth)
    "ENTER depth=$depth name=$($el.Current.Name)" | Add-Content $debugFile
    if($depth -gt 2){ "MAX DEPTH REACHED" | Add-Content $debugFile; return }
    $b = $el.Current.BoundingRectangle
    "BOUNDS x=$($b.X) y=$($b.Y) w=$($b.Width) h=$($b.Height)" | Add-Content $debugFile
    if([double]::IsInfinity($b.X) -or [double]::IsNaN($b.X) -or $b.Width -lt 0){
        "SKIP invalid bounds" | Add-Content $debugFile
        return
    }
    $cx = if($b.Width -gt 0){ [int]($b.X + $b.Width/2) } else { 0 }
    $cy = if($b.Height -gt 0){ [int]($b.Y + $b.Height/2) } else { 0 }
    $node = [PSCustomObject]@{
        name     = $el.Current.Name
        role     = $el.Current.ControlType.ProgrammaticName -replace 'ControlType.',''
        x        = $cx
        y        = $cy
        width    = [int][Math]::Max(0,[Math]::Min($b.Width,9999))
        height   = [int][Math]::Max(0,[Math]::Min($b.Height,9999))
        children = [System.Collections.ArrayList]::new()
    }
    "NODE CREATED: $($node.name) role=$($node.role)" | Add-Content $debugFile
    $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    "KIDS COUNT: $($kids.Count)" | Add-Content $debugFile
    foreach($kid in $kids){
        $child = Get-Node $kid ($depth + 1)
        if($null -ne $child){ [void]$node.children.Add($child) }
    }
    "RETURNING node: $($node.name) children=$($node.children.Count)" | Add-Content $debugFile
    return $node
}

"CALLING Get-Node" | Add-Content $debugFile
try {
    $tree = Get-Node $win 0
    "RETURNED tree null=$($null -eq $tree)" | Add-Content $debugFile
    if($tree){
        "CONVERTING TO JSON" | Add-Content $debugFile
        $json = $tree | ConvertTo-Json -Depth 6 -Compress
        "JSON length=$($json.Length)" | Add-Content $debugFile
        Write-Output $json
    } else {
        "tree is null - writing []" | Add-Content $debugFile
        Write-Output "[]"
    }
} catch {
    "TOP LEVEL ERROR: $($_.Exception.Message)" | Add-Content $debugFile
    "STACK: $($_.ScriptStackTrace)" | Add-Content $debugFile
    Write-Output "[]"
}
"END $(Get-Date)" | Add-Content $debugFile
