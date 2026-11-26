# HarnessAMS picker.ps1 (2026-11-26): the native FILE-open dialog behind
# POST /api/pick-file (the add-report flow's system picker). Windows
# PowerShell 5.1 only: this script file stays pure ASCII (PS 5.1 reads .ps1
# as ANSI) and the -STA flag is required on powershell.exe (pwsh 7+ is STA
# by default and has no -STA flag). Validated by the 2026-11-26 spike (root
# repo dev/spike/filedialog-20261126): the dialog pops in the foreground
# even though a background host process spawned it, and cold start is ~1 s.
#
# Foreground trick, copied from the dsh host's directory-picker native module
# (dsh-host-directory-picker-native/src/win32-dialog-logic.ts): one synthetic
# Alt press (keybd_event VK_MENU down+up) right before ShowDialog makes
# Windows count this background process as the most recent input owner, so
# the dialog is allowed to take the foreground instead of opening behind
# every window.
#
# Output contract for the spawning driver (src/picker.js):
#   exit 0  -> chosen absolute path on stdout (UTF-8, no newline added)
#   exit 2  -> user cancelled (empty stdout)
#   exit 1  -> script error (message on stderr)

param(
  [string]$Title = 'Pick a file',
  [string]$Filter = 'HTML files (*.html;*.htm)|*.html;*.htm|All files (*.*)|*.*',
  [string]$InitialDir = ''
)

$ErrorActionPreference = 'Stop'

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FgFocus {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
'@

$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = $Title
$dlg.Filter = $Filter
$dlg.CheckFileExists = $true
if ($InitialDir) {
  try {
    if (Test-Path -LiteralPath $InitialDir) { $dlg.InitialDirectory = (Resolve-Path -LiteralPath $InitialDir).Path }
  } catch {}
}

# The lone Alt may briefly highlight the focused window's menu bar; that is
# the accepted tradeoff the dsh host took as well.
[FgFocus]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[FgFocus]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)

if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dlg.FileName)
  exit 0
}
exit 2
