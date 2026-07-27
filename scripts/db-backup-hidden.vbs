' Launches the nightly DB backup + dashboard publish with no console window.
' Task Scheduler runs this via wscript.exe; window style 0 keeps cmd hidden.
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "C:\Users\mberning\projects\eusd\doj-webrule-audit"
shell.Run "cmd.exe /c npm run backup >> ""C:\Users\mberning\projects\eusd\doj-webrule-audit\data\backup.log"" 2>&1 && npm run publish-dashboard >> ""C:\Users\mberning\projects\eusd\doj-webrule-audit\data\backup.log"" 2>&1", 0, False
