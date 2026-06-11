# Plan: Tmux Full Team Start Script

> **Note:** This document describes the original planned design. The current implementation
> (`scripts/tmux-start.ts`) differs significantly — see [Current Implementation](#current-implementation) below.

## Original Plan

### Goal
Create `scripts/tmux-start.ts` — a single command that launches the peerstack hub + all agents in a tmux session with named windows.

### Usage
```bash
bun scripts/tmux-start.ts
```

### Layout
```
tmux session: peerstack-team
├── window 0: hub     → bun hub/server.ts
├── window 1: planner → pi -e extensions/agent.ts ... (kimi-k2.6)
├── window 2: builder → pi -e extensions/agent.ts ... (deepseek-v4-pro)
├── window 3: reviewer→ pi -e extensions/agent.ts ... (glm-5.1)
└── window 4: scout   → pi -e extensions/agent.ts ... (deepseek-v4-flash)
```

### Behavior

1. **Kill existing session** — `tmux kill-session -t peerstack-team` if it exists (clean restart)
2. **Start hub** — new detached tmux session "peerstack-team", window 0, run hub
3. **Wait for hub** — poll `~/.config/peerstack/server.json` + `/health` endpoint until ready (max 30s)
4. **Spawn agents sequentially** — for each agent in `agents/*.md`:
   - Parse frontmatter (name, model, color, tools, system prompt)
   - Write system prompt to temp file
   - Build `pi` command: `-e extensions/agent.ts -e extensions/minimal.ts --model <model> --tools <tools>,hub_list,hub_send,hub_get,hub_await,hub_status --agent-name <name> --color <color> --append-system-prompt <tmp>`
   - New tmux window in same session, named after agent
   - Small delay (500ms) between spawns to avoid overwhelming the hub
5. **Attach option** — if stdout is a TTY, offer to attach: `tmux attach -t peerstack-team`
6. **Cleanup on exit** — trap SIGINT/SIGTERM to kill the tmux session

### Original Implementation Details

#### Parsing agents/*.md
Reuse the frontmatter parser from `scripts/spawn.ts` (or extract to a shared module).

#### Reuse spawn logic
The script can either:
- (A) Inline the spawn logic (copy/paste from spawn.ts)
- (B) Import and reuse spawn.ts functions (preferred if we extract the parser)

For simplicity v1: inline the parser. Future: extract `lib/parseAgentMd.ts`.

#### Hub readiness check
```ts
async function waitForHub(maxWaitMs = 30000): Promise<{ url: string; token: string }> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const sj = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "server.json"), "utf-8"));
      const resp = await fetch(sj.local_url + "/health", { headers: { Authorization: `Bearer ${sj.token}` } });
      if (resp.ok) return sj;
    } catch {}
    await sleep(200);
  }
  throw new Error("hub did not become ready in time");
}
```

#### Tmux commands
Use `child_process.spawnSync` for synchronous tmux control:
- `tmux new-session -d -s peerstack-team -n hub "bun hub/server.ts"`
- `tmux new-window -t peerstack-team -n <name> "<pi command>"`
- `tmux kill-session -t peerstack-team`

#### Agent spawn order
Use the order from `agents/*.md` or hardcode: planner → builder → reviewer → scout.

---

## Current Implementation

The actual `scripts/tmux-start.ts` takes a simpler, pane-based approach:

### Key differences from the original plan

1. **No hub management** — The script does **not** start the hub. It checks whether the hub is already running (via `hubIsUp()`) and warns if it isn't, but assumes you've started it manually (`./stak hub` in another pane).

2. **Panes, not windows** — Instead of creating a dedicated `peerstack-team` session with named windows, the script uses `tmux split-window` to create panes in the **current** tmux window, then tiles them with `tmux select-layout tiled`.

3. **Requires existing tmux session** — You must already be inside a tmux session. The script exits with an error if `$TMUX` is not set.

4. **No session cleanup** — The script doesn't create or destroy tmux sessions; it just adds panes to whatever window you're currently in.

### Usage

```bash
# 1. Create/attach a tmux session
tmux new -s peerstack

# 2. Start the hub in one pane
./stak hub

# 3. In another pane, spawn all agents
./stak team [project-dir]
```

### What it does

- Parses all `agents/*.md` files (sorted alphabetically)
- For each agent, extracts frontmatter (`name`, `model`, `color`, `tools`, description) and system prompt body
- Writes each agent's system prompt to a temp file
- Builds a `pi` command with `--agent-name`, `--model`, `--tools`, `--color`, and `--append-system-prompt`
- Runs `tmux split-window -d -c <project-dir> <command>` for each agent
- Waits 500ms between spawns
- Runs `tmux select-layout tiled` to arrange all panes
- Cleans up temp files afterward

### Files

| File | Action |
|------|--------|
| `scripts/tmux-start.ts` | The pane-based implementation |
| `stak` | CLI entry point (`./stak team` invokes the script) |
| `README.md` | Documents usage |

### Acceptance Criteria (actual)
- [x] Running `./stak team` inside a tmux session spawns all agents as panes
- [x] Hub is assumed to be running (warns if not detected)
- [x] All agents appear in hub dashboard after spawn
- [x] `./stak team` is a valid CLI command
- [x] README documents the updated command
