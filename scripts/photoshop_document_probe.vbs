Option Explicit

Dim photoshop
Dim document
Dim fullName
Dim saved

On Error Resume Next
Set photoshop = GetObject(, "Photoshop.Application")
If Err.Number <> 0 Then
    WScript.Echo "NOT_RUNNING"
    WScript.Quit 0
End If

WScript.Echo "DOCUMENT_COUNT=" & CStr(photoshop.Documents.Count)
For Each document In photoshop.Documents
    Err.Clear
    fullName = CStr(document.FullName)
    If Err.Number <> 0 Then
        fullName = "<UNSAVED>"
    End If
    Err.Clear
    saved = CStr(document.Saved)
    If Err.Number <> 0 Then
        saved = "<UNKNOWN>"
    End If
    WScript.Echo _
        "DOCUMENT" & vbTab & _
        "name=" & CStr(document.Name) & vbTab & _
        "saved=" & saved & vbTab & _
        "path=" & fullName
Next
