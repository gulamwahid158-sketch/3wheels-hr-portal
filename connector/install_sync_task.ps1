# Registers "3Wheels Biometric Sync": starts pull_machine.py hidden when you sign in to Windows, and again every 10 minutes if it is not running
# (a second copy exits at once). Run it once:  powershell -ExecutionPolicy Bypass -File install_sync_task.ps1
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pyw = (Get-Command pythonw.exe -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $pyw -Argument "pull_machine.py" -WorkingDirectory $dir
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
       -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "3Wheels Biometric Sync" -Action $action -Trigger @($logon, $every) -Settings $set -Description "Reads punches from the CP PLUS machine and sends them to hr.3wheels.ai" -Force | Out-Null
Start-ScheduledTask -TaskName "3Wheels Biometric Sync"
Write-Host "Done. It runs in the background now and after every sign in. Log: $dir\pull_machine.log"
