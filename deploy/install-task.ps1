$root = Split-Path -Parent $PSScriptRoot
$vbs  = Join-Path $root 'coach-start.vbs'
$u    = whoami
$action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"')
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $u
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 1000 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'AcademyCoach' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'AcademyCoach'
Write-Output ('installed-and-started: ' + $vbs)
