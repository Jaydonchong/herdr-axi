// Tests for herdr-axi's home view (lib + CLI).
// Run: node --test 'tools/lib/*.test.mjs'
// (Node 22 treats a --test positional as a glob, not a directory to walk, so a
// bare `node --test tools/lib/` finds nothing.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  renderHome, binPath, renderRead, truncateBody, detectAlternateScreen,
  chooseDirection, renderDispatch, startAgentWhenReady, HerdrAxiError,
  firstMeaningfulLine, renderDoctor, renderPrompt,
} from './herdr.mjs';

const CLI = fileURLToPath(new URL('../herdr-axi', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../fixtures/snapshot.json', import.meta.url));
const GOLDEN = fileURLToPath(new URL('../fixtures/home.golden', import.meta.url));
const VERSION_FIXTURE = fileURLToPath(new URL('../fixtures/VERSION.txt', import.meta.url));

// Runs the CLI and always returns a result instead of throwing, so a test can
// assert on the exit code and the stdout payload together.
function cli(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// Wraps a raw SessionSnapshot in the envelope shape renderHome expects.
function envelope(snapshot) {
  return { id: 'cli:api:snapshot', result: { type: 'snapshot', snapshot } };
}

function baseSnapshot(overrides = {}) {
  return {
    version: '0.8.0',
    focused_pane_id: 'w1:p1',
    focused_workspace_id: 'w1',
    workspaces: [{ workspace_id: 'w1', label: 'alpha', tab_count: 1, pane_count: 1 }],
    panes: [{ pane_id: 'w1:p1', cwd: '~/repo-a' }],
    agents: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// renderHome against the fixture
// ---------------------------------------------------------------------------

test('renderHome against the fixture: identity block, tables, counts, attention, help', () => {
  const raw = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const text = renderHome(raw, { bin: '~/tools/herdr-axi' });

  assert.match(text, /^bin: ~\/tools\/herdr-axi$/m);
  assert.match(text, /^description: token-lean control surface over herdr 0\.8\.0$/m);
  assert.match(text, /^session: default$/m);
  assert.match(text, /^focused: "w6:p5"$/m);
  assert.match(text, /^cwd: ~\/repo-a$/m);
  assert.match(text, /^workspaces\[12\]\{id,label,tabs,panes\}:$/m);
  assert.match(text, /^agents\[18\]\{name,pane,kind,status,cwd\}:$/m);
  assert.match(text, /^counts: "18 of 18 agents, 18 panes, 12 workspaces"$/m);
  assert.match(text, /^attention\[1\]: agent-k is blocked at an approval or question dialog$/m);
  assert.match(text, /^help\[2\]:/m);
});

// ---------------------------------------------------------------------------
// Nameless-agent fallback
// ---------------------------------------------------------------------------

test('a nameless agent shows its pane_id in the name column', () => {
  const snapshot = baseSnapshot({
    agents: [
      { pane_id: 'w1:p2', agent: 'claude', agent_status: 'idle', cwd: '~/repo-a' },
    ],
  });
  const text = renderHome(envelope(snapshot));
  assert.match(text, /"w1:p2","w1:p2",claude,idle,~\/repo-a/);
});

test('a nameless blocked agent uses its pane_id in the attention line and appears in the table', () => {
  const snapshot = baseSnapshot({
    agents: [
      { pane_id: 'w1:p3', agent: 'claude', agent_status: 'blocked', cwd: '~/repo-a' },
    ],
  });
  const text = renderHome(envelope(snapshot));
  assert.match(text, /^attention\[1\]: "w1:p3 is blocked at an approval or question dialog"$/m);
  assert.match(text, /"w1:p3","w1:p3",claude,blocked,~\/repo-a/);
});

// ---------------------------------------------------------------------------
// Empty state: full collapse
// ---------------------------------------------------------------------------

test('an empty session prints only the two-line full collapse, all through serialize()', () => {
  const snapshot = baseSnapshot({ agents: [] });
  const text = renderHome(envelope(snapshot));
  assert.equal(text, [
    'agents: "no live agents in this session (1 workspaces, 1 panes scanned)"',
    'help[1]: "Run `herdr-axi dispatch <name> --kind claude --prompt \\"<text>\\"` to start one"',
  ].join('\n'));
});

// ---------------------------------------------------------------------------
// Missing snapshot.version
// ---------------------------------------------------------------------------

test('a missing snapshot.version omits the version suffix instead of printing "undefined"', () => {
  const snapshot = baseSnapshot({
    version: undefined,
    agents: [{ name: 'agent-a', pane_id: 'w1:p2', agent: 'claude', agent_status: 'idle', cwd: '~/repo-a' }],
  });
  const text = renderHome(envelope(snapshot));
  assert.match(text, /^description: token-lean control surface over herdr$/m);
  assert.doesNotMatch(text, /undefined/);
});

// ---------------------------------------------------------------------------
// All five AgentStatus values
// ---------------------------------------------------------------------------

test('all five AgentStatus values render in the status column', () => {
  const statuses = ['idle', 'working', 'blocked', 'done', 'unknown'];
  const snapshot = baseSnapshot({
    agents: statuses.map((status, i) => ({
      name: `agent-${status}`, pane_id: `w1:p${i}`, agent: 'claude', agent_status: status, cwd: '~/repo-a',
    })),
  });
  const text = renderHome(envelope(snapshot));
  for (const status of statuses) {
    assert.match(text, new RegExp(`agent-${status},"w1:p\\d",claude,${status},~/repo-a`));
  }
});

// ---------------------------------------------------------------------------
// binPath
// ---------------------------------------------------------------------------

test('binPath collapses the home-dir prefix to ~', () => {
  assert.equal(binPath('/Users/x/repo/tools/herdr-axi', '/Users/x'), '~/repo/tools/herdr-axi');
  // Outside the home dir, the path is left as is.
  assert.equal(binPath('/opt/tools/herdr-axi', '/Users/x'), '/opt/tools/herdr-axi');
  // Bare path equal to home collapses to "~" exactly.
  assert.equal(binPath('/Users/x', '/Users/x'), '~');
});

test('binPath does not collapse a sibling directory that merely starts with the home string', () => {
  // "/Users/x2/..." is not under "/Users/x"; a substring match would wrongly
  // produce "~2/...".
  assert.equal(binPath('/Users/x2/tools/herdr-axi', '/Users/x'), '/Users/x2/tools/herdr-axi');
});

// ---------------------------------------------------------------------------
// CLI integration
// ---------------------------------------------------------------------------

// Masks the bin: line's path so the golden comparison survives running from a
// different worktree (each phase gets its own worktree path).
function maskBinLine(text) {
  return text.replace(/^bin: .*$/m, 'bin: <masked>');
}

test('CLI: fixture snapshot matches the committed golden, exit 0, stderr empty', () => {
  const r = cli([], { HERDR_AXI_SNAPSHOT: FIXTURE });
  const golden = readFileSync(GOLDEN, 'utf8');
  assert.equal(r.status, 0);
  assert.equal(maskBinLine(r.stdout), maskBinLine(golden));
  assert.equal(r.stderr, '');
});

test('CLI: an unknown flag exits 2, error on stdout, stderr empty', () => {
  const r = cli(['--bogus'], { HERDR_AXI_SNAPSHOT: FIXTURE });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^error:/m);
  assert.match(r.stdout, /--bogus/);
  assert.equal(r.stderr, '');
});

test('CLI: --help exits 0 with help text on stdout', () => {
  const r = cli(['--help'], { HERDR_AXI_SNAPSHOT: FIXTURE });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /herdr-axi - token-lean control surface over herdr/);
});

test('CLI: --help wins over a trailing bogus token, exit 0 with help text', () => {
  const r = cli(['--help', '--bogus'], { HERDR_AXI_SNAPSHOT: FIXTURE });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /herdr-axi - token-lean control surface over herdr/);
});

// ---------------------------------------------------------------------------
// read <target>
// ---------------------------------------------------------------------------

// Wraps an agent in the envelope shape `agent get` returns: {id, result:{agent}}.
function agentGetEnvelope(agent) {
  return { id: 'cli:agent:get', result: { agent } };
}

function baseAgent(overrides = {}) {
  return {
    name: 'agent-a', pane_id: 'w1:p2', agent: 'claude', agent_status: 'idle', cwd: '~/repo-a',
    ...overrides,
  };
}

// Writes fixture text to a temp file and returns its path, so a test can
// inject text through an env seam without touching tools/fixtures/.
function tempFile(name, contents) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-axi-test-'));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

// Writes an executable shell script named "herdr" into a fresh dir and
// returns that dir, so a test can put it first on PATH to fake a live call
// without a real herdr session.
function fakeHerdrOnPath(script) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-axi-fake-herdr-'));
  const path = join(dir, 'herdr');
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return dir;
}

test('CLI: read on an unknown target surfaces herdr\'s real agent_not_found code and message', () => {
  const dir = fakeHerdrOnPath(
    'echo \'{"error":{"code":"agent_not_found","message":"agent target bogus not found"}}\' >&2\nexit 1',
  );
  const r = cli(['read', 'bogus'], { PATH: dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /agent target bogus not found/);
  assert.match(r.stdout, /code: agent_not_found/);
  assert.doesNotMatch(r.stdout, /target_not_found/);
});

test('CLI: a missing herdr binary is reported distinctly, never mislabeled "not found"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-axi-empty-path-'));
  const r = cli(['read', 'agent-a'], { PATH: dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /herdr binary not found on PATH/);
  assert.doesNotMatch(r.stdout, /target_not_found/);
});

