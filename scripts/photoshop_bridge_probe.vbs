Option Explicit

Dim args
Dim progId
Dim scriptPath
Dim resultPath
Dim statusPath
Dim filesystem
Dim statusFile
Dim photoshop
Dim stream
Dim scriptText
Dim fileMethodError
Dim fileMethodDescription

Set args = WScript.Arguments
If args.Count <> 4 Then
    WScript.Echo "STATUS=INVALID_ARGUMENTS"
    WScript.Quit 2
End If

progId = args.Item(0)
scriptPath = args.Item(1)
resultPath = args.Item(2)
statusPath = args.Item(3)

Set filesystem = CreateObject("Scripting.FileSystemObject")
Set statusFile = filesystem.CreateTextFile(statusPath, True, True)

Sub WriteStatus(name, value)
    statusFile.WriteLine name & "=" & value
End Sub

WriteStatus "PROGID", progId
On Error Resume Next
Set photoshop = CreateObject(progId)
If Err.Number <> 0 Then
    WriteStatus "STATUS", "COM_CREATE_FAILED"
    WriteStatus "ERROR_NUMBER", CStr(Err.Number)
    WriteStatus "ERROR_HEX", Hex(Err.Number)
    WriteStatus "ERROR_DESCRIPTION", Err.Description
    statusFile.Close
    WScript.Quit 3
End If

Err.Clear
photoshop.DoJavaScriptFile scriptPath, Array(resultPath), 1
If Err.Number <> 0 Then
    fileMethodError = Err.Number
    fileMethodDescription = Err.Description
    If fileMethodError = 438 Or UCase(Hex(fileMethodError)) = "800A01B6" Or UCase(Hex(fileMethodError)) = "80020003" Then
        Err.Clear
        Set stream = CreateObject("ADODB.Stream")
        stream.Type = 2
        stream.Charset = "utf-8"
        stream.Open
        stream.LoadFromFile scriptPath
        scriptText = stream.ReadText
        stream.Close
        If Err.Number = 0 Then
            photoshop.DoJavaScript scriptText, Array(resultPath), 1
        End If
        If Err.Number <> 0 Then
            WriteStatus "STATUS", "JAVASCRIPT_INLINE_FAILED"
            WriteStatus "FILE_METHOD_ERROR", CStr(fileMethodError)
            WriteStatus "FILE_METHOD_DESCRIPTION", fileMethodDescription
            WriteStatus "ERROR_NUMBER", CStr(Err.Number)
            WriteStatus "ERROR_HEX", Hex(Err.Number)
            WriteStatus "ERROR_DESCRIPTION", Err.Description
            statusFile.Close
            WScript.Quit 4
        End If
        WriteStatus "METHOD", "DoJavaScript"
    Else
        WriteStatus "STATUS", "JAVASCRIPT_FILE_FAILED"
        WriteStatus "ERROR_NUMBER", CStr(fileMethodError)
        WriteStatus "ERROR_HEX", Hex(fileMethodError)
        WriteStatus "ERROR_DESCRIPTION", fileMethodDescription
        statusFile.Close
        WScript.Quit 4
    End If
Else
    WriteStatus "METHOD", "DoJavaScriptFile"
End If
On Error GoTo 0

WriteStatus "STATUS", "OK"
statusFile.Close
WScript.Quit 0
