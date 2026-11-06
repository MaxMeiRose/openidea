[CmdletBinding()]
param(
    [string]$Repository = 'MaxMeiRose/openidea',
    [string]$InstallDirectory = "$env:LOCALAPPDATA\OpenIDEA"
)

$ErrorActionPreference = 'Stop'
$stateDirectory = Join-Path $env:LOCALAPPDATA 'OpenIDEA-FeatureDev'
New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null
$updateScript = Join-Path $stateDirectory 'update-feature-dev.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'update-feature-dev.ps1') -Destination $updateScript -Force
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$updateScript`" -Repository `"$Repository`" -InstallDirectory `"$InstallDirectory`""
$action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments
$hourly = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Hours 1)
$logon = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 45) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'OpenIDEA FeatureDev Update' -Action $action -Trigger @($hourly, $logon) -Settings $settings -Principal $principal -Description 'Install tested OpenIDEA feature-dev releases when the app is closed.' -Force |
    Select-Object TaskName, State
Write-Output "Update script: $updateScript"
Write-Output "Log: $(Join-Path $stateDirectory 'update.log')"