test('CLI: an unrelated herdr failure keeps the generic herdr_call_failed code', () => {
  const dir = fakeHerdrOnPath('echo "boom" >&2\nexit 1');
  const r = cli(['read', 'agent-a'], { PATH: dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /code: herdr_call_failed/);
  assert.doesNotMatch(r.stdout, /target_not_found/);
});

test('truncateBody leaves short text untouched', () => {
  const result = truncateBody('short body', 1500);
  assert.deepEqual(result, { body: 'short body', truncated: false, totalLength: 10 });
});

test('truncateBody cuts to the limit and reports the full length', () => {
  const text = 'x'.repeat(2000);
  const result = truncateBody(text, 1500);
  assert.equal(result.body.length, 1500);
  assert.equal(result.truncated, true);
  assert.equal(result.totalLength, 2000);
});

test('detectAlternateScreen returns null for empty or near-empty buffers, not a false frozen alert', () => {
  assert.equal(detectAlternateScreen('', '', { requestedLines: 480 }), null);
  assert.equal(detectAlternateScreen('hello', 'hello', { requestedLines: 480 }), null);
});

test('detectAlternateScreen: a many-line byte-identical pair is still the frozen tell', () => {
  const frame = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const message = detectAlternateScreen(frame, frame, { requestedLines: 400 });
  assert.match(message, /frozen on an alternate-screen frame/);
});

test('detectAlternateScreen: a larger read that recovers more content is not alt-screen', () => {
  const primary = Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n');
  const larger = Array.from({ length: 392 }, (_, i) => `line ${i}`).join('\n');
  assert.equal(detectAlternateScreen(primary, larger, { requestedLines: 480 }), null);
});

test('truncateBody does not split a surrogate pair straddling the limit', () => {
  const text = `${'x'.repeat(1499)}\u{1F600}${'y'.repeat(10)}`; // pair spans indices 1499-1500
  const result = truncateBody(text, 1500);
  assert.equal(result.truncated, true);
  assert.equal(result.totalLength, text.length);
  assert.equal(result.body, 'x'.repeat(1499)); // backs off rather than splitting the pair
  const lastCode = result.body.charCodeAt(result.body.length - 1);
  assert.ok(lastCode < 0xD800 || lastCode > 0xDFFF, 'body must not end on a lone surrogate');
});

test('detectAlternateScreen: a short buffer padded to the requested lines is not alt-screen', () => {
  const real = Array.from({ length: 62 }, (_, i) => `line ${i}`).join('\n');
  const primary = real + '\n'.repeat(58); // padded to 120 lines
  const larger = real; // no padding needed once N exceeds the real buffer
  assert.equal(detectAlternateScreen(primary, larger, { requestedLines: 480 }), null);
});

test('detectAlternateScreen: near-identical output at a larger --lines is the alt-screen tell', () => {
  const frame = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const primary = frame;
  const larger = frame; // byte-identical regardless of --lines, per BASELINE.md scenario 3
  const message = detectAlternateScreen(primary, larger, { requestedLines: 400 });
  assert.match(message, /frozen on an alternate-screen frame/);
  assert.match(message, /--via-file/);
});

// bp-09 (live, herdr 0.8.0): a normal, non-frozen agent whose 480-line read
// returns fewer raw lines than its 120-line read, because herdr stops
// wrapping the buffer once --lines is large enough. This false-positived the
// pre-fix predicate (round 2), since the two tails differ by one trailing
// prompt glyph and an exact `.includes()` on the joined text failed.
test('detectAlternateScreen: bp-09 live pattern - larger read unwraps to fewer, longer lines - is not alt-screen', () => {
  const tail = Array.from({ length: 56 }, (_, i) => `bp-09 output line ${i}`);
  const primary = [
    ...Array.from({ length: 64 }, (_, i) => `bp-09 earlier scrollback ${i}`),
    ...tail,
  ].join('\n'); // 120 non-blank lines total
  const larger = [...tail, 'agent@bp-09 ~/repo $ ❯'].join('\n'); // 57 lines: same tail, plus a prompt line
  assert.equal(detectAlternateScreen(primary, larger, { requestedLines: 480 }), null);
});

test('detectAlternateScreen: genuinely frozen alt-screen never shrinks across --lines', () => {
  const frame = Array.from({ length: 45 }, (_, i) => `tier2-scout frame line ${i}`).join('\n');
  const message = detectAlternateScreen(frame, frame, { requestedLines: 480 });
  assert.match(message, /frozen on an alternate-screen frame/);
});

test('renderRead: identity block reused from projectAgent, source/lines/body, constant help line', () => {
  const text = renderRead(agentGetEnvelope(baseAgent()), 'hello pane', {
    source: 'recent-unwrapped', lines: 120,
  });
  assert.match(text, /^target: agent-a$/m);
  assert.match(text, /^pane: "w1:p2"$/m);
  assert.match(text, /^kind: claude$/m);
  assert.match(text, /^status: idle$/m);
  assert.match(text, /^cwd: ~\/repo-a$/m);
  assert.match(text, /^source: recent-unwrapped$/m);
  assert.match(text, /^lines: 120$/m);
  assert.match(text, /^body: hello pane$/m);
  assert.doesNotMatch(text, /^size:/m);
  assert.doesNotMatch(text, /^alt_screen:/m);
  assert.match(text, /^help\[1\]: Run `herdr-axi read agent-a --lines 240` to see more scrollback$/m);
});

test('renderRead: a truncated body prints size and suggests --full', () => {
  const text = renderRead(agentGetEnvelope(baseAgent()), 'x'.repeat(2000), {
    source: 'recent-unwrapped', lines: 120,
  });
  assert.match(text, /^size: 2000$/m);
  assert.match(text, /^help\[2\]:/m);
  assert.match(text, /--full/);
});

test('renderRead: an alternate screen states the condition and suggests --via-file', () => {
  const frame = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const text = renderRead(agentGetEnvelope(baseAgent()), frame, {
    source: 'recent-unwrapped', lines: 120, largerText: frame, largerLines: 480,
  });
  assert.match(text, /^alt_screen: pane appears frozen on an alternate-screen frame/m);
  // FIX B: the message must name the larger read's --lines (480), not the
  // primary read's (120), since 480 is the value the CLI actually tried.
  assert.match(text, /raising --lines to 480 recovered no more content/);
  assert.match(text, /--via-file/);
});

test('CLI: read merges agent get + agent read through env-seam fixtures', () => {
  const agentPath = tempFile('agent.json', JSON.stringify(agentGetEnvelope(baseAgent({ agent_status: 'working' }))));
  const readPath = tempFile('read.txt', 'agent output here');
  const largerPath = tempFile('read-larger.txt', 'agent output here\nline1\nline2\nline3'); // grows: not alt-screen
  const r = cli(['read', 'agent-a'], {
    HERDR_AXI_AGENT_GET: agentPath,
    HERDR_AXI_AGENT_READ: readPath,
    HERDR_AXI_AGENT_READ_LARGER: largerPath,
  });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^target: agent-a$/m);
  assert.match(r.stdout, /^status: working$/m);
  assert.match(r.stdout, /^body: agent output here$/m);
});

