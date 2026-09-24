# Adds (default) or removes (-Off) the widget from Windows startup.
param([switch]$Off)

$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'trevoga-map.lnk'

if ($Off) {
    if (Test-Path $lnk) { Remove-Item $lnk -Force }
    Write-Host 'Autostart disabled.'
    exit 0
}

$vbs = Join-Path $PSScriptRoot 'start-widget.vbs'
$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$sc.Arguments = '"' + $vbs + '"'
$sc.WorkingDirectory = Split-Path $PSScriptRoot -Parent
$sc.Description = 'Trevoga map widget'
$sc.Save()
Write-Host "Autostart enabled: $lnk"
