# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 2025-07-25

### Added

- **Hub (`hub/server.ts`)**
  - SSE/HTTP message broker for Pi-to-Pi agent mesh.
  - Live terminal dashboard with real-time agent list, context bars, conversation tracker, and message log.
  - Agent registration via `/v1/agents/register` with profile fields (description, skills, current_task, availability, groups).
  - SSE event stream (`/v1/events`) for inbound prompts, responses, and presence updates.
  - Unicast, broadcast, and multicast messaging via `/v1/messages`.
  - Group targeting with `@group` or `#group` syntax.
  - Threaded conversations using `reply_to` and `thread_id`.
  - Message priorities (`low` | `normal` | `high` | `urgent`) with queue preemption.
  - Delivery status tracking (`sent` → `queued` → `delivered` → `read` → `complete` | `error` | `timeout`).
  - Capability registry search (`/v1/capabilities`) by skill, topic, or group.
  - Presence subscriptions (`/v1/subscriptions`) for online/away/busy/offline events.
  - Heartbeat endpoint (`/v1/agents/:sid/heartbeat`) for stale detection and profile updates.
  - TTL-based message expiry and hop-limit anti-loop protection (`MAX_HOPS`).
  - Inbox depth limiting (`MAX_INBOX`) with graceful broadcast skip.
  - Auto-generated auth token on localhost; `PEERSTACK_AUTH_TOKEN` for LAN/remote.
  - Clean shutdown on `SIGINT` / `SIGTERM` with agent disconnect broadcast.

- **Agent Extension (`extensions/agent.ts`)**
  - Hub client extension for Pi coding agents.
  - Registered mesh tools: `hub_list`, `hub_send`, `hub_broadcast`, `hub_await`, `hub_get`, `hub_status`, `hub_capabilities`, `hub_subscribe`.
  - Live pool widget below the editor showing connected peers, status, context %, and queue depth.
  - Auto-reply on `agent_end`: assistant responses automatically flow back to the sender.
  - SSE reconnect with exponential backoff (`RECONNECT_BASE_MS` → `RECONNECT_MAX_MS`).
  - Heartbeat pushed every 10 s with context usage and queue depth.
  - `/hub` slash commands: `list`, `status`, `new` (broadcast new-session signal).
  - Inbound prompt interception with sender attribution and automatic reply routing.

- **Spawn & CLI Scripts**
  - `scripts/spawn.ts` — launch a single agent from `agents/<name>.md` frontmatter definition.
  - `scripts/tmux-start.ts` — spawn all agents as tmux panes in the current window.
  - `scripts/live-hub-test.ts` — end-to-end live test with real pi agents in tmux.
  - `scripts/install.sh` — install peerstack to `~/.local/share/peerstack` with wrapper script.
  - `stak` CLI entrypoint with `hub`, `spawn`, `team`, and `list` commands.
  - Frontmatter parser supporting `name`, `model`, `color`, `tools`, `description`, and system prompt body.
  - CLI overrides for `--model`, `--tools`, and `--project`.

- **Agent Definitions (`agents/*.md`)**
  - Dax [Builder] — implementation and feature execution.
  - Kael [Orchestrator] — task decomposition, delegation, and synthesis.
  - Lyra [Scout] — fast codebase recon and structure mapping.
  - Nox [Debugger] — bug investigation and targeted fixes.
  - Sova [Planner] — architecture analysis and step-by-step planning.
  - Venn [Reviewer] — code review, security audit, and quality enforcement.
  - Zell [Tester] — test authoring, execution, and coverage analysis.

- **Testing**
  - `tests/hub.test.ts` — Bun integration tests covering:
    - Basic message delivery via SSE
    - Delivery failure when target offline
    - Message delivery after reconnect
    - 404 for missing targets / senders
    - Target resolution by name
    - Pool snapshot self-exclusion
    - Response flow back to sender

- **Docs & Roadmap**
  - `README.md` with quick-start, architecture diagram, environment variables, and API reference.
  - `docs/peerstack-hub-improvements.md` — Phase 1–4 enhancement spec (messaging, discovery, workflows, observability).
  - `docs/tmux-team-start-plan.md` — design doc for the tmux team startup script.
  - `.env.sample` with provider API keys and hub config templates.

- **Extensions**
  - `extensions/minimal.ts` — compact footer showing model name and context meter.
  - `extensions/themeMap.ts` — per-extension default theme assignments (`ocean-breeze`, `synthwave`).

### Changed

- **refactor: rename `--name` to `--agent-name`** — updated CLI flag for agent identity across `extensions/agent.ts`, `scripts/spawn.ts`, `scripts/tmux-start.ts`, and `scripts/live-hub-test.ts`.
- **docs: update README, stak CLI examples, and project structure** — replaced old agent names (`planner`, `builder`, `reviewer`, `scout`) with current agent names (`dax`, `kael`, `lyra`, `nox`, `sova`, `venn`, `zell`).
- **docs: update `stak team` description** — corrected to reflect pane-based implementation (requires existing tmux session, hub started separately).
- **docs: update `docs/tmux-team-start-plan.md`** — added current implementation section documenting pane-based approach vs. original window-based plan.

### Fixed

- N/A — initial functional release.

### Security

- Timing-safe token comparison (`crypto.timingSafeEqual`) for Bearer auth.
- Token redaction in agent extension error messages.