test('CLI: read on a frozen pane names the actual larger --lines tried, not the primary one', () => {
  const agentPath = tempFile('agent.json', JSON.stringify(agentGetEnvelope(baseAgent({ agent_status: 'working' }))));
  const frame = Array.from({ length: 40 }, (_, i) => `frozen line ${i}`).join('\n');
  const readPath = tempFile('read.txt', frame);
  const largerPath = tempFile('read-larger.txt', frame); // byte-identical: frozen alt-screen
  const r = cli(['read', 'agent-a', '--lines', '120'], {
    HERDR_AXI_AGENT_GET: agentPath,
    HERDR_AXI_AGENT_READ: readPath,
    HERDR_AXI_AGENT_READ_LARGER: largerPath,
  });
  assert.equal(r.status, 0);
  // LARGER_LINES_MULTIPLIER (4) makes the larger read --lines 480; the
  // message must name that value (FIX B), not the primary read's 120.
  assert.match(r.stdout, /raising --lines to 480 recovered no more content/);
});

test('CLI: read rejects an unknown flag, exit 2', () => {
  const r = cli(['read', 'agent-a', '--bogus'], {});
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^error:/m);
  assert.match(r.stdout, /--bogus/);
  assert.equal(r.stderr, '');
});

test('CLI: read rejects an invalid --source value by name, exit 2', () => {
  const r = cli(['read', 'agent-a', '--source', 'bogus'], {});
  assert.equal(r.status, 2);
  assert.match(r.stdout, /--source must be one of/);
});

test('CLI: read with no target is a usage error, exit 2', () => {
  const r = cli(['read'], {});
  assert.equal(r.status, 2);
  assert.match(r.stdout, /read requires a target/);
});

test('CLI: read --via-file on a blocked agent reports the block instead of mutating', () => {
  const agentPath = tempFile('agent.json', JSON.stringify(agentGetEnvelope(baseAgent({ agent_status: 'blocked' }))));
  const r = cli(['read', 'agent-a', '--via-file'], { HERDR_AXI_AGENT_GET: agentPath });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /blocked and cannot honor --via-file/);
  assert.match(r.stdout, /code: via_file_blocked/);
});

test('CLI: read --via-file recovers content through the HERDR_AXI_VIA_FILE fixture seam', () => {
  const agentPath = tempFile('agent.json', JSON.stringify(agentGetEnvelope(baseAgent())));
  const viaFilePath = tempFile('via-file.md', '# recovered content');
  const r = cli(['read', 'agent-a', '--via-file'], {
    HERDR_AXI_AGENT_GET: agentPath,
    HERDR_AXI_VIA_FILE: viaFilePath,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^body: "# recovered content"$/m);
});

// ---------------------------------------------------------------------------
// dispatch <name> --kind <k> --prompt <text>
// ---------------------------------------------------------------------------

// Wraps a pane_id in the envelope shape `pane split` returns: {id, result:{pane}}.
function splitEnvelope(paneId) {
  return { id: 'cli:pane:split', result: { pane: { pane_id: paneId } } };
}

// Wraps a settled status in the envelope shape `agent prompt` returns on any
// settle - idle, done, or blocked - exit 0 with the agent at .result.agent,
// the same nesting `agent get` uses (herdr 0.8.0, live-confirmed).
function promptEnvelope(status) {
  return { id: 'cli:agent:prompt', result: { agent: { agent: 'claude', agent_status: status, name: 'scout', pane_id: 'w1:p9' } } };
}

// Wraps a pane_id in the envelope shape `workspace create` returns:
// {id, result:{workspace, tab, root_pane}} (live-confirmed, herdr 0.8.0).
function workspaceCreateEnvelope(rootPaneId) {
  return { id: 'cli:workspace:create', result: { workspace: { workspace_id: 'w2' }, tab: { tab_id: 'w2:t1' }, root_pane: { pane_id: rootPaneId } } };
}

test('chooseDirection: a wide pane (live sample: 233 cols) picks right', () => {
  assert.equal(chooseDirection({ width: 233 }), 'right');
});

test('chooseDirection: a narrow pane picks down', () => {
  assert.equal(chooseDirection({ width: 80 }), 'down');
});

test('chooseDirection: the threshold itself is wide, one below it is narrow', () => {
  assert.equal(chooseDirection({ width: 160 }), 'right');
  assert.equal(chooseDirection({ width: 159 }), 'down');
});

// ---------------------------------------------------------------------------
// startAgentWhenReady: the pane-not-yet-a-shell retry (BLOCKER 1, live)
// ---------------------------------------------------------------------------

// A busy(err) throws agent_pane_busy; other stub sequencing lives on the
// test's own attempt/sleep/now instead of real delays or a live herdr.
const busyError = () => new HerdrAxiError('agent target pane <id> is not an available shell', { code: 'agent_pane_busy' });

test('startAgentWhenReady: busy, busy, ok - succeeds on the 3rd attempt, sleep called twice', () => {
  let calls = 0;
  const sleeps = [];
  const result = startAgentWhenReady({
    attempt: () => { calls += 1; if (calls < 3) throw busyError(); return 'started'; },
    sleep: (ms) => sleeps.push(ms),
    now: () => 0,
  });
  assert.equal(result, 'started');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [500, 500]);
});

test('startAgentWhenReady: still busy past the deadline throws the agent_pane_busy error', () => {
  let clock = 0;
  assert.throws(() => {
    startAgentWhenReady({
      attempt: () => { throw busyError(); },
      sleep: () => { clock += 1000; },
      now: () => clock,
      timeoutMs: 3000,
      pollMs: 1000,
    });
  }, (err) => err instanceof HerdrAxiError && err.code === 'agent_pane_busy');
});

