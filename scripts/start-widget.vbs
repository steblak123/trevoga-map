' Starts the widget without a console window. Used by the autostart shortcut.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
electron = root & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(electron) Then
  MsgBox "Electron not found. Run scripts\install.bat first.", 48, "Trevoga map"
  WScript.Quit 1
End If
sh.CurrentDirectory = root
sh.Run """" & electron & """ """ & root & """", 0, False
