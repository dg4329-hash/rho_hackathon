# Team Mesh — Competitive Research (2026-09-12)

Legend: **[V]** = verified by fetching the page; **[S]** = seen only in search snippets.

## 1. Most relevant existing products / projects

| # | Name | What it does | Closeness | URL |
|---|------|--------------|-----------|-----|
| 1 | **Superconductor** (Volition) | "The multiplayer AI workspace for teams and coding agents." Runs Claude Code/Codex/Cursor/Amp/Droid/etc. in **cloud sandboxes**; teammates "jump in on a teammate's run, take the wheel"; **shared team credentials vault**; guided review, cost tracking. Free (4 seats), Pro $128/mo, Enterprise. [V] Reportedly 7 people, ~$7M raised, private beta 2025. [S] | **Direct (on framing)** | https://www.superconductor.com , /pricing |
| 2 | **claude-mesh** (OSS) | Self-hosted relay + MCP bridge: DM/broadcast/threads between Claude Code instances across machines, plus **"permission-relay"** that routes an approval dialog to a teammate's Claude. Does *not* run commands remotely or share capabilities. 23 stars, last push 2026-07-25. [V] | **Direct (partial)** | https://github.com/pouriamrt/claude-mesh |
| 3 | **Claude Code cross-session messaging + Remote Control** (Anthropic) | `ListAgents`/`SendMessage` between *your own* sessions, including other machines via Remote Control. Message never counts as consent; receiver's permission prompts still fire. No cross-*person* messaging. [V] | Adjacent (will grow) | https://code.claude.com/docs/en/cross-session-messaging |
| 4 | **Claude Code channels** | MCP server pushes events into a running session; allowlisted senders (can be teammates on Discord) can send tasks and **relay permission approvals**. [V] | Adjacent | https://code.claude.com/docs/en/channels |
| 5 | **Claude Code agent teams** (experimental) | One lead spawns teammates on the *same machine*; shared task list, mailbox, file-locked task claims. Same person, same box. [V] | Adjacent | https://code.claude.com/docs/en/agent-teams |
| 6 | **Zed Delta** (Aug 12 2026, private beta) | CRDT "DeltaDB" syncs worktree + conversation to every thread participant in real time; connects Claude Code terminals; humans and agents in one thread. [V] | Adjacent (awareness claim) | https://zed.dev/blog/introducing-delta |
| 7 | **AQ.dev** | "The multiplayer coding harness": shared live terminals/editor/preview in the cloud, anyone can steer the agent; $50/user. [V] | Adjacent | https://aq.dev/multiplayer-coding-agents/ |
| 8 | **Bothread** (OSS) | Local-first MCP "room" (19 tools): `claim_files` advisory leases, messaging, task board, blocking `request_approval`. Loopback only; 12 stars. [V] | Adjacent (conflict claim, single-machine) | https://github.com/AdamACE9/bothread |
| 9 | **Claude-Bridge** (OSS) | Cross-machine MCP message bus with task queue (`bridge_enqueue/claim/complete`); "receiving a message never authorizes execution." 12 stars. [V] | Adjacent | https://github.com/constripacity/Claude-Bridge |
| 10 | **Clash** (OSS) | Predicts merge conflicts across git worktrees for parallel agents; 64 stars. Same machine. [S] | Tangential (conflict) | https://github.com/clash-sh/clash |
| 11 | **Cursor Projects + Self-hosted Machines** | Sep 10: coordinator agent delegating to subagents, Slack-triggered. Sep 2: cloud agents execute on **team pools of self-hosted workers**, "secrets stay on internal machines." [V changelog] | Adjacent (risk) | https://cursor.com/changelog |
| 12 | **GitHub Agent HQ / Copilot app** | Run Claude/Codex/Copilot side by side, each in its own worktree; org-level, PR-centric. [S] | Tangential | https://github.blog/news-insights/company-news/pick-your-agent-use-claude-and-codex-on-agent-hq/ |
| 13 | **MCP gateways** (MintMCP, Arcade, Portkey, Docker MCP Toolkit, Cloudflare) | Central broker holds credentials; users get tools, not secrets. Centralized, admin-configured. [S] | Adjacent (credential claim) | https://www.arcade.dev/blog/best-mcp-gateways-enterprise/ |
| 14 | **1Password for Claude / Codex, Keycard** | Zero-exposure credential injection for agents; Keycard uses OAuth token exchange to narrow scope at each agent hand-off. [S] | Tangential (credential claim) | https://1password.com/press/2026/july/1password-for-claude , https://www.keycard.ai/ |
| 15 | **MCP 2026-07-28 spec** | Stateless core; **Tasks moved to the `io.modelcontextprotocol/tasks` extension**; MRTR `input_required` for mid-call confirmations. No multi-user or delegation primitives. [V] | Infra | https://blog.modelcontextprotocol.io/posts/2026-07-28/ |

Also seen [S]: claude-peers-mcp (3 stars, messaging only), gvorwaller/claude-relay, macula-mcp, Forklane.ai ("multiplayer coding environment"), YC's open-sourced "QM" multiplayer harness, Solo.io agentgateway/"Agent Mesh" (enterprise A2A/MCP proxy), Tailscale Aperture + tsidp (agent identity on a tailnet), OpenAI ChatGPT workspace agents (shared org agents, not dev machines), A2A moved into the Agentic AI Foundation on 2026-08-17 (Axios; page 403'd).

