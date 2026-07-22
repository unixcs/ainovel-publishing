$ErrorActionPreference = "Stop"
$TaskName = "AinovelPublisherCompanion"
$StartupVbs = Join-Path ([Environment]::GetFolderPath("Startup")) "AinovelPublisherCompanion.vbs"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
  Write-Host "Removed scheduled task: $TaskName"
}
if (Test-Path $StartupVbs) {
  Remove-Item $StartupVbs -Force
  Write-Host "Removed Startup launcher: $StartupVbs"
}
