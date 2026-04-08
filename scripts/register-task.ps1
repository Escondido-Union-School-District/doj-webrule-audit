# Unregister existing task if present
Unregister-ScheduledTask -TaskName "DOJ-WebRule-ReviewUI" -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-WindowStyle Hidden -NoProfile -Command `"Set-Location 'C:\Users\mberning\projects\eusd\doj-webrule-audit'; `$env:NO_OPEN='1'; npx tsx src/server/index.ts`"" -WorkingDirectory "C:\Users\mberning\projects\eusd\doj-webrule-audit"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName "DOJ-WebRule-ReviewUI" -Action $action -Trigger $trigger -Settings $settings -Description "Starts the DOJ WebRule Review UI server on login (hidden)"
