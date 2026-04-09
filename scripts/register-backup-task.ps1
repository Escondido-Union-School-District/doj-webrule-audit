# Registers a Windows scheduled task to back up the DOJ audit database
# every day at 3:00 AM. Run this script ONCE (right-click → Run with PowerShell,
# or run from an admin terminal with: powershell -ExecutionPolicy Bypass -File scripts/register-backup-task.ps1).
#
# To remove the task later:
#   Unregister-ScheduledTask -TaskName "DOJ-WebRule-DB-Backup" -Confirm:$false

$ErrorActionPreference = "Stop"

$taskName = "DOJ-WebRule-DB-Backup"
$projectRoot = "C:\Users\mberning\projects\eusd\doj-webrule-audit"
$logPath = Join-Path $projectRoot "data\backup.log"

# Unregister existing task if present (idempotent — safe to re-run)
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

# Build the action: invoke npm run backup and append output to a log file.
# We wrap in cmd /c so the redirection works regardless of which shell.
$cmd = "cmd.exe"
$arg = "/c npm run backup >> `"$logPath`" 2>&1"

$action = New-ScheduledTaskAction `
    -Execute $cmd `
    -Argument $arg `
    -WorkingDirectory $projectRoot

# Trigger: every day at 3:00 AM
$trigger = New-ScheduledTaskTrigger -Daily -At 3:00AM

# Settings: run on battery, don't stop on battery, allow up to 30 min runtime
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Daily backup of DOJ audit DB to local + Google Drive (3 AM)"

Write-Host ""
Write-Host "Scheduled task '$taskName' registered."
Write-Host "  Runs:    Daily at 3:00 AM"
Write-Host "  Command: npm run backup"
Write-Host "  Log:     $logPath"
Write-Host ""
Write-Host "To verify: schtasks /query /tn '$taskName' /v"
Write-Host "To trigger now (test): schtasks /run /tn '$taskName'"
Write-Host "To remove: Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