test('startAgentWhenReady: a non-busy code on the first attempt rethrows immediately, sleep never called', () => {
  let sleepCalls = 0;
  assert.throws(() => {
    startAgentWhenReady({
      attempt: () => { throw new HerdrAxiError('pane did not reach an interactive prompt', { code: 'agent_not_ready' }); },
      sleep: () => { sleepCalls += 1; },
      now: () => 0,
    });
  }, (err) => err instanceof HerdrAxiError && err.code === 'agent_not_ready');
  assert.equal(sleepCalls, 0);
});

// ---------------------------------------------------------------------------
// firstMeaningfulLine
// ---------------------------------------------------------------------------

test('firstMeaningfulLine: a real approval dialog (herdr 0.8.0, live) skips its separator chrome', () => {
  const dialog = [
    '──────────────────────────────────────────────────────────────',
    ' ☐ Choice',
    '',
    'Which do you choose?',
    '',
    '❯ 1. Option A',
    '     Choose option A.',
    '↓ 2. Option B',
    '     Choose option B.',
    '──────────────────────────────────────────────────────────────',
    '  4. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
  assert.equal(firstMeaningfulLine(dialog), '☐ Choice');
});

test('firstMeaningfulLine: a leading separator with no other chrome falls through to the first lettered line', () => {
  const text = '──────\nAllow file edit? (y/n)\nmore pane text';
  assert.equal(firstMeaningfulLine(text), 'Allow file edit? (y/n)');
});

test('firstMeaningfulLine: all-blank or all-separator input returns null', () => {
  assert.equal(firstMeaningfulLine('   \n\n   '), null);
  assert.equal(firstMeaningfulLine('──────\n──────\n──'), null);
});

test('firstMeaningfulLine: a normal first line with text is returned trimmed', () => {
  assert.equal(firstMeaningfulLine('  hello pane  \nnext line'), 'hello pane');
});

test('renderDispatch: a settled idle agent reports name, pane, kind, direction, status', () => {
  const text = renderDispatch('w1:p9', promptEnvelope('idle'), {
    name: 'scout', kind: 'claude', direction: 'right', wait: true,
  });
  assert.match(text, /^name: scout$/m);
  assert.match(text, /^pane: "w1:p9"$/m);
  assert.match(text, /^kind: claude$/m);
  assert.match(text, /^direction: right$/m);
  assert.match(text, /^status: idle$/m);
  assert.match(text, /^help\[1\]: Run `herdr-axi read scout` for the full pane content$/m);
});

test('renderDispatch: a settled done agent reports status: done', () => {
  const text = renderDispatch('w1:p9', promptEnvelope('done'), {
    name: 'scout', kind: 'claude', direction: 'right', wait: true,
  });
  assert.match(text, /^status: done$/m);
});

test('renderDispatch: a blocked settle surfaces status and waiting_on as top-level headline fields', () => {
  const text = renderDispatch('w1:p9', promptEnvelope('blocked'), {
    name: 'scout', kind: 'claude', direction: 'right', wait: true, waitingOn: 'Allow file edit? (y/n)',
  });
  assert.match(text, /^status: blocked$/m);
  assert.match(text, /^waiting_on: Allow file edit\? \(y\/n\)$/m);
  assert.match(text, /^help\[1\]: Run `herdr-axi read scout` for the full dialog$/m);
});

test('renderDispatch: a blocked settle with no waitingOn (pane read failed) still headlines status:blocked', () => {
  const text = renderDispatch('w1:p9', promptEnvelope('blocked'), {
    name: 'scout', kind: 'claude', direction: 'right', wait: true, waitingOn: null,
  });
  assert.match(text, /^status: blocked$/m);
  assert.doesNotMatch(text, /^waiting_on:/m);
  assert.match(text, /^help\[1\]: Run `herdr-axi read scout` to see what scout is waiting on$/m);
});

test('renderDispatch: --no-wait reports the send without a settled status', () => {
  const text = renderDispatch('w1:p9', null, {
    name: 'scout', kind: 'claude', direction: 'down', wait: false,
  });
  assert.match(text, /^status: "sent, not waited for"$/m);
  assert.match(text, /^help\[1\]: Run `herdr-axi read scout` to check on scout$/m);
});

test('renderDispatch: dispatch-workspace has no direction to report', () => {
  const text = renderDispatch('w1:p9', promptEnvelope('idle'), {
    name: 'scout', kind: 'claude', direction: null, wait: true,
  });
  assert.match(text, /^name: scout$/m);
  assert.match(text, /^pane: "w1:p9"$/m);
  assert.doesNotMatch(text, /^direction:/m);
});

test('CLI: dispatch with --direction explicit skips the layout call and reports the new agent', () => {
  const splitPath = tempFile('split.json', JSON.stringify(splitEnvelope('w1:p9')));
  const startPath = tempFile('start.json', JSON.stringify({ id: 'cli:agent:start', result: { agent: { name: 'scout' } } }));
  const promptPath = tempFile('prompt.json', JSON.stringify(promptEnvelope('done')));
  const r = cli(['dispatch', 'scout', '--kind', 'claude', '--prompt', 'hello', '--direction', 'right'], {
    HERDR_AXI_PANE_SPLIT: splitPath,
    HERDR_AXI_AGENT_START: startPath,
    HERDR_AXI_AGENT_PROMPT: promptPath,
  });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^name: scout$/m);
  assert.match(r.stdout, /^pane: "w1:p9"$/m);
  assert.match(r.stdout, /^status: done$/m);
});

