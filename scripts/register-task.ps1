$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c cd /d C:\Users\mberning\projects\eusd\doj-webrule-audit && set NO_OPEN=1 && npx tsx src/server/index.ts" -WorkingDirectory "C:\Users\mberning\projects\eusd\doj-webrule-audit"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName "DOJ-WebRule-ReviewUI" -Action $action -Trigger $trigger -Settings $settings -Description "Starts the DOJ WebRule Review UI server on login"
