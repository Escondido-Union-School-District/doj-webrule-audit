# Unregister existing task if present
Unregister-ScheduledTask -TaskName "DOJ-WebRule-ReviewUI" -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"C:\Users\mberning\projects\eusd\doj-webrule-audit\scripts\start-server.vbs`"" -WorkingDirectory "C:\Users\mberning\projects\eusd\doj-webrule-audit"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName "DOJ-WebRule-ReviewUI" -Action $action -Trigger $trigger -Settings $settings -Description "Starts the DOJ WebRule Review UI server on login (hidden)"
