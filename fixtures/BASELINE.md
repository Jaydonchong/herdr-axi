# herdr-axi Phase 0 baseline

Measured on 2026-09-06 inside a live Herdr session, herdr 0.8.0, Node v22.22.3.
All byte counts are stdout bytes from the `herdr` binary.
This file records the cost the wrapper is built to remove, plus the two version values Phase 4 `doctor` compares against.

## Scenario table

Each scenario is one workflow the herdr skill prescribes, measured as its own sequence of `herdr` calls.

| Scenario | Calls | Total stdout bytes | Notes |
| --- | --- | --- | --- |
| 1. Cold discovery | 5 | 15916 | The five-command discovery block. One `herdr api snapshot` (31517 bytes raw, one call) replaces all five. |
| 2. Dispatch | 4 | 2023 | `pane layout` 295, `pane split` 442, `agent start` 657, `agent prompt --wait` 629. |
| 3. Read back | 2 | 3368 | `agent get` 622, `agent read --lines 120` 2746. `truncated` is never surfaced; raising `--lines` returns nothing more. |

### Scenario 1, cold discovery, per call

| Bytes | Command |
| --- | --- |
| 4415 | `herdr workspace list` |
| 178 | `herdr tab list --workspace w0` |
| 705 | `herdr pane current --current` |
| 702 | `herdr pane list --workspace w0` |
| 9916 | `herdr agent list` |

Total is 15916 bytes across 5 calls.
The call count is 5 by construction.
The trap worth recording: the handoff's loop uses `herdr $c`, which relies on bash word splitting.
This session runs zsh, which does not split unquoted parameters, so `herdr $c` passes `"workspace list"` as one argument and every command returns zero bytes.
The zsh split operator `herdr ${=c}` restores the intended behavior.

### Scenario 2, dispatch, per call

| Bytes | Duration | Command |
| --- | --- | --- |
| 295 | 0.006s | `herdr pane layout --pane w0:p1` |
| 442 | 0.017s | `herdr pane split --current --direction right --cwd "$PWD" --no-focus` |
| 657 | 3.046s | `herdr agent start phase0-test --kind claude --pane w0:p2` |
| 629 | 2.284s | `herdr agent prompt phase0-test "..." --wait --timeout 120000` |

The caller pane is 233 columns wide, so the split is to the right, per the skill's wide-pane rule.
A newly split pane is not immediately an available shell.
The first `agent start` returned `agent_pane_busy` at 0.005s because the shell had not reached its interactive prompt.
Retrying after the prompt appeared succeeded in 3.046s.
Phase 3's dispatch command must wait for the split pane to become an available shell before calling `agent start`.

### Scenario 3, read back, two facts Phase 2 depends on

1. `truncated` is not surfaced by the CLI.
   `herdr agent read` prints raw terminal text, not a `PaneReadResult` envelope, and has no `--json` flag.
   The `truncated` field exists in the protocol but no CLI command emits it.
   Surfacing it is Phase 2's job.
2. Raising `--lines` from 120 to 400 returns byte-identical output (2746 bytes both times).
   The agent is a Claude Code TUI running on the terminal's alternate screen.
   Rows that leave the alternate screen never enter Herdr's host scrollback, so a larger line count cannot recover them.
   This is the exact failure mode Phase 2 exists to make visible, and it reproduced live here.

## TOON measurement, step 5

Three byte counts, all from the redacted golden fixture `snapshot.json`.

| Measure | Bytes | Ratio to raw JSON |
| --- | --- | --- |
| Raw JSON (`snapshot.json`, pretty-printed) | 45137 | 1.00 |
| Raw TOON (`toon --to-toon snapshot.json`) | 30040 | 0.67 |
| Projected TOON (agents to 5 fields, workspaces to 4) | 973 | 0.022 |

Projection targets: `agents` to `name,pane_id,agent,agent_status,cwd`; `workspaces` to `workspace_id,label,tab_count,pane_count`.

### What the numbers say, and the caveat

The projected TOON is 973 bytes against 45137 raw, a 97.8 percent reduction.
That saving is delivered almost entirely by projection, not by TOON.

The fixture on disk is pretty-printed, which inflates the raw-JSON baseline.
The wrapper consumes compact JSON from the live CLI, so the fair baseline is the compact form of the same snapshot: 24975 bytes.
Against that fair baseline:

- Raw TOON is 30040 bytes, which is larger than compact JSON at 24975 bytes.
  TOON alone does not beat compact JSON on herdr's shapes; it loses by about 20 percent.
- Projected TOON is 973 bytes against 24975 compact JSON, a 96.1 percent reduction.

The load-bearing finding for the plan's largest open question: on herdr's shapes the saving comes from dropping roughly 17 of 22 agent fields, not from the TOON encoding.
TOON is worth keeping only after projection, where its tabular header amortizes across many uniform rows.
Applying TOON to the full un-projected snapshot would cost more bytes than sending compact JSON.

## Golden fixture, step 3

`snapshot.json` is the redacted `herdr api snapshot` output, kept in its full CLI envelope so tests can feed it exactly as live stdout.
The wrapper unwraps `.result`, then reads `.result.snapshot`.

Redaction preserved every id, status, revision, and numeric field, because those are what the wrapper projects and the tests assert on.
It rewrote every path and human-readable name to a generic value, keeping field count and shape intact:

- `cwd`, `foreground_cwd`, `checkout_path`, `repo_key`, `repo_root` map to `~/repo-a`, `~/repo-b` per distinct repo root, with suffixes such as `/.git` preserved. Real paths outside any repo root map to `~/dir-a`, `~/dir-b`.
- `repo_name` maps to the generic letter of its repo root.
- `label`, `terminal_title`, `terminal_title_stripped` map to distinct greek tokens (`alpha`, `beta`, `gamma`, extended to stay distinct across 51 distinct originals).
- `name` on agent rows maps to `agent-a`, `agent-b`, because live agent names encoded real project work.

A leak scan for `/Users`, `/private`, real repo names, and real work slugs returns no matches.

### Synthetic agent rows

The live session contained only `idle`, `working`, and `done` agents.
Two synthetic agent rows were hand-added to cover the missing `AgentStatus` values `blocked` and `unknown`, so phases 1 through 4 can test the attention line against all five values.
The synthetic rows are `agent-i` (`blocked`) and `agent-j` (`unknown`), placed in a synthetic workspace `wZ`, cloned from a real redacted row so their shape is identical to a live row.
The full set of `agent_status` values in the fixture is `blocked`, `done`, `idle`, `unknown`, `working`.

## Version values, step 1

For Phase 4 `doctor` to compare against:

- `herdr --version`: `herdr 0.8.0`
- `herdr api schema` sha256: `88ff414aa996e390c2db05a37b95d28dbe4e81b98329f6ed7f7a2cc5c6ebf51a`

Both are stored in `VERSION.txt`.
Note that `herdr api schema --json` alone exits 1; the `--output PATH` form is the one that works.
