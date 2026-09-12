/**
 * OS-level approval dialogs and notifications. Universal: works no matter which coding tool the
 * owner uses (Claude Code, Codex, Cursor, plain CLI) because the coding tool is not involved.
 *   macOS   osascript `display dialog` / `display notification`
 *   Windows PowerShell WPF approval dialogs / native topmost message alerts
 *   Linux   zenity --question / notify-send
 * Every function is best-effort and returns null when the platform has no usable UI.
 */
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";

export interface DialogRequest { title: string; body: string; timeoutSeconds: number }

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; out: string } | null> {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); } catch { return resolve(null); }
    let out = "";
    const t = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("error", () => { clearTimeout(t); resolve(null); });
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

function has(bin: string): boolean {
  if (process.platform === "win32") return spawnSync("where", [bin], { stdio: "ignore" }).status === 0;
  return spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
}
/** A GUI session we can draw a dialog on. Over ssh / in a container there is none. */
function guiSession(): boolean {
  if (process.platform === "win32") return !process.env.SSH_CONNECTION;
  if (process.platform === "darwin") return !process.env.SSH_CONNECTION && !process.env.SSH_TTY;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** True if a native dialog is likely to work here. */
export function nativeDialogAvailable(): boolean {
  if (process.env.MESH_APPROVE === "tty") return false;
  if (!guiSession()) return false;
  if (process.platform === "darwin") return true;
  if (process.platform === "win32") return true;
  return has("zenity");
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/** Ask the owner with a native dialog. Resolves 'approved' | 'denied' | 'timeout', or null if no dialog could be shown. */
export async function nativeApprove(req: DialogRequest): Promise<"approved" | "denied" | "timeout" | null> {
  const ms = (req.timeoutSeconds + 5) * 1000;
  if (process.platform === "darwin") {
    const script = `display dialog "${esc(req.body)}" with title "${esc(req.title)}" buttons {"Deny", "Approve"} default button "Approve" cancel button "Deny" with icon caution giving up after ${req.timeoutSeconds}`;
    const r = await run("osascript", ["-e", script], process.env, ms);
    if (!r) return null;
    if (/gave up:true/.test(r.out)) return "timeout";
    if (/button returned:Approve/.test(r.out)) return "approved";
    if (r.code !== 0 && !/button returned/.test(r.out) && !/User canceled/.test(r.out)) return null; // osascript couldn't show UI
    return "denied"; // cancel button exits non-zero with "User canceled" 
  }
  if (process.platform === "win32") {
    const ps = `Add-Type -AssemblyName PresentationFramework; $r=[System.Windows.MessageBox]::Show($env:MESH_BODY,$env:MESH_TITLE,'YesNo','Question','No'); Write-Output $r`;
    const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { ...process.env, MESH_BODY: req.body, MESH_TITLE: req.title }, ms);
    if (!r) return null;
    if (r.code === null) return "timeout";
    if (!/Yes|No/.test(r.out)) return null; // PowerShell couldn't show a MessageBox (no desktop session)
    return /Yes/.test(r.out) ? "approved" : "denied";
  }
  if (has("zenity")) {
    const r = await run("zenity", ["--question", "--title", req.title, "--text", req.body, "--ok-label", "Approve", "--cancel-label", "Deny", "--timeout", String(req.timeoutSeconds), "--width", "480"], process.env, ms);
    if (!r) return null;
    if (r.code === 5) return "timeout";
    if (r.code !== 0 && r.code !== 1) return null; // zenity failed to open a display
    return r.code === 0 ? "approved" : "denied";
  }
  return null;
}

/** Fire-and-forget notification (messages, results). */
export function nativeNotify(title: string, body: string): void {
  try {
    if (process.platform === "darwin") {
      spawn("osascript", ["-e", `display notification "${esc(body).slice(0, 200)}" with title "${esc(title)}"`], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "linux" && has("notify-send")) {
      spawn("notify-send", [title, body.slice(0, 200)], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "win32" && process.env.MESH_TOAST !== "1") {
      // The daemon can inherit a noninteractive desktop even in the owner's Windows session. Launch the
      // alert on winsta0\default and use a native topmost MessageBox owned by the foreground window.
      // WPF windows can register in the taskbar here without rendering any usable content.
      const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MeshNativeAlert {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int MessageBoxW(IntPtr owner, string body, string title, uint flags);
}
'@
$owner = [MeshNativeAlert]::GetForegroundWindow()
[void][MeshNativeAlert]::MessageBoxW($owner, $env:MESH_BODY, $env:MESH_TITLE, [uint32]0x00050040)
`;
      const launch = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class MeshDesktopLaunch {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct StartupInfo {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct ProcessInfo {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CreateProcessW(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit,
    int flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  public static int Launch(string app, string encodedCommand) {
    var startup = new StartupInfo();
    startup.cb = Marshal.SizeOf(typeof(StartupInfo));
    startup.lpDesktop = @"winsta0\\default";
    var command = new StringBuilder(((char)34) + app + ((char)34) + " -NoProfile -NonInteractive -STA -EncodedCommand " + encodedCommand);
    ProcessInfo process;
    if (!CreateProcessW(app, command, IntPtr.Zero, IntPtr.Zero, false, 0x08000000, IntPtr.Zero, null, ref startup, out process))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return process.dwProcessId;
  }
}
'@
Write-Output ([MeshDesktopLaunch]::Launch((Join-Path $PSHOME 'powershell.exe'), $env:MESH_ALERT_SCRIPT))
`;
      const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", launch], {
        env: {
          ...process.env,
          MESH_TITLE: title,
          MESH_BODY: body.slice(0, 400),
          MESH_ALERT_SCRIPT: Buffer.from(ps, "utf16le").toString("base64"),
        },
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      let errorOutput = "";
      child.stdout.on("data", (data: Buffer) => {
        if (process.env.MESH_ALERT_DIAGNOSTICS === "1") console.warn(`mesh: Windows message alert pid ${data.toString().trim()}`);
      });
      child.stderr.on("data", (data: Buffer) => { errorOutput = (errorOutput + data.toString()).slice(-2000); });
      child.on("error", (err) => console.warn(`mesh: Windows message alert failed: ${err.message}`));
      child.on("close", (code) => {
        if (code !== 0) console.warn(`mesh: Windows message alert exited (${code}): ${errorOutput.trim()}`);
      });
      child.unref();
    } else if (process.platform === "win32") {
      // Native Windows 10/11 toast via WinRT (no modules needed). Falls back to a tray balloon if toasts are unavailable.
      const ps = `
$ErrorActionPreference = 'SilentlyContinue'
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $t = [System.Security.SecurityElement]::Escape($env:MESH_TITLE); $b = [System.Security.SecurityElement]::Escape($env:MESH_BODY)
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual></toast>")
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
} catch {
  [void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')
  $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true
  $n.ShowBalloonTip(5000, $env:MESH_TITLE, $env:MESH_BODY, [System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep 6; $n.Dispose()
}`;
      spawn("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps], { env: { ...process.env, MESH_TITLE: title, MESH_BODY: body.slice(0, 200) }, stdio: "ignore", detached: true, windowsHide: true }).unref();
    }
  } catch { /* best effort */ }
}