## 2. Claim-by-claim

**Claim A — borrow a teammate's capability without their credential.**
- *Does it:* Nobody in the exact form (teammate's laptop is the executor). Closest: MCP gateways and Superconductor's vault, both **centralize** secrets in a server the whole team trusts. 1Password/Keycard inject credentials into an agent *you* run.
- *Partial:* Cursor self-hosted team pools (any worker claims any job, secrets stay on-prem) is the same shape but for cloud-dispatched jobs, no per-person ownership or y/n.
- *Uncovered:* peer-to-peer, owner-approved, "my machine is a tool in your agent's toolset." The credential never moves and no central vault exists.

**Claim B — cross-person agent delegation with a y/n on the owner's terminal.**
- *Does it:* claude-mesh's permission-relay is the inverse (route *my* approval to *you*). Bothread's `request_approval` is single-machine. Channels let a trusted Discord sender approve tool use in your session, but that's a human pushing into one session, not agent→agent.
- *Partial:* Claude-Bridge task queue (no approval semantics), Anthropic cross-session messaging (same account only; explicitly "can't approve anything").
- *Uncovered:* agent A asks person B's daemon to run a bounded task, B approves, output streams back to A. No product or OSS repo found doing this across accounts.

**Claim C — live cross-team agent awareness and pre-git conflict warnings.**
- *Does it:* Zed Delta (real-time CRDT of worktree + conversation) is the strongest; private beta, requires living in Delta. Bothread file leases (one machine). Anthropic cross-session messaging is *designed* for "warn the other session before you notice," but only among one person's sessions.
- *Partial:* Clash (worktree diff prediction), Cursor 3 Agents Window (your agents), Superconductor/AQ (see the run, not file-level intent).
- *Uncovered:* harness-agnostic (Claude Code + Cursor + Codex), terminal-native feed of *other people's* agents' file claims, with a warning injected into the agent's context at prompt time via hooks. Thin but real.

## 3. Moat assessment

**Genuinely unique (today):** the combination of (1) decentralized execution on the owner's laptop, (2) owner-approved delegation, (3) cross-harness. Every "multiplayer" product found (Superconductor, AQ, Zed Delta, Cursor cloud, Agent HQ) is **centralized**: agents in cloud sandboxes, a shared vault, one workspace everyone joins. Superconductor's answer to "share capabilities not credentials" is a shared encrypted vault; ours is that the credential never leaves the owner and the owner's *machine* is the capability. That contrast is crisp and demo-able.

**Thin-wrapper risks judges may raise:**
- "Isn't this claude-mesh / Claude-Bridge with an exec tool?" Yes, structurally. The difference is the approval-gated remote *execution* plus capability registry, and 23 stars says nobody has productized it.
- "Anthropic already ships cross-session messaging + Remote Control." True, but same-account only and messages cannot trigger execution. Say this explicitly.
- Presence + event feed is table stakes (every dashboard has one).
- The word **"multiplayer" is crowded**: Superconductor, AQ, Zed Delta, Forklane, YC QM, and a Sept 7 "Multiplayer AI Sprint" newsletter all use it. Keep it as a hook, not the name.

**Sharpest positioning angles:**
1. **"Local-first multiplayer."** Superconductor moves your team into their cloud; we make your teammates' laptops the cloud. No sandbox, no vault, no new IDE. Works with whatever harness each person already uses.
2. **"Delegation with consent, not credentials."** One MCP tool, `ask_teammate(who, command, why)`, and a y/n on the owner's screen. Contrast with gateways (admin-provisioned) and Cursor pools (any worker, no human).
3. **"Conflict awareness before git knows."** File claims broadcast to every teammate's *agent context* via hooks, across harnesses, without adopting Delta.

## 4. Risks (things that could become a vendor feature next quarter)

- **Anthropic** already has the plumbing: cross-session messaging routes through Anthropic servers to other machines, Remote Control is on all plans, channels do permission relay, and GitHub issue #60082 (multi-user sessions) is open and heavily requested [S]. Extending `ListAgents`/`SendMessage` to *teammates* under a Team plan is an obvious step. [V docs]
- **Cursor** self-hosted team pools (Sep 2) plus Projects (Sep 10) are one policy layer away from "dispatch to a teammate's machine." [V]
- **Zed Delta** owns the real-time awareness story if it opens beta widely. [V]
- **Superconductor** could add a local-worker mode; its "bring your own subscription" model already sidesteps the cloud-token problem. [V]
- **MCP** is moving toward stateless + Tasks extension; nothing there competes, but judges may ask why not use MCP Tasks (answer: it's an extension, still redesigning, and we need owner approval semantics it lacks). [V]

## 5. The Rho hackathon

Not found. Searches for "Rho hackathon 2026" across Devpost, Luma, X, LinkedIn returned nothing. `rho.co` is **Rho Business Banking**, a NYC fintech (startup banking, corporate cards, bill pay); it ran a "Rho in Atlanta" event Mar 9-13 2026 [S] but no hackathon page, theme, judging criteria, or sponsor tracks surfaced. Treat the event as unverified: get the brief from the organizers, and assume a fintech/startup audience that may value "share capabilities not credentials" as a security story more than as a dev-tooling story.
