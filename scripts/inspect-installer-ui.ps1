param(
  [string]$InstallerPath = "",
  [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$package = Get-Content -Raw (Join-Path $projectRoot "package.json") | ConvertFrom-Json
$releaseTag = ($package.version -replace '[^A-Za-z0-9._-]', '-')
if (-not $InstallerPath) {
  $InstallerPath = Join-Path $projectRoot "dist\PSMetaC_Setup_v$($package.version).exe"
}
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $projectRoot ".test-artifacts\installer-$releaseTag"
}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PSMetaCInstallerWindow {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")]
  public static extern IntPtr GetDlgItem(IntPtr hDlg, int nIDDlgItem);
  [DllImport("user32.dll")]
  public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
}
"@

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$started = Start-Process -FilePath $InstallerPath -PassThru

function Get-InstallerProcess {
  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    $candidate = Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $_.MainWindowHandle -ne 0 -and
      ($_.Id -eq $started.Id -or $_.ProcessName -like "PSMetaC_Setup*")
    } | Select-Object -First 1
    if ($candidate) { return $candidate }
    Start-Sleep -Milliseconds 100
  }
  throw "Installer window did not appear."
}

function Save-WindowScreenshot($process, [string]$fileName) {
  $rect = New-Object PSMetaCInstallerWindow+RECT
  if (-not [PSMetaCInstallerWindow]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) {
    throw "Unable to read installer window bounds."
  }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $deviceContext = $graphics.GetHdc()
  $rendered = [PSMetaCInstallerWindow]::PrintWindow(
    $process.MainWindowHandle,
    $deviceContext,
    2
  )
  $graphics.ReleaseHdc($deviceContext)
  if (-not $rendered) {
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
  }
  $target = Join-Path $OutputDirectory $fileName
  $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $bitmap.Dispose()
  return $target
}

function Get-WindowElements($process) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
  return $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
}

function Invoke-NamedButton($process, [string[]]$names) {
  $fallback = $null
  foreach ($element in (Get-WindowElements $process)) {
    if ($element.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button) { continue }
    if ($element.Current.AutomationId -eq "1") { $fallback = $element }
    $name = $element.Current.Name
    if (-not ($names | Where-Object { $name -like "*$_*" })) { continue }
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    return $name
  }
  if ($fallback) {
    $name = $fallback.Current.Name
    $pattern = $fallback.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    return $name
  }
  $nativeNext = [PSMetaCInstallerWindow]::GetDlgItem($process.MainWindowHandle, 1)
  if ($nativeNext -ne [IntPtr]::Zero) {
    [PSMetaCInstallerWindow]::SendMessage($nativeNext, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    return "control-id-1"
  }
  throw "Button not found: $($names -join ', ')"
}

try {
  $process = Get-InstallerProcess
  $process.WaitForInputIdle(5000) | Out-Null
  Start-Sleep -Milliseconds 350
  $welcomeScreenshot = Save-WindowScreenshot $process "01-welcome.png"
  $welcomeText = @(Get-WindowElements $process | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
  $buttons = @(
    Get-WindowElements $process | Where-Object {
      $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button
    } | ForEach-Object { $_.Current.Name }
  )
  $controlMap = @(
    Get-WindowElements $process | ForEach-Object {
      [ordered]@{
        name = $_.Current.Name
        type = $_.Current.ControlType.ProgrammaticName
        x = [math]::Round($_.Current.BoundingRectangle.X)
        y = [math]::Round($_.Current.BoundingRectangle.Y)
        width = [math]::Round($_.Current.BoundingRectangle.Width)
        height = [math]::Round($_.Current.BoundingRectangle.Height)
      }
    }
  )
  # Keep this Windows PowerShell 5.1 helper ASCII-only so it parses correctly
  # regardless of the active system code page or whether the file has a BOM.
  $startButtonLabel = -join @([char]0x5F00, [char]0x59CB, [char]0x5B89, [char]0x88C5)
  $installPathLabel = -join @([char]0x5B89, [char]0x88C5, [char]0x4F4D, [char]0x7F6E)
  $result = [ordered]@{
    installer = $InstallerPath
    welcomeScreenshot = $welcomeScreenshot
    welcomeText = $welcomeText
    buttons = $buttons
    controls = $controlMap
    versionVisible = ($welcomeText -join " ") -like "*$($package.version)*"
    purposeVisible = ($welcomeText -join " ") -like "*DocumentAncestors*"
    startButtonVisible = $welcomeText.Contains($startButtonLabel)
    installPathControlVisible = $welcomeText.Contains($installPathLabel)
  }
  $result | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $OutputDirectory "acceptance.json")
  $result | ConvertTo-Json -Depth 5
  $failed = @()
  if (-not $result.versionVisible) { $failed += "version-not-visible" }
  if (-not $result.purposeVisible) { $failed += "purpose-not-visible" }
  if (-not $result.startButtonVisible) { $failed += "start-button-not-visible" }
  if (-not $result.installPathControlVisible) { $failed += "install-path-not-visible" }
  if ($failed.Count -gt 0) {
    throw "Installer UI acceptance failed: $($failed -join ', ')"
  }
} finally {
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Id -eq $started.Id -or $_.ProcessName -like "PSMetaC_Setup*"
  } | ForEach-Object { $_.Kill() }
}
