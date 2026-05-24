# Plan: Tmux Full Team Start Script

## Goal
Create `scripts/tmux-start.ts` — a single command that launches the peerstack hub + all 4 agents in a tmux session with named windows.

## Usage
```bash
bun scripts/tmux-start.ts
```

## Layout
```
tmux session: peerstack-team
├── window 0: hub     → bun hub/server.ts
├── window 1: planner → pi -e extensions/agent.ts ... (kimi-k2.6)
├── window 2: builder → pi -e extensions/agent.ts ... (deepseek-v4-pro)
├── window 3: reviewer→ pi -e extensions/agent.ts ... (glm-5.1)
└── window 4: scout   → pi -e extensions/agent.ts ... (deepseek-v4-flash)
```

## Behavior

1. **Kill existing session** — `tmux kill-session -t peerstack-team` if it exists (clean restart)
2. **Start hub** — new detached tmux session "peerstack-team", window 0, run hub
3. **Wait for hub** — poll `~/.pi/peerstack/server.json` + `/health` endpoint until ready (max 30s)
4. **Spawn agents sequentially** — for each agent in `agents/*.md`:
   - Parse frontmatter (name, model, color, tools, system prompt)
   - Write system prompt to temp file
   - Build `pi` command: `-e extensions/agent.ts -e extensions/minimal.ts --model <model> --tools <tools>,hub_list,hub_send,hub_get,hub_await,hub_status --name <name> --color <color> --append-system-prompt <tmp>`
   - New tmux window in same session, named after agent
   - Small delay (500ms) between spawns to avoid overwhelming the hub
5. **Attach option** — if stdout is a TTY, offer to attach: `tmux attach -t peerstack-team`
6. **Cleanup on exit** — trap SIGINT/SIGTERM to kill the tmux session

## Implementation Details

### Parsing agents/*.md
Reuse the frontmatter parser from `scripts/spawn.ts` (or extract to a shared module).

### Reuse spawn logic
The script can either:
- (A) Inline the spawn logic (copy/paste from spawn.ts)
- (B) Import and reuse spawn.ts functions (preferred if we extract the parser)

For simplicity v1: inline the parser. Future: extract `lib/parseAgentMd.ts`.

### Hub readiness check
```ts
async function waitForHub(maxWaitMs = 30000): Promise<{ url: string; token: string }> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const sj = JSON.parse(fs.readFileSync(path.join(REG_ROOT, "server.json"), "utf-8"));
      const resp = await fetch(sj.local_url + "/health", { headers: { Authorization: `Bearer ${sj.token}` } });
      if (resp.ok) return sj;
    } catch {}
    await sleep(200);
  }
  throw new Error("hub did not become ready in time");
}
```

### Tmux commands
Use `child_process.spawnSync` for synchronous tmux control:
- `tmux new-session -d -s peerstack-team -n hub "bun hub/server.ts"`
- `tmux new-window -t peerstack-team -n <name> "<pi command>"`
- `tmux kill-session -t peerstack-team`

### Agent spawn order
Use the order from `agents/*.md` or hardcode: planner → builder → reviewer → scout.

## Files to Create/Modify

| File | Action |
|------|--------|
| `scripts/tmux-start.ts` | Create new |
| `stak` | Add `stak team` command that runs `bun scripts/tmux-start.ts` |
| `README.md` | Update Quick Start with `stak team` |

## Acceptance Criteria
- [ ] Running `bun scripts/tmux-start.ts` creates a tmux session with 5 windows
- [ ] Hub is ready before any agent spawns
- [ ] All 4 agents appear in hub dashboard within 10s of spawn
- [ ] `./stak team` is a valid CLI command
- [ ] README documents the new command
