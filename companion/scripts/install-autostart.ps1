param(
  [string]$Executable = "$PSScriptRoot\..\dist\ainovel-publisher.exe"
)

$ErrorActionPreference = "Stop"
$Executable = (Resolve-Path $Executable).Path
$TaskName = "AinovelPublisherCompanion"
$StartupDir = [Environment]::GetFolderPath("Startup")
$StartupVbs = Join-Path $StartupDir "AinovelPublisherCompanion.vbs"

& $Executable init

$Action = New-ScheduledTaskAction -Execute $Executable -Argument "serve --sync-first"
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)

try {
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description "Ainovel publishing companion on 127.0.0.1:8787" `
    -Force `
    -ErrorAction Stop | Out-Null
  Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if (Test-Path $StartupVbs) { Remove-Item $StartupVbs -Force }
  Write-Host "Installed and started scheduled task: $TaskName"
} catch {
  $EscapedExecutable = $Executable.Replace('"', '""')
  $VbsContent = @"
Set shell = CreateObject("WScript.Shell")
shell.Run """$EscapedExecutable"" serve --sync-first", 0, False
"@
  Set-Content -Path $StartupVbs -Value $VbsContent -Encoding ASCII
  Start-Process -FilePath $Executable -ArgumentList "serve --sync-first" -WorkingDirectory (Split-Path $Executable) -WindowStyle Hidden
  Write-Host "Scheduled Task registration was unavailable; installed per-user Startup launcher instead: $StartupVbs"
}

Write-Host "Use '& $Executable print-token' to get the Chrome extension token."
