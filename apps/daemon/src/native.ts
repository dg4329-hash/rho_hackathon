/**
 * OS-level approval dialogs and notifications. Universal: works no matter which coding tool the
 * owner uses (Claude Code, Codex, Cursor, plain CLI) because the coding tool is not involved.
 *   macOS   osascript `display dialog` / `display notification`
 *   Windows PowerShell MessageBox (WPF) / balloon-less: falls back to console print
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
      // A small always-on-top message box: the same mechanism as approvals, which is known to render from the
      // background daemon on Windows. Toasts (MESH_TOAST=1) are nicer but unverified from a hidden process.
      const ps = `Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show($env:MESH_BODY, $env:MESH_TITLE, 'OK', 'Information', 'OK', 'DefaultDesktopOnly')`;
      spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { env: { ...process.env, MESH_TITLE: title, MESH_BODY: body.slice(0, 400) }, stdio: "ignore", detached: true, windowsHide: true }).unref();
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
