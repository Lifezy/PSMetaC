Option Explicit

Dim photoshop
Dim documentCount
Dim sourcePath
Dim sourceKey
Dim document
Dim documentPath
Dim fileSystem
Dim progId

sourcePath = ""
progId = "Photoshop.Application"
If WScript.Arguments.Count > 0 Then
    sourcePath = WScript.Arguments.Item(0)
End If
If WScript.Arguments.Count > 1 Then
    progId = WScript.Arguments.Item(1)
End If

Set fileSystem = CreateObject("Scripting.FileSystemObject")
sourceKey = ""
If sourcePath <> "" Then
    On Error Resume Next
    sourceKey = LCase(fileSystem.GetAbsolutePathName(sourcePath))
    Err.Clear
    On Error GoTo 0
End If

On Error Resume Next
Set photoshop = GetObject(, progId)
If Err.Number <> 0 Then
    WScript.Echo "NOT_RUNNING"
    WScript.Quit 0
End If

Err.Clear
documentCount = photoshop.Documents.Count
If Err.Number <> 0 Then
    WScript.Echo "BUSY_UNKNOWN"
    WScript.Quit 12
End If

If documentCount > 0 Then
    If sourceKey <> "" Then
        For Each document In photoshop.Documents
            Err.Clear
            documentPath = CStr(document.FullName)
            If Err.Number = 0 Then
                If LCase(fileSystem.GetAbsolutePathName(documentPath)) = sourceKey Then
                    WScript.Echo "SOURCE_OPEN"
                    WScript.Quit 11
                End If
            End If
        Next
    End If
    WScript.Echo "BUSY_DOCUMENTS=" & CStr(documentCount)
    WScript.Quit 10
End If

WScript.Echo "IDLE"
WScript.Quit 0