test('CLI: dispatch surfaces herdr\'s real agent_not_ready code as the headline, not under help[]', () => {
  const splitPath = tempFile('split.json', JSON.stringify(splitEnvelope('w1:p9')));
  const dir = fakeHerdrOnPath(
    'echo \'{"error":{"code":"agent_not_ready","message":"pane did not reach an interactive prompt"}}\' >&2\nexit 1',
  );
  const r = cli(['dispatch', 'scout', '--kind', 'claude', '--prompt', 'hello', '--direction', 'right'], {
    PATH: dir, HERDR_AXI_PANE_SPLIT: splitPath,
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^error: pane did not reach an interactive prompt$/m);
  assert.match(r.stdout, /^code: agent_not_ready$/m);
});

// BLOCKER 2 (live): execFileSync inherited herdr's stderr to ours, so a failed
// herdr call's raw {"error":...} JSON printed to our stderr alongside the
// clean TOON error on stdout, violating the AXI contract (stderr is progress
// only). This is the test that would have caught it.
test('CLI: dispatch on a failed herdr call keeps our stderr empty, error only on stdout', () => {
  const dir = fakeHerdrOnPath(
    'echo \'{"error":{"code":"agent_not_ready","message":"pane did not reach an interactive prompt"}}\' >&2\nexit 1',
  );
  const r = cli(['dispatch', 'scout', '--kind', 'claude', '--prompt', 'hello', '--direction', 'right'], { PATH: dir });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^code: agent_not_ready$/m);
  assert.doesNotMatch(r.stdout, /\{"error":/); // the fake herdr's raw JSON, never printed verbatim
});

// A blocked settle is exit 0 (herdr 0.8.0, live-confirmed): `agent prompt
// --wait` returns .result.agent.agent_status === 'blocked' the same way a
// nonzero exit never happens here, unlike agent_prompt_stalled below.
test('CLI: dispatch on a blocked settle reports status:blocked and waiting_on as the headline, exit 0', () => {
  const splitPath = tempFile('split.json', JSON.stringify(splitEnvelope('w1:p9')));
  const startPath = tempFile('start.json', JSON.stringify({ id: 'cli:agent:start', result: { agent: { name: 'scout' } } }));
  const promptPath = tempFile('prompt.json', JSON.stringify({
    id: 'cli:agent:prompt',
    result: { agent: { agent: 'claude', agent_status: 'blocked', name: 'scout', pane_id: 'w1:p9' } },
  }));
  // Separator line first, per the real dialog shape (herdr 0.8.0, live):
  // waiting_on must be the first MEANINGFUL line, not this chrome.
  const readPath = tempFile('read.txt', '──────────────────────────────────────────────────────────────\nAllow file edit? (y/n)\nmore pane text');
  const r = cli(['dispatch', 'scout', '--kind', 'claude', '--prompt', 'hello', '--direction', 'right'], {
    HERDR_AXI_PANE_SPLIT: splitPath, HERDR_AXI_AGENT_START: startPath,
    HERDR_AXI_AGENT_PROMPT: promptPath, HERDR_AXI_AGENT_READ: readPath,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^status: blocked$/m);
  assert.match(r.stdout, /^waiting_on: Allow file edit\? \(y\/n\)$/m);
});

test('CLI: dispatch on a blocked settle whose follow-up pane read fails still headlines status:blocked', () => {
  const splitPath = tempFile('split.json', JSON.stringify(splitEnvelope('w1:p9')));
  const startPath = tempFile('start.json', JSON.stringify({ id: 'cli:agent:start', result: { agent: { name: 'scout' } } }));
  const promptPath = tempFile('prompt.json', JSON.stringify({
    id: 'cli:agent:prompt',
    result: { agent: { agent: 'claude', agent_status: 'blocked', name: 'scout', pane_id: 'w1:p9' } },
  }));
  // No HERDR_AXI_AGENT_READ fixture and no herdr on PATH: the pane read throws.
  const dir = mkdtempSync(join(tmpdir(), 'herdr-axi-empty-path-'));
  const r = cli(['dispatch', 'scout', '--kind', 'claude', '--prompt', 'hello', '--direction', 'right'], {
    PATH: dir, HERDR_AXI_PANE_SPLIT: splitPath, HERDR_AXI_AGENT_START: startPath, HERDR_AXI_AGENT_PROMPT: promptPath,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^status: blocked$/m);
  assert.doesNotMatch(r.stdout, /^waiting_on:/m);
  // BLOCKER 2 (live): readAgentPane's execFileSync used to inherit stderr; a
  // failed blocked-path read (agent_not_idle, in the wild) leaked raw JSON here.
  assert.equal(r.stderr, '');
});

// BLOCKER 1 (live): a blocked agent's alternate-screen history cannot be
// scrolled to, so 'recent-unwrapped' deterministically fails agent_not_idle.
// This fakes that live failure and only lets 'visible' succeed, proving
// dispatch's blocked branch requests the pane with --source visible.
test('CLI: dispatch reads the blocked pane with --source visible, not recent-unwrapped (agent_not_idle, live)', () => {
  const splitPath = tempFile('split.json', JSON.stringify(splitEnvelope('w1:p9')));
  const startPath = tempFile('start.json', JSON.stringify({ id: 'cli:agent:start', result: { agent: { name: 'scout' } } }));
  const promptPath = tempFile('prompt.json', JSON.stringify({
    id: 'cli:agent:prompt',
    result: { agent: { agent: 'claude', agent_status: 'blocked', name: 'scout', pane_id: 'w1:p9' } },
  }));
  const dir = fakeHerdrOnPath([
    'if [ "$1" = "agent" ] && [ "$2" = "read" ]; then',
    '  if [ "$5" = "visible" ]; then',
    // Leading separator, per the real dialog shape (herdr 0.8.0, live).
    '    printf -- "──────\\nYou prefer option A.\\n"',
    '  else',
    '    echo \'{"error":{"code":"agent_not_idle","message":"cannot read 40 lines while scout is blocked"}}\' >&2',
    '    exit 1',
    '  fi',
    'fi',
  ].join('\n'));
  const r = cli(['dispatch', 'scout', '--kind', 'claude', '--prompt', 'hello', '--direction', 'right'], {
    PATH: dir, HERDR_AXI_PANE_SPLIT: splitPath, HERDR_AXI_AGENT_START: startPath, HERDR_AXI_AGENT_PROMPT: promptPath,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^status: blocked$/m);
  // waiting_on skips the separator chrome line, landing on the real content.
  assert.match(r.stdout, /^waiting_on: You prefer option A\.$/m);
  assert.equal(r.stderr, '');
});

test('CLI: dispatch surfaces herdr\'s real agent_prompt_stalled code, with name+pane so the caller can find the half-started agent', () => {
  const splitPath = tempFile('split.json', JSON.stringify(splitEnvelope('w1:p9')));
  const startPath = tempFile('start.json', JSON.stringify({ id: 'cli:agent:start', result: { agent: { name: 'scout' } } }));
  const dir = fakeHerdrOnPath(
    'echo \'{"error":{"code":"agent_prompt_stalled","message":"no state change observed within 5000ms"}}\' >&2\nexit 1',
  );
  const r = cli(['dispatch', 'scout', '--kind', 'claude', '--prompt', 'hello', '--direction', 'right'], {
    PATH: dir, HERDR_AXI_PANE_SPLIT: splitPath, HERDR_AXI_AGENT_START: startPath,
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^code: agent_prompt_stalled$/m);
  assert.match(r.stdout, /^name: scout$/m);
  assert.match(r.stdout, /^pane: "w1:p9"$/m);
});

test('CLI: dispatch --no-wait skips the settle wait', () => {
  const splitPath = tempFile('split.json', JSON.stringify(splitEnvelope('w1:p9')));
  const startPath = tempFile('start.json', JSON.stringify({ id: 'cli:agent:start', result: { agent: { name: 'scout' } } }));
  const promptPath = tempFile('prompt.json', JSON.stringify({ id: 'cli:agent:prompt', result: {} }));
  const r = cli(['dispatch', 'scout', '--kind', 'claude', '--prompt', 'hello', '--direction', 'right', '--no-wait'], {
    HERDR_AXI_PANE_SPLIT: splitPath, HERDR_AXI_AGENT_START: startPath, HERDR_AXI_AGENT_PROMPT: promptPath,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^status: "sent, not waited for"$/m);
});

test('CLI: dispatch requires --kind, exit 2', () => {
  const r = cli(['dispatch', 'scout', '--prompt', 'hello'], {});
  assert.equal(r.status, 2);
  assert.match(r.stdout, /dispatch requires --kind/);
});

test('CLI: dispatch requires --prompt, exit 2', () => {
  const r = cli(['dispatch', 'scout', '--kind', 'claude'], {});
  assert.equal(r.status, 2);
  assert.match(r.stdout, /dispatch requires --prompt/);
});

// RCH-1/RCH-2: dispatch's name positional declares no freeform slot, so a
// "--"-prefixed token there must still be rejected exactly as before FIX 1.
test('CLI: dispatch rejects a name starting with "--" as unknown_flag, exit 2', () => {
  const r = cli(['dispatch', '--not-a-name', '--kind', 'claude', '--prompt', 'hello'], {});
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^error: unknown flag --not-a-name$/m);
});

test('CLI: dispatch rejects an unknown flag, exit 2', () => {
  const r = cli(['dispatch', 'scout', '--kind', 'claude', '--prompt', 'hello', '--bogus'], {});
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^error:/m);
  assert.match(r.stdout, /--bogus/);
});

test('CLI: dispatch rejects an invalid --direction value by name, exit 2', () => {
  const r = cli(['dispatch', 'scout', '--kind', 'claude', '--prompt', 'hello', '--direction', 'sideways'], {});
  assert.equal(r.status, 2);
  assert.match(r.stdout, /--direction must be one of/);
});

test('CLI: dispatch with no --direction and no HERDR_PANE_ID reports missing_pane_id, exit 1', () => {
  const r = cli(['dispatch', 'scout', '--kind', 'claude', '--prompt', 'hello'], { HERDR_PANE_ID: '' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^code: missing_pane_id$/m);
});

test('CLI: dispatch --help exits 0 with help text on stdout', () => {
  const r = cli(['dispatch', '--help'], {});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /herdr-axi dispatch <name> --kind <k> --prompt/);
});

// --prompt is freeform: it carries arbitrary text that may legitimately start
// with "--" ("--fix the login bug"), unlike --kind/--cwd/--direction.
test('CLI: dispatch --prompt starting with "--" is preserved literally, not rejected as missing_flag_value', () => {
  const splitPath = tempFile('split.json', JSON.stringify(splitEnvelope('w1:p9')));
  const startPath = tempFile('start.json', JSON.stringify({ id: 'cli:agent:start', result: { agent: { name: 'scout' } } }));
  const logPath = tempFile('prompt-log.txt', '');
  const dir = fakeHerdrOnPath([
    'if [ "$1" = "agent" ] && [ "$2" = "prompt" ]; then',
    `  printf '%s' "$4" > "${logPath}"`,
    "  echo '{\"id\":\"cli:agent:prompt\",\"result\":{}}'",
    '  exit 0',
    'fi',
  ].join('\n'));
  const r = cli(['dispatch', 'scout', '--kind', 'claude', '--prompt', '--fix the login bug', '--direction', 'right', '--no-wait'], {
    PATH: dir, HERDR_AXI_PANE_SPLIT: splitPath, HERDR_AXI_AGENT_START: startPath,
  });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^status: "sent, not waited for"$/m);
  assert.equal(readFileSync(logPath, 'utf8'), '--fix the login bug');
});

test('CLI: dispatch --prompt as the truly last token is still missing_flag_value, exit 2', () => {
  const r = cli(['dispatch', 'scout', '--kind', 'claude', '--prompt'], {});
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^code: missing_flag_value$/m);
  assert.match(r.stdout, /--prompt needs a value/);
});

// ---------------------------------------------------------------------------
// dispatch-workspace <name> --kind <k> --prompt <text>
// ---------------------------------------------------------------------------

test('CLI: dispatch-workspace creates a workspace and reports the new agent', () => {
  const workspacePath = tempFile('workspace.json', JSON.stringify(workspaceCreateEnvelope('w2:p1')));
  const startPath = tempFile('start.json', JSON.stringify({ id: 'cli:agent:start', result: { agent: { name: 'scout' } } }));
  const promptPath = tempFile('prompt.json', JSON.stringify({
    id: 'cli:agent:prompt',
    result: { agent: { agent: 'claude', agent_status: 'done', name: 'scout', pane_id: 'w2:p1' } },
  }));
  const r = cli(['dispatch-workspace', 'scout', '--kind', 'claude', '--prompt', 'hello'], {
    HERDR_AXI_WORKSPACE_CREATE: workspacePath,
    HERDR_AXI_AGENT_START: startPath,
    HERDR_AXI_AGENT_PROMPT: promptPath,
  });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^name: scout$/m);
  assert.match(r.stdout, /^pane: "w2:p1"$/m);
  assert.match(r.stdout, /^status: done$/m);
  assert.doesNotMatch(r.stdout, /^direction:/m);
});

// TEST-3: prove the flag is rejected by trying it, not by asserting it is
// absent from DISPATCH_WORKSPACE_FLAGS - parseFlags's own unknown-flag path
// (herdr-axi:196-201) must refuse it with no special-casing in this command.
test('CLI: dispatch-workspace rejects --direction as an unknown flag, exit 2', () => {
  const r = cli(['dispatch-workspace', 'scout', '--kind', 'claude', '--prompt', 'hello', '--direction', 'right'], {});
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^error: unknown flag --direction$/m);
});

