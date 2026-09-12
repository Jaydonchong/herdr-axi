# herdr-axi: gaps and improvements found in the 2026-09-11 benchmark

Source data: `report.html` in this folder (Read/Synthesizer/Router tests, corrected rerun after
fixing a skill-versioning contamination issue in the first run - see report for detail). herdr won
all 3 tests, but the margin tells three different stories depending on what each test actually
exercised. This document is about the "why", aimed at whoever maintains herdr-axi next.

## 1. No way to add a pane/agent to an existing workspace

**The gap:** `dispatch` always splits from the caller's own current pane/tab. `dispatch-workspace`
always creates a brand-new workspace. Neither can target an arbitrary *existing* workspace to add
a second or third agent into it.

**Where it showed up:** Every test that needed more than one agent in the same workspace hit this.

- Read Test: herdr-axi candidate used `dispatch-workspace` for explorer1, then had to fall back to
  raw `herdr workspace create` context (actually: raw `herdr pane split` + `herdr agent start`) to
  add explorer2 into the *same* workspace. 1 of 2 required agents needed the fallback.
- Synthesizer Test: only the first of 3 agents (an analyst) could go through `dispatch-workspace`;
  the second analyst and the synthesizer both needed raw `herdr pane split` + `herdr agent start`.
  2 of 3 required agents needed the fallback - over half the setup.

**Impact:** This is the single biggest driver of herdr-axi's slower total task time. In the
Synthesizer Test, herdr-axi took 227.7s total vs herdr's 128.8s (1.8x) almost entirely because of
this gap plus its downstream effects (see #2).

**Suggested fix:** Add a way to target an existing workspace/pane when dispatching a new agent -
e.g. `herdr-axi dispatch <name> --kind <k> --prompt "<text>" --workspace <id>` (split inside that
workspace's active tab instead of the caller's), or a dedicated
`herdr-axi dispatch-into <workspace-id> <name> --kind <k> --prompt "<text>"`. This single addition
would remove the majority of raw-herdr fallbacks seen in this benchmark.

## 2. `dispatch-workspace` can't set an arbitrary workspace label

**The gap:** `dispatch-workspace <name> ...` names the new workspace after the agent name, and
agent names must match `[a-z][a-z0-9_-]{0,31}` (lowercase only, per Herdr's own agent-naming
rules). There's no `--label` flag to give the workspace a different, human-readable, mixed-case
label independent of the agent's name.

**Where it showed up:** Synthesizer Test - the candidate needed the workspace labeled exactly
`TEST-synth-axi` (mixed case, with a literal dash), which `dispatch-workspace` cannot produce
directly. It had to fall back to a separate raw `herdr workspace rename <id> "TEST-synth-axi"`
call immediately after.

**Suggested fix:** Add `--label <text>` to `dispatch-workspace`, decoupled from the (validation-
constrained) agent name, so a caller doesn't need a second raw-herdr call just to name the
workspace something legible.

## 3. No command to prompt an already-existing agent

**The gap:** Both `dispatch` and `dispatch-workspace` only *create* new agents and prompt them as
part of that same call. Neither herdr-axi nor `read` has a way to send a follow-up message to an
agent that already exists (by name or pane ID).

**Where it showed up:** Router Test - both candidates (herdr *and* herdr-axi) had to fall back to
raw `herdr agent prompt x_engineer "..."` because neither skill's own dispatch-style commands
cover "message an agent I didn't just create." This one is not herdr-axi-specific (herdr's native
`/herdr` skill has `agent prompt` built in and used it directly, without calling it a fallback),
but it means herdr-axi's core pitch - "collapses discovery and dispatch rituals into single
calls" - has no single call for what is arguably the most common follow-up action: continuing a
conversation with an agent you already started.

**Suggested fix:** Add `herdr-axi prompt <target> "<text>" [--wait]` as a thin wrapper over
`herdr agent prompt` (+ optionally folding in a `read` right after, mirroring how `dispatch`
folds "split, start, prompt" into one call). This turns "locate agent, prompt it, read the
answer" - currently 2-3 calls even for herdr-axi users - into one.

## 4. Alt-screen pane reads are still unreliable

**The gap:** When a pane's foreground agent leaves output on the terminal's alternate screen,
`herdr-axi read`'s default read can come back incomplete, and the documented `--via-file` fallback
has intermittently failed with `ENOENT` (the file not existing yet when read is attempted).

**Where it showed up:** Read Test rerun - both explorer panes landed on alt-screen after
finishing; `--via-file` failed with ENOENT for one of them, and `--full`/larger `--lines` was
needed to recover the answer instead. This is the second run in a row this has surfaced (the
first, contaminated run saw the same `--via-file` ENOENT pattern plus a cross-sandbox path
mismatch on re-read).

**Suggested fix:** Investigate the `--via-file` write/read race (the file may not exist yet when
the read is attempted - a short retry/poll would likely fix it) and confirm the file path
resolves consistently across whatever sandboxing the caller and the target agent run under.

## 5. Not seen this round, but flagged before - re-verify agent-name-reuse behavior

The first (contaminated) run reported a case where reusing an already-taken agent name
inconsistently *succeeded* instead of raising `agent_name_taken`. This benchmark's corrected rerun
didn't hit that path, so it's unconfirmed against merged code - worth a dedicated regression check
rather than trusting the earlier read.

## What generalizes vs what's herdr-axi-specific

- #1 and #2 are herdr-axi's own dispatch primitives falling short of a common multi-agent-in-one-
  workspace pattern - fixable inside herdr-axi without touching `herdr` itself.
- #3 is a gap in *both* skills' high-level commands (herdr's own `agent prompt` covers it, so
  herdr isn't blocked, but there's no equivalent one-call convenience in herdr-axi for it).
- #4 is arguably a `herdr` core reliability issue (alt-screen detection / file-based recovery) that
  herdr-axi merely inherits and surfaces more often, since its `read` leans on the same recovery
  path.

## Net read

herdr-axi's wrapper is well-suited to the "spin up one new agent and ask it one thing" case - it
won that shape of interaction outright in the Router Test's core mechanic (finding + first framing
of a fresh agent). Every place it lost time in this benchmark was a case *outside* that shape:
adding a second agent to a workspace it already made, or following up with an agent it didn't just
create. Closing gaps #1-#3 would remove nearly all of the fallback overhead this benchmark
measured.
