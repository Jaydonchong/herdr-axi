---
name: herdr-axi
description: >-
  Drive Herdr through the herdr-axi CLI, a token-lean wrapper that collapses the herdr discovery
  and dispatch rituals into single calls (home view, kinds, read, dispatch, dispatch-workspace,
  settle, prompt, pane rename, doctor). Use when herdr-axi is installed and on PATH.
  Session operations require HERDR_ENV=1.
---

# herdr-axi

Use `herdr-axi` for the supported Herdr control surface. The skill has no raw Herdr command fallback; request a wrapper feature when the needed operation is missing.

Session operations require a Herdr session (`HERDR_ENV=1`). `herdr-axi kinds` and help output do not require a session. Run `herdr-axi doctor` when Herdr compatibility needs checking.

## Commands

```bash
herdr-axi                                                 # home: workspaces, agents, counts, attention line
herdr-axi kinds                                           # supported agent kinds for --kind
herdr-axi read <target> [--source S] [--lines N] [--full] # agent status + pane content, merged
herdr-axi dispatch <name> --kind <k> --prompt "<text>" [--workspace <id>] [--no-wait]         # split a pane, start, prompt - one call
herdr-axi dispatch-workspace <name> --kind <k> --prompt "<text>" [--label <text>] [--no-wait] # new workspace, start, prompt - one call
herdr-axi settle <name>... [--all] [--timeout <ms>]       # block until each agent settles, race-safe
herdr-axi prompt <target> "<text>" [--wait]               # follow-up message to an already-existing agent
herdr-axi pane rename <pane-id> <label>                    # rename a pane by explicit ID
herdr-axi doctor                                          # live Herdr version and API schema check
```

All output is TOON on stdout. Exit 0 success, 1 error, 2 usage error. Run `herdr-axi --help` or `herdr-axi <command> --help` for the authoritative flag list - it is the installed binary's own text, not a copy that can drift.

## home (bare invocation)

One call returns the session's workspaces and live agents, plus an attention scan. Read `agents[]` for `{name,pane,kind,status,cwd}` and the `attention` line for anything blocked or waiting. Use a `name` when present; fall back to `pane` for a nameless row.

## read <target>

One call combines live agent status with pane content. `<target>` is a live agent name or pane ID. Read narrow first: the default is `--source recent-unwrapped --lines 120`, truncated to 1500 chars, with a `size` field only when it actually was truncated - that fact is certain, since the tool did the cutting itself.

`--full` and `--lines` are independent caps, not two layers of one: `--full` lifts only the 1500-character truncation, `--lines <N>` only widens the scrollback requested. Clearing one leaves the other in place - `--full` alone can still start mid-answer if the answer began further back than the requested `--lines` reached.

`help[]` names the next step only when one would actually help - never guess from a field's presence alone:
- `--full` when the body was truncated.
- A wider `--lines` only when a wider read already proved it returns more content.
- `--via-file` only when the pane is genuinely frozen on the alternate screen AND the body is otherwise already complete (not truncated, `--full` not already in use) - it asks the agent to write Markdown to a file and reads that back, the one mutating path in `read`.

An `alt_screen` field is a fact about the pane, not a sign the body is missing content - a pane can report it while `--full` already returned the complete body. Do not widen or reach for `--via-file` on its presence alone; act only on what `help[]` recommends.

## dispatch <name> --kind <k> --prompt "<text>"

One call creates a pane, starts the agent and sends its initial prompt. It chooses split direction from the caller pane's geometry (override with `--direction`), defaults `--cwd` to the caller's cwd, and waits for the new agent to settle unless `--no-wait` is passed. A `blocked` result is a real outcome, not an error - it means the new agent needs input, surfaced with the first line of what it is waiting on.

`--kind` and `--prompt` are required. Use the kind the user asked for; run `herdr-axi kinds` to list supported kinds when unsure.

`--workspace <id>` splits into an existing workspace's active-tab pane instead of the caller's own pane. The direction defaults from the target pane's geometry. Use it to add a sibling agent inside another workspace.

## dispatch-workspace <name> --kind <k> --prompt "<text>"

Same one-call contract as `dispatch`, but the new agent gets its own Herdr workspace instead of a sibling pane in the caller's current tab. Use it when the work is unrelated enough to warrant its own workspace.

