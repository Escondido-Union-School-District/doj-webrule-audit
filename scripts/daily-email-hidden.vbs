' Launches the DOJ audit morning email with no console window.
' Task Scheduler runs this via wscript.exe; window style 0 starts npx fully
' hidden instead of popping a console over the user's work.
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "C:\Users\mberning\projects\eusd\doj-webrule-audit"
shell.Run """C:\Program Files\nodejs\npx.cmd"" tsx src/main.ts email morning", 0, False