test('CLI: dispatch-workspace requires --kind, exit 2', () => {
  const r = cli(['dispatch-workspace', 'scout', '--prompt', 'hello'], {});
  assert.equal(r.status, 2);
  assert.match(r.stdout, /dispatch-workspace requires --kind/);
});

test('CLI: dispatch-workspace requires --prompt, exit 2', () => {
  const r = cli(['dispatch-workspace', 'scout', '--kind', 'claude'], {});
  assert.equal(r.status, 2);
  assert.match(r.stdout, /dispatch-workspace requires --prompt/);
});

test('CLI: dispatch-workspace on a blocked settle reports status:blocked and waiting_on as the headline, exit 0', () => {
  const workspacePath = tempFile('workspace.json', JSON.stringify(workspaceCreateEnvelope('w2:p1')));
  const startPath = tempFile('start.json', JSON.stringify({ id: 'cli:agent:start', result: { agent: { name: 'scout' } } }));
  const promptPath = tempFile('prompt.json', JSON.stringify({
    id: 'cli:agent:prompt',
    result: { agent: { agent: 'claude', agent_status: 'blocked', name: 'scout', pane_id: 'w2:p1' } },
  }));
  const readPath = tempFile('read.txt', '──────────────────────────────────────────────────────────────\nAllow file edit? (y/n)\nmore pane text');
  const r = cli(['dispatch-workspace', 'scout', '--kind', 'claude', '--prompt', 'hello'], {
    HERDR_AXI_WORKSPACE_CREATE: workspacePath, HERDR_AXI_AGENT_START: startPath,
    HERDR_AXI_AGENT_PROMPT: promptPath, HERDR_AXI_AGENT_READ: readPath,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^status: blocked$/m);
  assert.match(r.stdout, /^waiting_on: Allow file edit\? \(y\/n\)$/m);
});

test('CLI: dispatch-workspace --help exits 0 with help text on stdout', () => {
  const r = cli(['dispatch-workspace', '--help'], {});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /herdr-axi dispatch-workspace <name> --kind <k> --prompt/);
});

// ---------------------------------------------------------------------------
// prompt <target> "<text>"
// ---------------------------------------------------------------------------

test('renderPrompt: no --wait reports the send without a settled status', () => {
  const text = renderPrompt('scout', null, { wait: false });
  assert.match(text, /^target: scout$/m);
  assert.match(text, /^status: "sent, not waited for"$/m);
  assert.match(text, /^help\[1\]: Run `herdr-axi read scout` to check on scout$/m);
});

test('renderPrompt: a waited idle settle reports name, target, status, no pane/kind/direction', () => {
  const text = renderPrompt('scout', promptEnvelope('idle'), { wait: true });
  assert.match(text, /^target: scout$/m);
  assert.match(text, /^status: idle$/m);
  assert.doesNotMatch(text, /^pane:/m);
  assert.doesNotMatch(text, /^kind:/m);
  assert.doesNotMatch(text, /^direction:/m);
  assert.match(text, /^help\[1\]: Run `herdr-axi read scout` for the full pane content$/m);
});

