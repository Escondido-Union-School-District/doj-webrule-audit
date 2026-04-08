Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\mberning\projects\eusd\doj-webrule-audit"
WshShell.Environment("Process").Item("NO_OPEN") = "1"
WshShell.Run "cmd /c npx tsx src/server/index.ts", 0, False
