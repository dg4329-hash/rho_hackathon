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
  return spawnSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" }).status === 0;
}

/** True if a native dialog is likely to work here. */
export function nativeDialogAvailable(): boolean {
  if (process.env.MESH_APPROVE === "tty") return false;
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
    return "denied"; // cancel button exits non-zero
  }
  if (process.platform === "win32") {
    const ps = `Add-Type -AssemblyName PresentationFramework; $r=[System.Windows.MessageBox]::Show($env:MESH_BODY,$env:MESH_TITLE,'YesNo','Question','No'); Write-Output $r`;
    const r = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { ...process.env, MESH_BODY: req.body, MESH_TITLE: req.title }, ms);
    if (!r) return null;
    if (r.code === null) return "timeout";
    return /Yes/.test(r.out) ? "approved" : "denied";
  }
  if (has("zenity")) {
    const r = await run("zenity", ["--question", "--title", req.title, "--text", req.body, "--ok-label", "Approve", "--cancel-label", "Deny", "--timeout", String(req.timeoutSeconds), "--width", "480"], process.env, ms);
    if (!r) return null;
    if (r.code === 5) return "timeout";
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
    } else if (process.platform === "win32") {
      const ps = `[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; $n.ShowBalloonTip(5000,$env:MESH_TITLE,$env:MESH_BODY,[System.Windows.Forms.ToolTipIcon]::Info); Start-Sleep 6; $n.Dispose()`;
      spawn("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps], { env: { ...process.env, MESH_TITLE: title, MESH_BODY: body.slice(0, 200) }, stdio: "ignore", detached: true, windowsHide: true }).unref();
    }
  } catch { /* best effort */ }
}
