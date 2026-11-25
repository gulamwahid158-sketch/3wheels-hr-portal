# Stops and removes the background task.  powershell -ExecutionPolicy Bypass -File remove_sync_task.ps1
Stop-ScheduledTask -TaskName "3Wheels Biometric Sync" -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "3Wheels Biometric Sync" -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "pull_machine\.py" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host "Removed."
