// herdr-axi: a token-lean control surface over the `herdr` CLI.
//
// This module is the layer boundary (ABS-2): fetchSnapshot() speaks raw herdr
// JSON, renderHome() speaks the display schema, and nothing raw crosses that
// line. renderHome() is a pure function of the raw envelope so it is testable
// with hand-built objects and needs no live herdr session.
//
// Fixture-injection seam: each herdr call (fetchSnapshot, fetchAgentGet,
// fetchAgentRead, fetchAgentReadLarger, fetchViaFile, fetchVersion,
// fetchSchemaHash, fetchPaneLayout, fetchPaneSplit, fetchWorkspaceCreate,
// fetchWorkspaceGet, fetchWorkspaceRename, fetchPaneList, fetchAgentStart,
// fetchAgentPrompt) reads its own env var (HERDR_AXI_SNAPSHOT,
// HERDR_AXI_AGENT_GET, HERDR_AXI_AGENT_READ, HERDR_AXI_AGENT_READ_LARGER,
// HERDR_AXI_VIA_FILE, HERDR_AXI_VERSION, HERDR_AXI_SCHEMA_HASH,
// HERDR_AXI_PANE_LAYOUT, HERDR_AXI_PANE_SPLIT, HERDR_AXI_WORKSPACE_CREATE,
// HERDR_AXI_WORKSPACE_GET, HERDR_AXI_WORKSPACE_RENAME, HERDR_AXI_PANE_LIST,
// HERDR_AXI_AGENT_START, HERDR_AXI_AGENT_PROMPT) when set, instead of
// shelling out. readExpectedVersion() never shells out; it reads the
// committed VERSION.txt, and HERDR_AXI_EXPECTED_VERSION_PATH overrides only
// that file path so a test can point doctor at a malformed fixture. Tests
// and the golden diff pin behavior against a fixture file without a live
// herdr session.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize } from './toon.mjs';

// Shared by the populated and empty help lines (DRY-9/DRY-10); only the tail
// after the command differs between the two states.
const DISPATCH_CMD = 'herdr-axi dispatch <name> --kind claude --prompt "<text>"';

// Truncation limit shared by truncateBody's default and the CLI's --help text
// (DRY-9): one literal, read from both sites.
export const BODY_CHAR_LIMIT = 1500;

// Parses herdr's own {"error":{"code","message"}} JSON off a failed call's
// stderr (execFileSync puts it there, never in err.message). Returns null
// when stderr is empty or does not match, so the caller falls back to a
// generic error instead of fabricating a code herdr never reported.
function parseHerdrError(err) {
  if (!err || typeof err.stderr !== 'string' || !err.stderr) return null;
  let parsed;
  try {
    parsed = JSON.parse(err.stderr);
  } catch {
    return null;
  }
  const error = parsed && parsed.error;
  if (!error || typeof error.code !== 'string' || typeof error.message !== 'string') return null;
  return { code: error.code, message: error.message };
}

// Next-step help for every herdr error code this tool has live-confirmed or
// found documented upstream (agent_blocked was documented but not observed
// live this session). A code missing from this map still gets HERDR_ERROR_HELP_FALLBACK,
// so a renamed or future herdr code surfaces cleanly instead of a blank help[].
// Shared between the two codes each describes (DRY-9): agent_not_ready and
// agent_pane_busy are both "not a shell prompt yet"; agent_prompt_stalled and
// timeout are both "no response within the deadline".
const PANE_NOT_READY_HELP = ['The pane has not reached its shell prompt yet; retry'];
const NO_RESPONSE_HELP = ['The agent did not respond in time; run `herdr-axi read <target>` to see its pane'];

const HERDR_ERROR_HELP = {
  agent_not_found: ['Run `herdr-axi` for the home view to see the live agent name'],
  agent_not_ready: PANE_NOT_READY_HELP,
  agent_pane_busy: PANE_NOT_READY_HELP,
  agent_prompt_stalled: NO_RESPONSE_HELP,
  timeout: NO_RESPONSE_HELP,
  agent_not_idle: ['The agent is busy or blocked; run `herdr-axi read <target> --source visible` to see it'],
  agent_blocked: ['The agent is blocked; run `herdr-axi read <target> --source visible` to see it'],
  agent_name_taken: ['Run `herdr-axi` for the home view to see names already in use, then pick another'],
};
const HERDR_ERROR_HELP_FALLBACK = ['Run `herdr-axi read <target>` to see the agent\'s current state'];

// help[] for a parsed herdr error, by code (DRY-9/DRY-10: one lookup shared by
// every fetch* site that constructs a HerdrAxiError from parseHerdrError()).
function herdrErrorHelp(code) {
  return HERDR_ERROR_HELP[code] || HERDR_ERROR_HELP_FALLBACK;
}

export class HerdrAxiError extends Error {
  constructor(message, { code = 'herdr_axi_error', help = null } = {}) {
    super(message);
    this.name = 'HerdrAxiError';
    this.code = code;
    this.help = help;
  }
}

