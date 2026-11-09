Option Explicit

Dim args
Dim photoshop
Dim scriptPath
Dim jobPath
Dim progId
Dim filesystem
Dim stream
Dim scriptText
Dim fileMethodError
Dim fileMethodDescription

Set args = WScript.Arguments
If args.Count < 2 Or args.Count > 3 Then
    WScript.Echo "Usage: cscript //Nologo //U run_photoshop_jsx.vbs <jsx-path> <job-path> [prog-id]"
    WScript.Quit 2
End If

scriptPath = args.Item(0)
jobPath = args.Item(1)
progId = "Photoshop.Application"
If args.Count = 3 Then
    progId = args.Item(2)
End If

On Error Resume Next
Set photoshop = CreateObject(progId)
If Err.Number <> 0 Then
    WScript.Echo "STATUS=COM_CREATE_FAILED"
    WScript.Echo "PROGID=" & progId
    WScript.Echo "ERROR_NUMBER=" & CStr(Err.Number)
    WScript.Echo "ERROR_HEX=" & Hex(Err.Number)
    WScript.Echo "ERROR_DESCRIPTION=" & Err.Description
    WScript.Quit 3
End If

Err.Clear
photoshop.DoJavaScriptFile scriptPath, Array(jobPath), 1
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
            photoshop.DoJavaScript scriptText, Array(jobPath), 1
        End If
        If Err.Number <> 0 Then
            WScript.Echo "STATUS=JAVASCRIPT_FAILED"
            WScript.Echo "PROGID=" & progId
            WScript.Echo "FILE_METHOD_ERROR=" & CStr(fileMethodError)
            WScript.Echo "FILE_METHOD_DESCRIPTION=" & fileMethodDescription
            WScript.Echo "ERROR_NUMBER=" & CStr(Err.Number)
            WScript.Echo "ERROR_HEX=" & Hex(Err.Number)
            WScript.Echo "ERROR_DESCRIPTION=" & Err.Description
            WScript.Quit 4
        End If
        WScript.Echo "METHOD=DoJavaScript"
    Else
        WScript.Echo "STATUS=JAVASCRIPT_FAILED"
        WScript.Echo "PROGID=" & progId
        WScript.Echo "ERROR_NUMBER=" & CStr(fileMethodError)
        WScript.Echo "ERROR_HEX=" & Hex(fileMethodError)
        WScript.Echo "ERROR_DESCRIPTION=" & fileMethodDescription
        WScript.Quit 4
    End If
Else
    WScript.Echo "METHOD=DoJavaScriptFile"
End If
On Error GoTo 0

WScript.Echo "STATUS=OK"
WScript.Echo "PROGID=" & progId
WScript.Echo "Photoshop metadata-cleanup script returned."
