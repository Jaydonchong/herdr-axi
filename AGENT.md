# AGENT.md - herdr-axi

Instructions for an agent working in this repo.

## What this is

`herdr-axi` is a token-lean **AXI (Agent eXperience Interface)** CLI over the `herdr` binary
(a terminal multiplexer for coding agents). It shells out to `herdr`, collapses `herdr`'s
multi-call rituals into single commands, and prints TOON on stdout instead of raw JSON.

See [README.md](README.md) for the user-facing pitch (why it exists, the measured savings) and
credits. This file is for navigating and extending the code.

## Layout

```
herdr-axi              # the CLI entry point (CommonJS bin script, executable)
lib/herdr.mjs           # all business logic: fetch* / unwrap* / render* functions (ESM)
lib/toon.mjs            # vendored TOON serializer (do not reimplement TOON - see below)
lib/herdr.test.mjs      # node --test suite for lib/herdr.mjs and CLI-level behavior
fixtures/               # test fixtures - snapshot.json, home.golden, VERSION.txt
```

Two-file split, not accidental: `herdr-axi` (CommonJS, dynamic `import()` of the ESM lib - see
its own header comment for why) owns argument parsing, the command router, and process
exit/error reporting. `lib/herdr.mjs` owns everything that talks to `herdr` or produces output -
every exported `fetch*`/`unwrap*`/`render*` function in it is unit-testable with no live `herdr`
session. Keep new logic in `lib/herdr.mjs`; keep the bin script to wiring.

## The four verbs, one shape

Every command follows: **fetch** (shell out to `herdr`, or read a fixture) -> **unwrap** (pull
the field(s) that matter off `herdr`'s JSON envelope, throw a structured `HerdrAxiError` if the
shape doesn't match) -> **render** (pure function, envelope-shaped input -> TOON string, no I/O).

- `home` - `fetchSnapshot` -> `renderHome`.
- `read <target>` - `fetchAgentGet`/`fetchAgentRead`(`Larger`)/`fetchViaFile` -> `renderRead`.
- `dispatch` / `dispatch-workspace` - `acquirePaneViaSplit` / `acquirePaneViaWorkspace` (bin
  script) resolve a target pane by two different means, then both feed the **same** shared
  pipeline: `fetchAgentStart` -> `startAgentWhenReady` -> `fetchAgentPrompt` -> `renderDispatch`.
  `renderDispatch` takes an already-resolved pane id string, never a raw envelope (a layer-
  boundary rule - see `packs/writing/integration.md`'s ABS-2 if you use `/code-loop` here).
- `doctor` - `fetchVersion`/`fetchSchemaHash` + `readExpectedVersion` -> `compareVersion` ->
  `renderDoctor`.

Adding a fifth command means adding this same three-stage shape, not a new style.

## The fixture-injection seam

Every `fetch*` function in `lib/herdr.mjs` reads its own `HERDR_AXI_<NAME>` env var first and
only shells out to the real `herdr` binary if that env var is unset. This is what lets the
whole test suite run with **no live `herdr` session** - `lib/herdr.mjs`'s own header comment
lists every current seam and its env var name; keep that comment current when you add one.

When you add a new `fetch*`, follow the existing pattern exactly (e.g. `fetchWorkspaceCreate`
mirrors `fetchPaneSplit`): same `fetchHerdrJson(args, envVar, genericMessage)` factory call,
same structured-error-on-bad-shape `unwrap*` twin, same stderr-parsing for `herdr`'s real error
code (never invent one).

## Testing

```bash
node --test lib/*.test.mjs   # = npm test
```

No live `herdr` required - everything runs against fixtures and env-seam injection. Test helper
conventions to match when adding cases: `splitEnvelope`/`promptEnvelope`/`workspaceCreateEnvelope`
(one-line envelope-builder fixtures), `tempFile`/`fakeHerdrOnPath` (filesystem/PATH fixtures),
the `cli()` runner (spawns the actual executable), and the table-driven `CASES` block near the
end of the file for exit-code/stderr-empty checks shared across commands.

## Conventions this repo has already settled

- **TOON only, on stdout.** Every render function returns a TOON string via `lib/toon.mjs`'s
  `serialize()`. Never print raw JSON to the caller.
- **stderr carries progress only, and this tool emits none** (see the bin script's own header
  comment for the full AXI contract: exit 0/1/2, stdout carries errors too).
- **Domain types cross layer boundaries, not envelopes.** A `render*` function never unwraps a
  raw `herdr` envelope itself - unwrapping happens in `lib/herdr.mjs`'s `unwrap*` functions, and
  what crosses into a `render*` function is the already-extracted value.
- **`lib/toon.mjs` is vendored, not reimplemented.** It was copied in from `~/jaygents/bin/lib/toon.mjs`
  when this repo was extracted from jaygents (see git history at the initial commit) - if a bug
  is found in it, consider whether the fix belongs upstream too; do not fork its behavior here
  without a reason specific to this tool.
- **No `~/jaygents` dependency.** This repo was deliberately extracted to stand alone - never add
  an import, a relative path, or a doc reference that assumes the `~/jaygents` tree exists.

## Companion skill

`~/jaygents/skills/herdr-axi/SKILL.md` is the agent-facing usage doc (when to reach for this CLI
instead of raw `herdr`, what each command replaces). It lives outside this repo, in `jaygents`,
alongside a sibling `herdr` skill. When you add or change a command here, that skill's body
needs the matching update - it is not generated from this repo, so update it by hand and confirm
every command/flag you document against a real `--help` run of the built CLI (never trust a
comment or this file's own text over the actual `--help` output).

## Global install

`npm link` in this directory registers `herdr-axi` on `PATH` globally (see this repo's own
history for how that was set up - there is no npm registry publish, and no CI). Re-run `npm link`
after structural changes (new files added to `lib/`) if the global command starts behaving
oddly; a plain code edit needs no re-link since `npm link` symlinks the whole directory tree.