// Fetches the raw snapshot envelope: {id, result:{type, snapshot:{...}}}.
// LIB-1: a missing/renamed herdr binary or a reshaped envelope must surface as
// a structured error, never a crash or a silent empty projection.
export function fetchSnapshot() {
  const fixture = process.env.HERDR_AXI_SNAPSHOT;
  let text;
  if (fixture) {
    try {
      text = readFileSync(fixture, 'utf8');
    } catch (err) {
      throw new HerdrAxiError(`cannot read HERDR_AXI_SNAPSHOT (${err.code || 'read failed'})`, {
        code: 'fixture_read_failed',
      });
    }
  } else {
    try {
      // stdio captures herdr's stderr into err.stderr instead of inheriting it
      // to ours (AXI contract, herdr-axi:10-13: stderr is progress only).
      text = execFileSync('herdr', ['api', 'snapshot'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const reason = err.code === 'ENOENT' ? 'herdr binary not found on PATH' : (err.message || 'herdr api snapshot failed');
      throw new HerdrAxiError(reason, {
        code: 'herdr_call_failed',
        help: ['Confirm `herdr` is installed and on PATH, or set HERDR_AXI_SNAPSHOT to a fixture file'],
      });
    }
  }
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new HerdrAxiError('herdr returned output that is not valid JSON', { code: 'bad_json' });
  }
  return envelope;
}

// Unwraps .result.snapshot, the SessionSnapshot. A renamed upstream field must
// not silently produce empty columns; this is the one seam where that would
// happen, so it errors loudly instead.
function unwrapSnapshot(envelope) {
  const snapshot = envelope && envelope.result && envelope.result.snapshot;
  if (!snapshot || typeof snapshot !== 'object') {
    throw new HerdrAxiError('herdr response has no .result.snapshot; the herdr API shape may have changed', {
      code: 'bad_snapshot_shape',
      help: ['Run `herdr-axi doctor` to compare the live schema against the one this tool expects'],
    });
  }
  return snapshot;
}

// Nameless-agent fallback (SETTLED): an agent with no `name` displays its
// pane_id instead, everywhere a name is shown, including the attention line.
const displayName = (agent) => agent.name || agent.pane_id;

function projectWorkspace(w) {
  return { id: w.workspace_id, label: w.label, tabs: w.tab_count, panes: w.pane_count };
}

function projectAgent(a) {
  return { name: displayName(a), pane: a.pane_id, kind: a.agent, status: a.agent_status, cwd: a.cwd };
}

function computeAttention(rawAgents) {
  return rawAgents
    .filter((a) => a.agent_status === 'blocked')
    .map((a) => `${displayName(a)} is blocked at an approval or question dialog`);
}

function computeHelp(rawAgents, attention) {
  const help = [];
  if (attention.length > 0) {
    const first = displayName(rawAgents.find((a) => a.agent_status === 'blocked'));
    help.push(`Run \`herdr-axi read ${first} --lines 40\` to see what ${first} is waiting on`);
  }
  help.push(`Run \`${DISPATCH_CMD}\` to start an agent beside you`);
  return help;
}

// Realpath of the invoked script, home-dir prefix collapsed to "~". Reflects
// where herdr-axi actually lives (tools/), not a hardcoded bin/ path.
// Matches only a full path segment boundary, so "/Users/jaydon2/..." is not
// mistaken for a path under "/Users/jaydon".
export function binPath(realPath, home) {
  if (realPath === home || realPath.startsWith(home + sep)) {
    return `~${realPath.slice(home.length)}`;
  }
  return realPath;
}

// The cwd of the pane the caller is focused on. No matching pane is treated as
// "no cwd known" rather than a crash, since the identity block must still print.
function focusedCwd(panes, focusedPaneId) {
  const pane = panes.find((p) => p.pane_id === focusedPaneId);
  return pane ? pane.cwd : '';
}

// renderHome(rawEnvelope, opts) -> TOON string. Pure: no I/O, so tests call it
// directly with hand-built envelopes.
export function renderHome(envelope, { bin } = {}) {
  const snapshot = unwrapSnapshot(envelope);
  const { agents, panes, workspaces, focused_pane_id: focusedPaneId, version } = snapshot;

  const counts = `${agents.length} of ${agents.length} agents, ${panes.length} panes, ${workspaces.length} workspaces`;

  if (agents.length === 0) {
    // EMPTY STATE (SETTLED): full collapse, no identity block or tables.
    // Every byte here goes through serialize(); there is no hand-composed
    // TOON in this module.
    return serialize({
      agents: `no live agents in this session (${workspaces.length} workspaces, ${panes.length} panes scanned)`,
      help: [`Run \`${DISPATCH_CMD}\` to start one`],
    });
  }

  const attention = computeAttention(agents);
  const help = computeHelp(agents, attention);

  // Omit the version suffix entirely when absent, rather than print
  // "herdr undefined"; a missing version is not worth a placeholder.
  const description = version
    ? `token-lean control surface over herdr ${version}`
    : 'token-lean control surface over herdr';

  const doc = {
    bin,
    description,
    session: 'default',
    focused: focusedPaneId,
    cwd: focusedCwd(panes, focusedPaneId),
    workspaces: workspaces.map(projectWorkspace),
    agents: agents.map(projectAgent),
    counts,
  };
  if (attention.length > 0) doc.attention = attention;
  doc.help = help;

  return serialize(doc);
}

// ---------------------------------------------------------------------------
// read <target>: merges `agent get` (status) with `agent read` (pane content).
// ---------------------------------------------------------------------------

// Fetches the raw agent-get envelope: {id, result:{agent:{...}}}. Mirrors
// fetchSnapshot()'s three failure modes exactly (LIB-1: same shape as the
// mechanism this module already established).
export function fetchAgentGet(target) {
  const fixture = process.env.HERDR_AXI_AGENT_GET;
  let text;
  if (fixture) {
    try {
      text = readFileSync(fixture, 'utf8');
    } catch (err) {
      throw new HerdrAxiError(`cannot read HERDR_AXI_AGENT_GET (${err.code || 'read failed'})`, {
        code: 'fixture_read_failed',
      });
    }
  } else {
    try {
      // stdio captures herdr's stderr into err.stderr instead of inheriting it
      // to ours (AXI contract, herdr-axi:10-13: stderr is progress only).
      text = execFileSync('herdr', ['agent', 'get', target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new HerdrAxiError('herdr binary not found on PATH', {
          code: 'herdr_call_failed',
          help: ['Confirm `herdr` is installed and on PATH, or set HERDR_AXI_AGENT_GET to a fixture file'],
        });
      }
      // herdr ran and exited nonzero: prefer its own {code,message} (e.g.
      // agent_not_found) over a generic failure that discards the signal.
      const herdrError = parseHerdrError(err);
      if (herdrError) throw new HerdrAxiError(herdrError.message, { code: herdrError.code, help: herdrErrorHelp(herdrError.code) });
      throw new HerdrAxiError(err.message || 'herdr agent get failed', {
        code: 'herdr_call_failed',
        help: ['Confirm `herdr` is installed and on PATH, or set HERDR_AXI_AGENT_GET to a fixture file'],
      });
    }
  }
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new HerdrAxiError('herdr returned output that is not valid JSON', { code: 'bad_json' });
  }
  return envelope;
}

// Unwraps .result.agent (NOT .result: `agent get`'s envelope nests one level
// deeper than the snapshot envelope). Mirrors unwrapSnapshot()'s loud failure.
export function unwrapAgentGet(envelope) {
  const agent = envelope && envelope.result && envelope.result.agent;
  if (!agent || typeof agent !== 'object') {
    throw new HerdrAxiError('herdr response has no .result.agent; the herdr API shape may have changed', {
      code: 'bad_agent_shape',
      help: ['Run `herdr-axi doctor` to compare the live schema against the one this tool expects'],
    });
  }
  return agent;
}

// Shared by fetchAgentRead/fetchAgentReadLarger (DRY-10): only the fixture env
// var differs, one per herdr call per the HERDR_AXI_SNAPSHOT convention. There
// is no --json on this CLI surface, so the return value is raw terminal text.
function readAgentPane(target, { source, lines }, fixtureEnvVar) {
  const fixture = process.env[fixtureEnvVar];
  if (fixture) {
    try {
      return readFileSync(fixture, 'utf8');
    } catch (err) {
      throw new HerdrAxiError(`cannot read ${fixtureEnvVar} (${err.code || 'read failed'})`, {
        code: 'fixture_read_failed',
      });
    }
  }
  try {
    // stdio captures herdr's stderr into err.stderr instead of inheriting it to
    // ours (AXI contract, herdr-axi:10-13). Live-confirmed: dispatch's blocked
    // branch calls this on an agent_not_idle-prone read, and without this the
    // failed call's raw {"error":...} JSON printed to our stderr.
    return execFileSync(
      'herdr',
      ['agent', 'read', target, '--source', source, '--lines', String(lines)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new HerdrAxiError('herdr binary not found on PATH', {
        code: 'herdr_call_failed',
        help: [`Confirm \`herdr\` is installed and on PATH, or set ${fixtureEnvVar} to a fixture file`],
      });
    }
    // Mirrors fetchAgentGet's fallback (LIB-1): a missing target on the read
    // call should also surface herdr's real code, e.g. agent_not_found.
    const herdrError = parseHerdrError(err);
    if (herdrError) throw new HerdrAxiError(herdrError.message, { code: herdrError.code, help: herdrErrorHelp(herdrError.code) });
    throw new HerdrAxiError(err.message || 'herdr agent read failed', {
      code: 'herdr_call_failed',
      help: [`Confirm \`herdr\` is installed and on PATH, or set ${fixtureEnvVar} to a fixture file`],
    });
  }
}

// The primary read, at the requested (or default) --lines.
export function fetchAgentRead(target, opts) {
  return readAgentPane(target, opts, 'HERDR_AXI_AGENT_READ');
}

// A second read at a larger --lines, used only to run detectAlternateScreen().
// Its own env seam lets a test inject different text than the primary read.
export function fetchAgentReadLarger(target, opts) {
  return readAgentPane(target, opts, 'HERDR_AXI_AGENT_READ_LARGER');
}

// The write-to-Markdown request sent to the agent when --via-file mutates.
const VIA_FILE_PROMPT = 'Write your current context or screen to a temporary Markdown file, then reply with only the absolute file path.';

// Synchronous sleep for retry backoff: a real herdr/filesystem call already
// blocks the event loop, so this stays consistent rather than going async
// (herdr-axi is a synchronous CLI, not an async server). Shared by both
// retry helpers below (readFileWhenReady's default) and by the bin's
// startAgentWhenReady call (DRY-10/DRY-11: one sync-sleep implementation).
export function syncSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// `agent prompt --wait` returns as soon as the agent replies with the path,
// which can be before the file is flushed to disk - the read-back races the
// write and can see ENOENT on a file that exists moments later. Unlike
// DISPATCH_SHELL_READY_* (BASELINE.md-measured pane-readiness wait), this
// flush race has no live measurement yet - the budget below is an unmeasured,
// deliberately conservative placeholder, short only because a flush race is
// expected to resolve fast. On exhaustion this degrades to exactly the prior
// behavior (via_file_read_failed), so an under-estimate here is not a
// regression, just a candidate for tightening once a real measurement exists.
export const VIA_FILE_READ_RETRY_TIMEOUT_MS = 200;
export const VIA_FILE_READ_RETRY_POLL_MS = 20;

// Retries reading `path` while it fails with ENOENT, until it succeeds or
// timeoutMs elapses (mirrors startAgentWhenReady's shape). Any other read
// error rethrows immediately, unretried. readFile/sleep/now are injected with
// real defaults so this is unit-testable without real delays or a real file,
// and fetchViaFile below needs no call-site change to use it.
export function readFileWhenReady(path, {
  readFile = readFileSync, sleep = syncSleep, now = Date.now,
  timeoutMs = VIA_FILE_READ_RETRY_TIMEOUT_MS,
  pollMs = VIA_FILE_READ_RETRY_POLL_MS,
} = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      return readFile(path, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      if (now() >= deadline) throw err;
      sleep(pollMs);
    }
  }
}

// --via-file mechanism: no herdr subcommand writes Markdown, so this prompts
// the agent to write one and reads the path it reports back. HERDR_AXI_VIA_FILE
// short-circuits the whole round trip with fixture text, since the prompt and
// the read-back are one logical operation from this module's point of view.
export function fetchViaFile(target) {
  const fixture = process.env.HERDR_AXI_VIA_FILE;
  if (fixture) {
    try {
      return readFileSync(fixture, 'utf8');
    } catch (err) {
      throw new HerdrAxiError(`cannot read HERDR_AXI_VIA_FILE (${err.code || 'read failed'})`, {
        code: 'fixture_read_failed',
      });
    }
  }
  let pathText;
  try {
    // stdio captures herdr's stderr into err.stderr instead of inheriting it
    // to ours (AXI contract, herdr-axi:10-13: stderr is progress only).
    pathText = execFileSync('herdr', ['agent', 'prompt', target, VIA_FILE_PROMPT, '--wait'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const reason = err.code === 'ENOENT' ? 'herdr binary not found on PATH' : (err.message || 'herdr agent prompt --wait failed');
    throw new HerdrAxiError(reason, { code: 'via_file_prompt_failed' });
  }
  const path = pathText.trim();
  try {
    return readFileWhenReady(path);
  } catch (err) {
    throw new HerdrAxiError(`cannot read the path the agent reported (${err.code || 'read failed'})`, {
      code: 'via_file_read_failed',
    });
  }
}

// ---------------------------------------------------------------------------
// dispatch <name> --kind <k> --prompt <text>: split a pane, start an agent,
// prompt it, and report where it settled.
// ---------------------------------------------------------------------------

// A pane wide enough to split side by side rather than stack. The one live
// data point (BASELINE.md:42) is 233 cols -> right; 160 is a defensible
// judgment call between that and a conventional 80-column terminal doubled,
// pending more live samples.
const DISPATCH_WIDE_WIDTH_THRESHOLD = 160;

// chooseDirection(layout) -> 'right' | 'down'. Pure: takes the unwrapped pane
// layout area (has .width), so tests call it with hand-built objects.
export function chooseDirection(layout) {
  return layout.width >= DISPATCH_WIDE_WIDTH_THRESHOLD ? 'right' : 'down';
}

// Shared by the four dispatch-orchestration fetches (DRY-10): each differs
// only in its herdr args, its fixture env var, and its generic-failure
// message. Mirrors fetchAgentGet's three failure modes (LIB-1): a missing
// binary, herdr's own {code,message} on a nonzero exit, or a generic
// fallback, never a fabricated code.
function fetchHerdrJson(args, fixtureEnvVar, genericMessage) {
  const fixture = process.env[fixtureEnvVar];
  let text;
  if (fixture) {
    try {
      text = readFileSync(fixture, 'utf8');
    } catch (err) {
      throw new HerdrAxiError(`cannot read ${fixtureEnvVar} (${err.code || 'read failed'})`, {
        code: 'fixture_read_failed',
      });
    }
  } else {
    try {
      // stdio captures herdr's stderr into err.stderr instead of inheriting it
      // to ours (AXI contract, herdr-axi:10-13: stderr is progress only, this
      // tool emits none). Live-confirmed: without this, a failed herdr call's
      // raw {"error":...} JSON printed to our stderr. readAgentPane above
      // shares this fix, and fetchSnapshot/fetchAgentGet/fetchViaFile now carry
      // it too (Phase 4).
      text = execFileSync('herdr', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new HerdrAxiError('herdr binary not found on PATH', {
          code: 'herdr_call_failed',
          help: [`Confirm \`herdr\` is installed and on PATH, or set ${fixtureEnvVar} to a fixture file`],
        });
      }
      const herdrError = parseHerdrError(err);
      if (herdrError) throw new HerdrAxiError(herdrError.message, { code: herdrError.code, help: herdrErrorHelp(herdrError.code) });
      throw new HerdrAxiError(err.message || genericMessage, {
        code: 'herdr_call_failed',
        help: [`Confirm \`herdr\` is installed and on PATH, or set ${fixtureEnvVar} to a fixture file`],
      });
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HerdrAxiError('herdr returned output that is not valid JSON', { code: 'bad_json' });
  }
}

// Fetches the raw pane-layout envelope: {id, result:{layout:{area:{width,...}}}}.
// Always passed an explicit --pane: --current/optional flags can default to
// the globally-focused workspace, not the caller's own pane.
export function fetchPaneLayout(paneId) {
  return fetchHerdrJson(['pane', 'layout', '--pane', paneId], 'HERDR_AXI_PANE_LAYOUT', 'herdr pane layout failed');
}

// Unwraps .result.layout.area, the geometry chooseDirection() reads.
export function unwrapPaneLayout(envelope) {
  const area = envelope && envelope.result && envelope.result.layout && envelope.result.layout.area;
  if (!area || typeof area.width !== 'number') {
    throw new HerdrAxiError('herdr response has no .result.layout.area; the herdr API shape may have changed', {
      code: 'bad_layout_shape',
      help: ['Run `herdr-axi doctor` to compare the live schema against the one this tool expects'],
    });
  }
  return area;
}

// Fetches the raw pane-split envelope: {id, result:{pane:{pane_id,...}}}.
// Splits the caller's own pane (--current) by default; an explicit paneId
// (dispatch --workspace's scope) splits that pane instead. The sole caller
// that omits paneId (acquirePaneViaSplit) keeps getting --current unchanged.
export function fetchPaneSplit({ direction, cwd, pane }) {
  const target = pane ? ['--pane', pane] : ['--current'];
  return fetchHerdrJson(
    ['pane', 'split', ...target, '--direction', direction, '--cwd', cwd, '--no-focus'],
    'HERDR_AXI_PANE_SPLIT',
    'herdr pane split failed',
  );
}

// Unwraps .result.pane, the new pane the agent gets started in.
export function unwrapPaneSplit(envelope) {
  const pane = envelope && envelope.result && envelope.result.pane;
  if (!pane || typeof pane.pane_id !== 'string') {
    throw new HerdrAxiError('herdr response has no .result.pane; the herdr API shape may have changed', {
      code: 'bad_split_shape',
      help: ['Run `herdr-axi doctor` to compare the live schema against the one this tool expects'],
    });
  }
  return pane;
}

// Fetches the raw workspace-create envelope: {id, result:{workspace, tab,
// root_pane:{pane_id,...}}} (live-confirmed shape, herdr 0.8.0). --no-focus
// mirrors fetchPaneSplit: dispatch-workspace never steals focus either.
export function fetchWorkspaceCreate({ cwd }) {
  return fetchHerdrJson(
    ['workspace', 'create', '--cwd', cwd, '--no-focus'],
    'HERDR_AXI_WORKSPACE_CREATE',
    'herdr workspace create failed',
  );
}

// Unwraps .result.root_pane and .result.workspace, the two raw sub-structures
// the caller needs (ABS-2): the pane the agent gets started in, and the
// workspace fetchWorkspaceRename() targets when dispatch-workspace --label is
// set. Like every sibling unwrap*, returns the raw sub-structures unmodified
// and leaves field extraction to the call site. Guards both root_pane.pane_id
// and workspace.workspace_id, since the caller needs both fields.
export function unwrapWorkspaceCreate(envelope) {
  const rootPane = envelope && envelope.result && envelope.result.root_pane;
  if (!rootPane || typeof rootPane.pane_id !== 'string') {
    throw new HerdrAxiError('herdr response has no .result.root_pane; the herdr API shape may have changed', {
      code: 'bad_workspace_create_shape',
      help: ['Run `herdr-axi doctor` to compare the live schema against the one this tool expects'],
    });
  }
  const workspace = envelope.result.workspace;
  if (!workspace || typeof workspace.workspace_id !== 'string') {
    throw new HerdrAxiError('herdr response has no .result.workspace.workspace_id; the herdr API shape may have changed', {
      code: 'bad_workspace_create_shape',
      help: ['Run `herdr-axi doctor` to compare the live schema against the one this tool expects'],
    });
  }
  return { rootPane, workspace };
}

// Renames a workspace to a mixed-case human label, decoupled from the
// lowercase-constrained agent name (dispatch-workspace --label). Live-
// confirmed (herdr 0.8.0): a single argv label round-trips unmodified,
// mixed case and punctuation preserved, so no escaping is needed here.
export function fetchWorkspaceRename(workspaceId, label) {
  return fetchHerdrJson(
    ['workspace', 'rename', workspaceId, label],
    'HERDR_AXI_WORKSPACE_RENAME',
    'herdr workspace rename failed',
  );
}

// Fetches the raw workspace-get envelope: {id, result:{workspace:{...}}}
// (live-confirmed shape, herdr 0.8.0).
export function fetchWorkspaceGet(id) {
  return fetchHerdrJson(['workspace', 'get', id], 'HERDR_AXI_WORKSPACE_GET', 'herdr workspace get failed');
}

// Unwraps .result.workspace. `workspace get` never returns a pane id
// (live-confirmed), only active_tab_id; resolving a pane needs a follow-up
// fetchPaneList/pickActivePane call, unlike fetchWorkspaceCreate's root_pane.
export function unwrapWorkspaceGet(envelope) {
  const workspace = envelope && envelope.result && envelope.result.workspace;
  if (!workspace || typeof workspace.active_tab_id !== 'string' || typeof workspace.workspace_id !== 'string') {
    throw new HerdrAxiError('herdr response has no .result.workspace.active_tab_id; the herdr API shape may have changed', {
      code: 'bad_workspace_shape',
      help: ['Run `herdr-axi doctor` to compare the live schema against the one this tool expects'],
    });
  }
  return workspace;
}

// Fetches the raw pane-list envelope: {id, result:{panes:[...]}}
// (live-confirmed shape, herdr 0.8.0).
export function fetchPaneList({ workspace }) {
  return fetchHerdrJson(['pane', 'list', '--workspace', workspace], 'HERDR_AXI_PANE_LIST', 'herdr pane list failed');
}

// Unwraps .result.panes, the array pickActivePane() picks from.
export function unwrapPaneList(envelope) {
  const panes = envelope && envelope.result && envelope.result.panes;
  if (!Array.isArray(panes)) {
    throw new HerdrAxiError('herdr response has no .result.panes array; the herdr API shape may have changed', {
      code: 'bad_pane_list_shape',
      help: ['Run `herdr-axi doctor` to compare the live schema against the one this tool expects'],
    });
  }
  return panes;
}

// pickActivePane(panes, activeTabId) -> pane_id. Pure: takes the unwrapped
// pane list and the workspace's active tab id, so tests call it with
// hand-built arrays (mirrors chooseDirection's pure/exported shape). Two
// panes sharing one tab_id is normal (a split within the tab; live sample:
// wK:p1 and wK:p2 both under wK:t1) - the first match is deterministic,
// since ordering beyond that is not guaranteed.
export function pickActivePane(panes, activeTabId) {
  const match = panes.find((p) => p.tab_id === activeTabId);
  if (!match) {
    throw new HerdrAxiError(`no pane in the workspace belongs to its active tab ${activeTabId}`, {
      code: 'no_pane_in_workspace',
      help: ['Run `herdr pane list --workspace <id>` to inspect the workspace\'s panes'],
    });
  }
  if (typeof match.pane_id !== 'string') {
    throw new HerdrAxiError('herdr response has no .result.panes array; the herdr API shape may have changed', {
      code: 'bad_pane_list_shape',
      help: ['Run `herdr-axi doctor` to compare the live schema against the one this tool expects'],
    });
  }
  return match.pane_id;
}

// Starts the agent. `agent start` has its own --timeout for interactive
// readiness AFTER launch, but checks "is the pane an available shell?" only
// ONCE, immediately, and fails instantly with agent_pane_busy if a freshly
// split pane has not yet reached its interactive shell prompt (BASELINE.md:
// 44-47; live-confirmed this session: split->start succeeded only on retry,
// after ~4.1s). startAgentWhenReady() below retries this call while it fails
// with agent_pane_busy; any other code is a genuine failure and surfaces as-is.
export function fetchAgentStart(name, kind, paneId) {
  return fetchHerdrJson(
    ['agent', 'start', name, '--kind', kind, '--pane', paneId],
    'HERDR_AXI_AGENT_START',
    'herdr agent start failed',
  );
}

// A pane freshly split by `pane split` is not immediately an available shell
// (BASELINE.md:44-47; live-confirmed: split->start succeeded on the 3rd
// attempt after ~4.1s). 30s gives generous headroom over both data points, on
// the same order as agent start's own default --timeout for post-launch
// readiness.
export const DISPATCH_SHELL_READY_TIMEOUT_MS = 30000;
// Poll interval between agent_pane_busy retries; short enough not to overshoot
// the ~3-4s observed wait by much.
export const DISPATCH_SHELL_READY_POLL_MS = 500;

// Retries `attempt` while it fails with agent_pane_busy, until the pane
// becomes an available shell or timeoutMs elapses. Any other HerdrAxiError
// code is a genuine failure and rethrows immediately, unretried. attempt,
// sleep, and now are injected so this is unit-testable without real delays or
// a live herdr session (the fixture env-var seam returns a fixed value every
// call, so it cannot simulate "busy then ready" on its own).
export function startAgentWhenReady({
  attempt, sleep, now,
  timeoutMs = DISPATCH_SHELL_READY_TIMEOUT_MS,
  pollMs = DISPATCH_SHELL_READY_POLL_MS,
}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      return attempt();
    } catch (err) {
      if (!(err instanceof HerdrAxiError) || err.code !== 'agent_pane_busy') throw err;
      if (now() >= deadline) throw err;
      sleep(pollMs);
    }
  }
}

// Prompts the agent, optionally waiting for it to settle. A settle - idle,
// done, or blocked - returns EXIT 0 with the settled agent at .result.agent,
// the same nesting `agent get` uses (herdr 0.8.0, live-confirmed). Only
// agent_prompt_stalled (no state change observed within 5000ms) is a genuine
// nonzero-exit error, which fetchHerdrJson's parseHerdrError already surfaces
// undisguised.
export function fetchAgentPrompt(name, text, { wait } = {}) {
  const args = ['agent', 'prompt', name, text];
  if (wait) args.push('--wait');
  return fetchHerdrJson(args, 'HERDR_AXI_AGENT_PROMPT', 'herdr agent prompt failed');
}

// The first line with actual content in a blocked agent's pane read, shown as
// the waiting_on headline. A real approval/question dialog (herdr 0.8.0, live)
// opens with a box-drawing separator ("──────"), which carries no meaning;
// skip blank and separator-only lines and return the first with a letter or
// digit, trimmed. Null when no such line exists (best-effort: a null
// waiting_on must still leave status:blocked as the headline).
export function firstMeaningfulLine(text) {
  const lines = String(text).split('\n');
  const line = lines.find((l) => /[\p{L}\p{N}]/u.test(l));
  return line !== undefined ? line.trim() : null;
}

// help[] for a settled agent's follow-up read, matching computeHelp/
// computeReadHelp's pattern: the message depends on how the settle landed,
// one constant line either way. Shared by renderDispatch and renderPrompt
// (DRY-10/DRY-11): both point at `herdr-axi read <target>` and phrase a
// blocked settle identically, differing only in the name they read as a
// freshly-dispatched agent vs. an already-existing target.
function computeSettleHelp(target, { status, waitingOn }) {
  if (status === 'blocked') {
    return waitingOn
      ? [`Run \`herdr-axi read ${target}\` for the full dialog`]
      : [`Run \`herdr-axi read ${target}\` to see what ${target} is waiting on`];
  }
  return [`Run \`herdr-axi read ${target}\` for the full pane content`];
}

// renderDispatch(pane, promptEnvelope, opts) -> TOON string. Pure: no I/O, so
// tests call it directly with hand-built envelopes. `pane` is the already-
// resolved pane id string (ABS-2: the caller resolves it via whichever
// acquirePaneVia* ran, never a raw split/workspace-create envelope). A
// blocked settle is exit 0 (herdr 0.8.0, live-confirmed) and reaches this
// function like any other settle: its status and waiting_on render as
// top-level headline fields, never summarised away under help[] (the
// dispatch unit's non-negotiable rule). waitingOn is best-effort and may be
// null even on a blocked settle, when the follow-up pane read failed.
export function renderDispatch(pane, promptEnvelope, { name, kind, direction, wait, waitingOn } = {}) {
  const doc = { name, pane, kind };
  // dispatch-workspace has no direction to report.
  if (direction) doc.direction = direction;

  if (!wait) {
    doc.status = 'sent, not waited for';
    doc.help = [`Run \`herdr-axi read ${name}\` to check on ${name}`];
    return serialize(doc);
  }

  const status = unwrapAgentGet(promptEnvelope).agent_status;
  doc.status = status;
  if (status === 'blocked' && waitingOn) doc.waiting_on = waitingOn;
  doc.help = computeSettleHelp(name, { status, waitingOn });
  return serialize(doc);
}

// ---------------------------------------------------------------------------
// prompt <target> "<text>": send a follow-up message to an already-existing
// agent. Thin wrapper over fetchAgentPrompt (reused unchanged from dispatch);
// v1 is prompt-only, with no folded read after (see AGENT.md's thesis).
// ---------------------------------------------------------------------------

// renderPrompt(target, promptEnvelope, opts) -> TOON string. Pure: no I/O, so
// tests call it directly with hand-built envelopes. Mirrors renderDispatch's
// settle rendering (ABS-2: takes the raw promptEnvelope and unwraps it here,
// matching that existing choice) but for a target that already exists - no
// pane/kind/direction to report, since nothing was split or started.
export function renderPrompt(target, promptEnvelope, { wait, waitingOn } = {}) {
  const doc = { target };

  if (!wait) {
    doc.status = 'sent, not waited for';
    doc.help = [`Run \`herdr-axi read ${target}\` to check on ${target}`];
    return serialize(doc);
  }

  const status = unwrapAgentGet(promptEnvelope).agent_status;
  doc.status = status;
  if (status === 'blocked' && waitingOn) doc.waiting_on = waitingOn;
  doc.help = computeSettleHelp(target, { status, waitingOn });
  return serialize(doc);
}

// Truncates the body to `limit` characters. totalLength is the untruncated
// char count; the caller emits a size key only when truncated is true.
export function truncateBody(text, limit = BODY_CHAR_LIMIT) {
  const totalLength = text.length;
  const truncated = totalLength > limit;
  let cutAt = limit;
  if (truncated) {
    // A high surrogate at limit-1 paired with a low surrogate at limit means
    // slice(0, limit) would split one UTF-16 code point; back off one unit.
    const high = text.charCodeAt(cutAt - 1);
    const low = text.charCodeAt(cutAt);
    if (high >= 0xD800 && high <= 0xDBFF && low >= 0xDC00 && low <= 0xDFFF) cutAt -= 1;
  }
  return { body: truncated ? text.slice(0, cutAt) : text, truncated, totalLength };
}

// A pane read pads a short scrollback buffer with trailing blank lines to
// reach the requested --lines count (BASELINE.md scenario 3). Stripping that
// padding is what makes a real-content comparison meaningful.
function normalizeLines(text) {
  const lines = String(text).split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

// A ±1-line jitter is expected between two live reads of the same pane
// (cursor/timestamp rendering), so an equality comparison needs tolerance.
const ALT_SCREEN_LINE_JITTER = 1;

// Empirical heuristic (`agent read` exposes no `truncated` field on this CLI
// surface): compares a primary read against a read at a larger --lines to
// tell three states apart, per the three BASELINE.md/live-session data points.
export function detectAlternateScreen(primaryText, largerText, { requestedLines } = {}) {
  const primaryRawLines = String(primaryText).split('\n').length;
  const largerRawLines = String(largerText).split('\n').length;
  const normPrimary = normalizeLines(primaryText);
  const normLarger = normalizeLines(largerText);

  // The larger read recovered more real content: not capped at all
  // (v1-resolvers: 120 -> 392 lines).
  if (normLarger.length > normPrimary.length + ALT_SCREEN_LINE_JITTER) return null;

  // A frozen alt-screen frame is byte-identical and never shrinks
  // (BASELINE.md scenario 3). A shrink here proves scrollback is reachable,
  // whether it is padding coming off (bp-09 padded-short) or the buffer
  // itself unwrapping to fewer, longer lines (bp-09 live false positive) -
  // do not gate this on an exact-substring match, since a trailing prompt
  // glyph can differ line-to-line between the two reads.
  const rawShrank = largerRawLines < primaryRawLines - ALT_SCREEN_LINE_JITTER;
  const contentShrank = normLarger.length < normPrimary.length - ALT_SCREEN_LINE_JITTER;
  if (rawShrank || contentShrank) return null;

  // A frozen alternate-screen frame is a substantial, byte-identical block
  // (BASELINE.md scenario 3: dozens of lines); an empty or near-empty buffer
  // is not evidence of one, even if it did not change across --lines.
  if (normPrimary.length <= ALT_SCREEN_LINE_JITTER) return null;

  // The raw output neither grew nor shrank despite a larger --lines request:
  // the pane is frozen on an alternate screen, which does not change with
  // scrollback (BASELINE.md scenario 3: --lines 120 -> 400 is byte-identical).
  return `pane appears frozen on an alternate-screen frame (raising --lines to ${requestedLines} recovered no more content); try --via-file`;
}

// help[] follows computeHelp()'s pattern: conditional lines first, one
// constant line last.
function computeReadHelp(target, { truncated, totalLength, altScreen, lines }) {
  const help = [];
  if (truncated) help.push(`Run \`herdr-axi read ${target} --full\` to see the full ${totalLength}-character body`);
  if (altScreen) help.push(`Run \`herdr-axi read ${target} --via-file\` to recover the frozen frame's real content`);
  help.push(`Run \`herdr-axi read ${target} --lines ${lines * 2}\` to see more scrollback`);
  return help;
}

// renderRead(agentEnvelope, primaryText, opts) -> TOON string. Pure: no I/O,
// so tests call it directly with hand-built envelopes and raw pane text.
export function renderRead(agentEnvelope, primaryText, { source, lines, full, largerText, largerLines } = {}) {
  const agent = unwrapAgentGet(agentEnvelope);
  const identity = projectAgent(agent);

  const { body, truncated, totalLength } = full
    ? { body: primaryText, truncated: false, totalLength: primaryText.length }
    : truncateBody(primaryText);

  // requestedLines names the larger read actually tried (FIX B): the CLI's
  // LARGER_LINES_MULTIPLIER makes this a multiple of `lines`, not `lines` itself.
  const altScreen = largerText != null
    ? detectAlternateScreen(primaryText, largerText, { requestedLines: largerLines ?? lines })
    : null;

  const doc = {
    target: identity.name,
    pane: identity.pane,
    kind: identity.kind,
    status: identity.status,
    cwd: identity.cwd,
    source,
    lines,
    body,
  };
  if (truncated) doc.size = totalLength;
  if (altScreen) doc.alt_screen = altScreen;
  doc.help = computeReadHelp(identity.name, { truncated, totalLength, altScreen, lines });

  return serialize(doc);
}

// ---------------------------------------------------------------------------
// doctor: compares live herdr's version and API schema against the fixture
// this tool was tested against (tools/fixtures/VERSION.txt).
// ---------------------------------------------------------------------------

// Fetches herdr's own --version string, trimmed. Mirrors fetchSnapshot's
// three failure modes (LIB-1): a fixture seam, a missing binary, or any other
// shell failure, never a crash.
export function fetchVersion() {
  const fixture = process.env.HERDR_AXI_VERSION;
  if (fixture) {
    try {
      return readFileSync(fixture, 'utf8').trim();
    } catch (err) {
      throw new HerdrAxiError(`cannot read HERDR_AXI_VERSION (${err.code || 'read failed'})`, {
        code: 'fixture_read_failed',
      });
    }
  }
  try {
    return execFileSync('herdr', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    const reason = err.code === 'ENOENT' ? 'herdr binary not found on PATH' : (err.message || 'herdr --version failed');
    throw new HerdrAxiError(reason, {
      code: 'herdr_call_failed',
      help: ['Confirm `herdr` is installed and on PATH, or set HERDR_AXI_VERSION to a fixture file'],
    });
  }
}

// Fetches the sha256 of herdr's own API schema. `herdr api schema --json`
// is unusable live (live-confirmed this session); `--output <path>` is the
// only working form, so this writes to a temp file and hashes it, mirroring
// fetchSnapshot's three failure modes (LIB-1).
export function fetchSchemaHash() {
  const fixture = process.env.HERDR_AXI_SCHEMA_HASH;
  if (fixture) {
    try {
      return readFileSync(fixture, 'utf8').trim();
    } catch (err) {
      throw new HerdrAxiError(`cannot read HERDR_AXI_SCHEMA_HASH (${err.code || 'read failed'})`, {
        code: 'fixture_read_failed',
      });
    }
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'herdr-axi-doctor-'));
  const schemaPath = join(tmpDir, 'schema.json');
  try {
    try {
      execFileSync('herdr', ['api', 'schema', '--output', schemaPath], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const reason = err.code === 'ENOENT' ? 'herdr binary not found on PATH' : (err.message || 'herdr api schema failed');
      throw new HerdrAxiError(reason, {
        code: 'herdr_call_failed',
        help: ['Confirm `herdr` is installed and on PATH, or set HERDR_AXI_SCHEMA_HASH to a fixture file'],
      });
    }
    let bytes;
    try {
      bytes = readFileSync(schemaPath);
    } catch (err) {
      throw new HerdrAxiError(`cannot read the schema herdr wrote (${err.code || 'read failed'})`, {
        code: 'fixture_read_failed',
      });
    }
    return createHash('sha256').update(bytes).digest('hex');
  } finally {
    // Cleaned on both the success and the failure path; nothing else uses
    // this directory.
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Path to the committed VERSION.txt fixture, resolved relative to this module
// (mirrors the test's own fixture resolution) so doctor works from any cwd.
const VERSION_FIXTURE_PATH = fileURLToPath(new URL('../fixtures/VERSION.txt', import.meta.url));

// Reads the two-line VERSION.txt fixture: line1 version, line2 schema hash
// (Phase 0's recording). A missing/malformed fixture is a structured error
// (LIB-1), never a crash. HERDR_AXI_EXPECTED_VERSION_PATH overrides the path,
// so a test can point this at a malformed fixture without touching the
// committed one.
export function readExpectedVersion() {
  const path = process.env.HERDR_AXI_EXPECTED_VERSION_PATH || VERSION_FIXTURE_PATH;
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new HerdrAxiError(`cannot read the VERSION.txt fixture (${err.code || 'read failed'})`, {
      code: 'fixture_read_failed',
    });
  }
  const [version, hash] = text.split('\n');
  if (!version || !hash) {
    throw new HerdrAxiError('VERSION.txt fixture is malformed; expected two lines (version, hash)', {
      code: 'bad_fixture_shape',
    });
  }
  return { version: version.trim(), hash: hash.trim() };
}

// Pure comparison of the live {version, hash} against the fixture-recorded
// expected pair (LIB-1 pattern: testable without a live herdr session, like
// chooseDirection/detectAlternateScreen). Both fields must match: a schema
// change under an unchanged version string is still a mismatch.
export function compareVersion(actual, expected) {
  return {
    match: actual.version === expected.version && actual.hash === expected.hash,
    actualVersion: actual.version,
    expectedVersion: expected.version,
    actualHash: actual.hash,
    expectedHash: expected.hash,
  };
}

// renderDoctor(comparison, opts) -> TOON string. Pure: no I/O, so tests call
// it directly with a hand-built compareVersion() result, matching
// renderHome/renderRead/renderDispatch's pattern. `comparison` carries both
// the match flag and the actual/expected fields; `version` is the live
// version string shown on a match (equal to comparison.actualVersion, but
// passed explicitly since the match body is a summary, not a diff).
export function renderDoctor(comparison, { version } = {}) {
  if (comparison.match) {
    return serialize({
      version,
      status: 'match',
      help: ['herdr matches the fixture this tool was tested against'],
    });
  }
  return serialize({
    error: 'herdr no longer matches the fixture this tool was tested against',
    code: 'doctor_mismatch',
    actual_version: comparison.actualVersion,
    expected_version: comparison.expectedVersion,
    actual_hash: comparison.actualHash,
    expected_hash: comparison.expectedHash,
    help: ["Re-run Phase 0's measurement to re-record VERSION.txt against the updated herdr"],
  });
}