test('renderPrompt: a waited blocked settle surfaces status and waiting_on as top-level headline fields', () => {
  const text = renderPrompt('scout', promptEnvelope('blocked'), { wait: true, waitingOn: 'Allow file edit? (y/n)' });
  assert.match(text, /^status: blocked$/m);
  assert.match(text, /^waiting_on: Allow file edit\? \(y\/n\)$/m);
  assert.match(text, /^help\[1\]: Run `herdr-axi read scout` for the full dialog$/m);
});

test('renderPrompt: a waited blocked settle with no waitingOn (pane read failed) still headlines status:blocked', () => {
  const text = renderPrompt('scout', promptEnvelope('blocked'), { wait: true, waitingOn: null });
  assert.match(text, /^status: blocked$/m);
  assert.doesNotMatch(text, /^waiting_on:/m);
  assert.match(text, /^help\[1\]: Run `herdr-axi read scout` to see what scout is waiting on$/m);
});

test('CLI: prompt with no --wait reports the send without a settled status', () => {
  const promptPath = tempFile('prompt.json', JSON.stringify({ id: 'cli:agent:prompt', result: {} }));
  const r = cli(['prompt', 'x', 'hi'], { HERDR_AXI_AGENT_PROMPT: promptPath });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^target: x$/m);
  assert.match(r.stdout, /^status: "sent, not waited for"$/m);
});

test('CLI: prompt --wait on an idle settle reports the settled status', () => {
  const promptPath = tempFile('prompt.json', JSON.stringify(promptEnvelope('idle')));
  const r = cli(['prompt', 'x', 'hi', '--wait'], { HERDR_AXI_AGENT_PROMPT: promptPath });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^target: x$/m);
  assert.match(r.stdout, /^status: idle$/m);
});

test('CLI: prompt --wait on a blocked settle reports status:blocked and waiting_on as the headline', () => {
  const promptPath = tempFile('prompt.json', JSON.stringify({
    id: 'cli:agent:prompt',
    result: { agent: { agent: 'claude', agent_status: 'blocked', name: 'x', pane_id: 'w1:p9' } },
  }));
  const readPath = tempFile('read.txt', '──────────────────────────────────────────────────────────────\nAllow file edit? (y/n)\nmore pane text');
  const r = cli(['prompt', 'x', 'hi', '--wait'], {
    HERDR_AXI_AGENT_PROMPT: promptPath, HERDR_AXI_AGENT_READ: readPath,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^status: blocked$/m);
  assert.match(r.stdout, /^waiting_on: Allow file edit\? \(y\/n\)$/m);
});

// text is freeform: a follow-up prompt commonly starts with "--" ("--fix the
// bug"), unlike dispatch's --prompt-flag case (line 805) - here it is a bare
// positional, so parseFlags must accept it as the text slot, not reject it.
test('CLI: prompt text starting with "--" is accepted and forwarded, not rejected as unknown_flag', () => {
  const logPath = tempFile('prompt-log.txt', '');
  const dir = fakeHerdrOnPath([
    'if [ "$1" = "agent" ] && [ "$2" = "prompt" ]; then',
    `  printf '%s' "$4" > "${logPath}"`,
    "  echo '{\"id\":\"cli:agent:prompt\",\"result\":{}}'",
    '  exit 0',
    'fi',
  ].join('\n'));
  const r = cli(['prompt', 'x', '--fix the bug'], { PATH: dir });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^target: x$/m);
  assert.equal(readFileSync(logPath, 'utf8'), '--fix the bug');
});

// RCH-1: prompt's target positional stays non-freeform (only text is), so a
// target starting with "--" still errors, same as before this fix.
test('CLI: prompt rejects a target starting with "--" as unknown_flag, exit 2', () => {
  const r = cli(['prompt', '--not-a-target', 'hi'], {});
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^error: unknown flag --not-a-target$/m);
});

test('CLI: prompt with no target is a usage error, exit 2', () => {
  const r = cli(['prompt'], {});
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^code: missing_target$/m);
  assert.match(r.stdout, /prompt requires a target/);
});

test('CLI: prompt with no text is a usage error, exit 2', () => {
  const r = cli(['prompt', 'x'], {});
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^code: missing_text$/m);
  assert.match(r.stdout, /prompt requires text/);
});

test('CLI: prompt --help exits 0 with help text on stdout', () => {
  const r = cli(['prompt', '--help'], {});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /herdr-axi prompt <target> "<text>"/);
});

test('CLI: prompt rejects an unknown flag, exit 2', () => {
  const r = cli(['prompt', 'x', 'hi', '--bogus'], {});
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^error: unknown flag --bogus$/m);
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

const [EXPECTED_VERSION, EXPECTED_HASH] = readFileSync(VERSION_FIXTURE, 'utf8').split('\n');

test('renderDoctor: a match reports version, status, help', () => {
  const text = renderDoctor(
    { match: true, actualVersion: 'herdr 0.8.0', expectedVersion: 'herdr 0.8.0', actualHash: 'abc123', expectedHash: 'abc123' },
    { version: 'herdr 0.8.0' },
  );
  assert.equal(text, [
    'version: herdr 0.8.0',
    'status: match',
    'help[1]: herdr matches the fixture this tool was tested against',
  ].join('\n'));
});

test('renderDoctor: a mismatch reports actual/expected version+hash and the mismatch code', () => {
  const text = renderDoctor(
    { match: false, actualVersion: 'herdr 9.9.9', expectedVersion: 'herdr 0.8.0', actualHash: 'abc123', expectedHash: 'def456' },
    { version: 'herdr 9.9.9' },
  );
  assert.equal(text, [
    'error: herdr no longer matches the fixture this tool was tested against',
    'code: doctor_mismatch',
    'actual_version: herdr 9.9.9',
    'expected_version: herdr 0.8.0',
    'actual_hash: abc123',
    'expected_hash: def456',
    "help[1]: Re-run Phase 0's measurement to re-record VERSION.txt against the updated herdr",
  ].join('\n'));
});

test('CLI: doctor on a matching version+hash reports status:match, exit 0', () => {
  const versionPath = tempFile('version.txt', `${EXPECTED_VERSION}\n`);
  const hashPath = tempFile('hash.txt', `${EXPECTED_HASH}\n`);
  const r = cli(['doctor'], { HERDR_AXI_VERSION: versionPath, HERDR_AXI_SCHEMA_HASH: hashPath });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^status: match$/m);
});

test('CLI: doctor on a mismatched version reports both actual and expected, exit 1', () => {
  const versionPath = tempFile('version.txt', 'herdr 9.9.9\n');
  const hashPath = tempFile('hash.txt', `${EXPECTED_HASH}\n`);
  const r = cli(['doctor'], { HERDR_AXI_VERSION: versionPath, HERDR_AXI_SCHEMA_HASH: hashPath });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^code: doctor_mismatch$/m);
  assert.match(r.stdout, /^actual_version: herdr 9\.9\.9$/m);
  assert.match(r.stdout, new RegExp(`^expected_version: ${EXPECTED_VERSION}$`, 'm'));
  assert.match(r.stdout, new RegExp(`^actual_hash: ${EXPECTED_HASH}$`, 'm'));
  assert.match(r.stdout, new RegExp(`^expected_hash: ${EXPECTED_HASH}$`, 'm'));
});

