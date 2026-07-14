# Obsidian Progress Map

A checkpointing tool that regenerates an [Obsidian Canvas](https://help.obsidian.md/canvas)
map on a fixed interval, so a long-running coding session (e.g. building TradeAI)
can be resumed after running out of context — open the canvas and see exactly
where things stand.

This repo *is* the Obsidian vault. Open this folder in Obsidian and every
project gets its own canvas under `vault/<project>/PROGRESS-MAP.canvas`.

## How it works

- `checkpoint/watch.js` runs a real 60-second wall-clock loop. On every tick
  it regenerates `vault/<project>/PROGRESS-MAP.canvas` from two sources:
  - `vault/<project>/state.json` — phase status, blockers, and notes,
    updated via `update-state.js`.
  - The target project's own git repo — branch, last commit, and
    `git status --porcelain` output — read live, no manual update needed.
- The canvas has one node per build phase (colored green/orange/red for
  done/in-progress/blocked), arrows connecting them in order, and a
  "RESUME HERE" node summarizing current phase, blockers, and recent notes.

The phase list is hardcoded to the TradeAI architecture doc's build order
(Phase 1A -> 1I, then Phase 2). If you reuse this for a different project,
edit the `PHASES` array in `checkpoint/lib.js`.

## Usage

Start the watcher, pointing `--target` at wherever the TradeAI repo actually
lives once that build starts:

```bash
node checkpoint/watch.js --project TradeAI --target /path/to/tradeai-repo --interval 60
```

Leave it running in the background (`&`, `tmux`, `nohup`, etc.) for the
duration of the coding session.

As the build progresses, update state so the map reflects reality — this
mirrors the checkpoint block format in the architecture doc
(`✅ Phase X complete`, `⏭ Next`, `❓ Blockers`):

```bash
node checkpoint/update-state.js --project TradeAI start-phase 1A
node checkpoint/update-state.js --project TradeAI complete-phase 1A backend/main.py,backend/db.py
node checkpoint/update-state.js --project TradeAI block 1B "waiting on GEMINI_API_KEY"
node checkpoint/update-state.js --project TradeAI unblock 1B
node checkpoint/update-state.js --project TradeAI note "backend skeleton up, migrations pending"
```

To generate a single snapshot without the watch loop:

```bash
node checkpoint/generate-canvas.js --project TradeAI --target /path/to/tradeai-repo
```

## Resuming after running out of context

Open `vault/<project>/PROGRESS-MAP.canvas` in Obsidian (or read the JSON
directly). The "RESUME HERE" node has the current phase, any blockers, the
last few notes, and the last commit — everything needed to pick the build
back up in a fresh session.

## Files

```
checkpoint/
  args.js            - tiny --flag value / positional arg parser, no deps
  lib.js             - state load/save, git info, canvas generation
  generate-canvas.js - one-shot CLI: writes the canvas once
  watch.js           - long-running CLI: regenerates every --interval seconds
  update-state.js    - CLI to record phase transitions, blockers, notes
vault/
  <project>/state.json           - source of truth for phase/blocker/note state
  <project>/PROGRESS-MAP.canvas  - generated output, safe to regenerate/delete
```

No npm dependencies — plain Node.js (`fs`, `path`, `child_process`) only.