Takes `--kind`, `--prompt` (both required), `--cwd`, `--label`, and `--no-wait` - the same as `dispatch` except there is no `--direction` (a new workspace has no split direction to choose; passing it is rejected as an unknown flag, exit 2). Everything else - the settle wait, a `blocked` result being a real outcome, the rendered shape - matches `dispatch` exactly.

`--label <text>` gives the new workspace a mixed-case human label (e.g. `"Fix Login Bug"`), decoupled from `<name>` (the agent name, which stays lowercase-constrained). The workspace is labeled as part of this single call.

Agent names are global across the whole Herdr session, not scoped to a workspace or tab - a name already held by a live agent anywhere else fails the dispatch. `dispatch-workspace` checks this before creating anything, so a collision fails cleanly with no orphan workspace left behind; pick a name unique session-wide, and check the home view's `agents[]` list first if unsure.

## settle <name>... [--all] [--timeout <ms>]

Blocks until each named live agent - or every live agent, with `--all` - reaches a settled outcome: `idle`, `done`, or `blocked` (a blocked settle is a real outcome here too, not an error, same as `dispatch`). This is what a `--no-wait` dispatch settles with; never hand-roll a status poll instead. A freshly dispatched agent is `idle` before it starts working, indistinguishable from `idle` after it finishes, and even a two-stage "wait for working, then wait for idle" shell check can still miss a task that starts and finishes between two polls. `settle` tracks Herdr's per-agent state-change signal, so an agent that starts and finishes between checks is still detected as settled.

Defaults to a 60-second overall timeout (`--timeout <ms>` to override) - deliberately under the wait ceiling below, so one `settle` call is always safe to block on directly. A name still open when the timeout elapses is a normal result, exit 1, not a thrown error - re-run `settle` on just the still-open names (its own `help[]` line names them) to keep waiting.

## The wait ceiling

A blocking call - `--wait` on `prompt`, or the default wait on `dispatch`/`dispatch-workspace` - must return before the harness's foreground command limit; keep any wait to a ceiling of about 90 seconds. A wait that runs past the limit is killed and its return value is lost, even if the underlying operation completed correctly. For work that may run longer, don't wait: dispatch/prompt with `--no-wait`, then `settle` on it - its 60-second default timeout already stays under this ceiling, so a single blocking `settle` call is always safe, however long the underlying work might still be running.

## Starting more than one agent

Give every `dispatch`/`dispatch-workspace` call after the first `--no-wait` - only the first call in a batch may wait, and even that one should respect the wait ceiling above. Issue the independent calls in one batch (one turn, multiple tool calls) once their targets are known: they share no state, so there is no reason to serialize them across turns. Settle all of them together afterward with one `settle <name1> <name2> ...` call (or `settle --all`) - a blocking wait costs no model turns while it blocks; every return to the agent loop costs one, at the full context size each time, so one settle call is far cheaper than checking in across separate turns. A run that filled a wait with manual turns instead of one blocking call has been measured paying far more tokens for identical work, at an identical per-turn cost - the difference was turn count alone.

## prompt <target> "<text>"

Sends a follow-up message to an agent that already exists (`<target>` is a live agent name or pane ID, same as `read`). Use it to continue a conversation - `dispatch`/`dispatch-workspace` only ever create a new agent, so a prompt to one already running belongs here, not there.

Without `--wait`, reports `status: "sent, not waited for"` immediately. With `--wait`, waits for the agent to settle and reports the same `idle`/`done`/`blocked` status `dispatch` does, with a `waiting_on` headline on a blocked settle. `prompt` never folds in a read of the pane afterward - run `herdr-axi read <target>` for that, which the command's own `help[]` line always points at.

## pane rename

`herdr-axi pane rename <pane-id> <label>` renames the pane identified by its explicit pane ID and returns the pane ID and new label. Use the pane ID from the home view or a dispatch result; the command does not infer a focused pane.

## doctor

Run when `herdr-axi` output looks wrong or a herdr upgrade is suspected. Exit 1 means the live `herdr` version or API schema no longer matches what this tool was built against - the mismatch is the finding; do not chase output shape further until `doctor` reports a match.

## Safety

Use explicit pane IDs with `pane rename`. `dispatch` targets the caller's pane unless `--workspace <id>` selects another workspace. Inspect a `blocked` status before responding; do not prompt through a blocked dialog.