// readExpectedVersion() (herdr.mjs) rejects a one-line/malformed fixture with
// code: bad_fixture_shape, message "VERSION.txt fixture is malformed;
// expected two lines (version, hash)". Confirmed by reading the function.
test('CLI: doctor on a malformed VERSION.txt fixture surfaces a clean structured error, not a crash', () => {
  const versionPath = tempFile('version.txt', `${EXPECTED_VERSION}\n`);
  const hashPath = tempFile('hash.txt', `${EXPECTED_HASH}\n`);
  const badExpectedPath = tempFile('bad-version.txt', `${EXPECTED_VERSION}\n`); // one line only, no hash
  const r = cli(['doctor'], {
    HERDR_AXI_VERSION: versionPath,
    HERDR_AXI_SCHEMA_HASH: hashPath,
    HERDR_AXI_EXPECTED_VERSION_PATH: badExpectedPath,
  });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^code: bad_fixture_shape$/m);
  assert.match(r.stdout, /VERSION\.txt fixture is malformed; expected two lines \(version, hash\)/);
});

// ---------------------------------------------------------------------------
// Table-driven: every error class the uniform error contract must cover,
// each asserted on BOTH the exit status and the output channel (stdout body,
// empty stderr) - the "no command writes to stderr" contract, non-negotiable.
// ---------------------------------------------------------------------------

// A fake herdr that reports one {code, message} error on stderr, exit 1, for
// any subcommand - reused by every real-herdr-code case below (DRY-10).
function fakeHerdrError(code, message) {
  return fakeHerdrOnPath(`echo '{"error":{"code":"${code}","message":"${message}"}}' >&2\nexit 1`);
}

const CASES = [
  {
    name: 'home: unknown flag, exit 2',
    args: ['--bogus'], env: { HERDR_AXI_SNAPSHOT: FIXTURE },
    status: 2, stdout: [/^error: unknown flag --bogus$/m],
  },
  {
    name: 'read: unknown flag, exit 2',
    args: ['read', 'agent-a', '--bogus'], env: {},
    status: 2, stdout: [/^error: unknown flag --bogus$/m],
  },
  {
    name: 'dispatch: unknown flag, exit 2',
    args: ['dispatch', 'scout', '--kind', 'claude', '--prompt', 'hi', '--bogus'], env: {},
    status: 2, stdout: [/^error: unknown flag --bogus$/m],
  },
  {
    name: 'dispatch-workspace: unknown flag, exit 2',
    args: ['dispatch-workspace', 'scout', '--kind', 'claude', '--prompt', 'hi', '--bogus'], env: {},
    status: 2, stdout: [/^error: unknown flag --bogus$/m],
  },
  {
    name: 'dispatch-workspace: missing required --kind, exit 2',
    args: ['dispatch-workspace', 'scout', '--prompt', 'hi'], env: {},
    status: 2, stdout: [/^code: missing_kind$/m],
  },
  {
    name: 'read: --pane hints at the bare positional, not herdr\'s own flag spelling',
    args: ['read', '--pane', 'w1:p1'], env: {},
    status: 2, stdout: [/not --pane/, /Valid flags: --source/],
  },
  {
    name: 'dispatch: --cwd as the last token is a missing_flag_value, not a silent shift',
    args: ['dispatch', 'scout', '--kind', 'claude', '--prompt', 'hi', '--cwd'], env: {},
    status: 2, stdout: [/^code: missing_flag_value$/m, /--cwd needs a value/],
  },
  {
    name: 'dispatch: --kind swallowing --prompt\'s value is a missing_flag_value (the arg-shift defect)',
    args: ['dispatch', 'scout', '--kind', '--prompt', 'hi', '--direction', 'right'], env: {},
    status: 2, stdout: [/^code: missing_flag_value$/m, /--kind needs a value/],
  },
  {
    name: 'read: bad --source enum value, exit 2',
    args: ['read', 'agent-a', '--source', 'bogus'], env: {},
    status: 2, stdout: [/^code: bad_source$/m],
  },
  {
    name: 'dispatch: bad --direction enum value, exit 2',
    args: ['dispatch', 'scout', '--kind', 'claude', '--prompt', 'hi', '--direction', 'sideways'], env: {},
    status: 2, stdout: [/^code: bad_direction$/m],
  },
  {
    name: 'read: missing required target, exit 2',
    args: ['read'], env: {},
    status: 2, stdout: [/^code: missing_target$/m],
  },
  {
    name: 'dispatch: missing required --kind, exit 2',
    args: ['dispatch', 'scout', '--prompt', 'hi'], env: {},
    status: 2, stdout: [/^code: missing_kind$/m],
  },
  {
    name: 'herdr code agent_not_found translates with its own help[]',
    args: ['read', 'agent-x'],
    fakeHerdr: () => fakeHerdrError('agent_not_found', 'agent target agent-x not found'),
    status: 1, stdout: [/^code: agent_not_found$/m, /home view/],
  },
  {
    name: 'herdr code agent_not_ready translates with its own help[]',
    args: ['read', 'agent-x'],
    fakeHerdr: () => fakeHerdrError('agent_not_ready', 'pane did not reach an interactive prompt'),
    status: 1, stdout: [/^code: agent_not_ready$/m, /shell prompt/],
  },
  {
    name: 'herdr code agent_pane_busy translates with its own help[]',
    args: ['read', 'agent-x'],
    fakeHerdr: () => fakeHerdrError('agent_pane_busy', 'agent target agent-x is not an available shell'),
    status: 1, stdout: [/^code: agent_pane_busy$/m, /shell prompt/],
  },
  {
    name: 'herdr code agent_prompt_stalled translates with its own help[]',
    args: ['read', 'agent-x'],
    fakeHerdr: () => fakeHerdrError('agent_prompt_stalled', 'no state change observed within 5000ms'),
    status: 1, stdout: [/^code: agent_prompt_stalled$/m, /did not respond/],
  },
  {
    name: 'herdr code timeout translates with its own help[]',
    args: ['read', 'agent-x'],
    fakeHerdr: () => fakeHerdrError('timeout', 'no matching state observed within the timeout'),
    status: 1, stdout: [/^code: timeout$/m, /did not respond/],
  },
  {
    name: 'herdr code agent_not_idle translates with its own help[]',
    args: ['read', 'agent-x'],
    fakeHerdr: () => fakeHerdrError('agent_not_idle', 'cannot read while agent-x is blocked'),
    status: 1, stdout: [/^code: agent_not_idle$/m, /busy or blocked/],
  },
  {
    name: 'herdr code agent_blocked translates with its own help[] even though never observed live',
    args: ['read', 'agent-x'],
    fakeHerdr: () => fakeHerdrError('agent_blocked', 'agent-x is blocked'),
    status: 1, stdout: [/^code: agent_blocked$/m, /is blocked/],
  },
  {
    name: 'an unrecognized herdr code still translates, with the generic help[] fallback',
    args: ['read', 'agent-x'],
    fakeHerdr: () => fakeHerdrError('agent_renamed_someday', 'a future herdr error this tool has never seen'),
    status: 1, stdout: [/^code: agent_renamed_someday$/m, /current state/],
  },
  {
    name: 'success/no-op: the fixture home view, exit 0',
    args: [], env: { HERDR_AXI_SNAPSHOT: FIXTURE },
    status: 0, stdout: [/^description: token-lean control surface over herdr/m],
  },
];

for (const c of CASES) {
  test(`CLI table-driven: ${c.name}`, () => {
    const env = c.fakeHerdr ? { PATH: c.fakeHerdr() } : c.env;
    const r = cli(c.args, env);
    assert.equal(r.status, c.status);
    for (const pattern of c.stdout) assert.match(r.stdout, pattern);
    assert.equal(r.stderr, ''); // the "no command writes to stderr" contract
  });
}
