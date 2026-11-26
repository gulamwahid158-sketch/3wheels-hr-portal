# Registers "3Wheels Website Check": runs website_check.py hidden every 5 minutes while you are signed in to Windows.
# Run it once:   powershell -ExecutionPolicy Bypass -File install_website_check.ps1
# Remove it:     Unregister-ScheduledTask -TaskName "3Wheels Website Check" -Confirm:$false
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pyw = (Get-Command pythonw.exe -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $pyw -Argument "website_check.py" -WorkingDirectory $dir
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "3Wheels Website Check" -Action $action -Trigger @($logon, $every) -Settings $set -Description "Checks hr.3wheels.ai every 5 minutes and keeps the server awake" -Force | Out-Null
Start-ScheduledTask -TaskName "3Wheels Website Check"
Write-Host "Done. Checks every 5 minutes. Log: $dir\website_check.log"
