/**
 * Every long-lived child the daemon starts on the owner's behalf (shell jobs, approval dialogs, Codex runs,
 * imported stdio MCP servers). process.exit() does not kill children, so leave / stop kills them here:
 * a room you left must not keep running a teammate's command or show a dialog nobody can answer.
 */
import { spawnSync, type ChildProcess } from "node:child_process";

interface Tracked { pid: number; group: boolean; mcp: boolean }
const live = new Map<number, Tracked>();

/** Track a child until it exits. `group`: it was spawned `detached` (its own process group; kill the whole tree). */
export function trackChild(child: ChildProcess, group = false): void {
  const pid = child.pid;
  if (!pid) return;
  live.set(pid, { pid, group, mcp: false });
  child.once("exit", () => live.delete(pid));
}

/** Track an imported stdio MCP server's pid (the SDK owns the process; mcpImport.stop() closes it gracefully first). */
export function trackMcpPid(pid: number | null | undefined): () => void {
  if (!pid) return () => undefined;
  live.set(pid, { pid, group: false, mcp: true });
  return () => { live.delete(pid); }; // call when the process has exited (never SIGKILL a reused pid)
}

/**
 * SIGKILL tracked children (process tree on Windows, process group for detached POSIX children).
 * `skipMcp`: leave imported MCP servers for mcpImport.stop()'s graceful close (they may own browsers etc.).
 */
export function killTrackedChildren(opts: { skipMcp?: boolean } = {}): void {
  for (const { pid, group, mcp } of [...live.values()]) {
    if (mcp && opts.skipMcp) continue;
    live.delete(pid);
    if (process.platform === "win32") {
      try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* gone */ }
      continue;
    }
    if (group) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
}
