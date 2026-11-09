I have 2 ways to control Herdr (a terminal multiplexer for coding agents): the raw /herdr skill,
and /herdr-axi, a CLI wrapper optimized for agent use. I want to benchmark the two against each
other. Facilitate the benchmark and return a report.

This is the codebase variant of the general benchmark (see benchmark.prompt.md in this same
folder) with the parameters already filled in for a local repository.
Revision 3, updated 2026-09-12 from the findings of the 2026-09-12 run.
Everything in NOISE CONTROLS below exists because it went wrong in a previous run.
Do not drop one of those controls because it looks like ceremony.

PRE-FLIGHT (do this before anything else):
1. Confirm HERDR_ENV=1 and that both `herdr` and `herdr-axi` are on PATH.
2. Confirm both the /herdr and /herdr-axi skills resolve to stable, merged code - not an
   in-progress branch or worktree. Check what each skill's file symlinks to (or where it's
   installed from) and whether that source is on the main/default branch with no pending
   uncommitted changes. Check the same for the `herdr-axi` CLI's own repository, which is
   installed separately from the skill and can be on a different branch.
3. Run `herdr-axi doctor` and record the result. A version mismatch invalidates the run.
4. Record the `herdr` version and both skills' commit hashes in the report. If anything points at
   an unmerged branch, flag it and ask how to proceed before running anything - testing against a
   moving target invalidates the results.

HARNESS - how to run one candidate:
A candidate is a real Claude Code session running in its own Herdr pane, not a subagent of the
facilitator.
A subagent cannot run `/cost` on itself and cannot be given a reasoning effort, so it cannot
produce the numbers this benchmark needs.

1. Create a fresh workspace `BENCH-<run-id>` whose cwd is an empty directory unique to that run,
   for example `<scratch>/runs/<run-id>/`.
   The unique cwd is what makes the candidate's transcript separable later.
2. Start the candidate in that workspace's root pane with
   `herdr agent start cand_<run-id> --kind claude --pane <pane> -- --model claude-sonnet-5 --effort low`.
   Pass no permission flag. The machine's existing `auto` permission mode handles approvals
   without a modal dialog.
3. Wait at least 15 seconds after `agent start` returns before sending the prompt, then confirm
   the prompt actually landed. See NOISE CONTROL 3.
4. Send the task prompt with `herdr agent prompt`, then wait on the candidate's own `end`
   timing mark rather than on the prompt call's return value.

Give every candidate the same five timing marks, written by a tiny script the candidate calls,
so the timestamps land outside the candidate's own context and cannot be estimated after the fact:

  mark.sh <run-id> start          first action, before anything else
  mark.sh <run-id> first_control  immediately before the first Herdr control command
  mark.sh <run-id> spawned        immediately after the required workspace and panes exist
                                  (for the Router Test, name this mark `located` instead)
  mark.sh <run-id> read_done      immediately after all required information is in hand
  mark.sh <run-id> end            last action, after the candidate's report file is written

Have every candidate write its report to a file rather than into its pane.
Reading a long report back out of a Claude Code TUI pane hits the alternate-screen limit; a file
does not.
Require these sections: RESULT, IDS, COMMANDS (every shell command in order), FALLBACK, FRICTION.

NOISE CONTROLS - each one fixes a specific failure from a previous run:

1. Give each candidate its own agent names.
   Herdr agent names are a single global namespace, not scoped per workspace.
   In the 2026-09-12 run both candidates were told to name their panes `explorer1` and
   `explorer2`; the candidate that ran second failed with `agent_name_taken` because the first
   candidate's panes were still open, and spent most of its spawn phase recovering.
   Whichever candidate runs second is penalised, which is a property of the schedule, not of the
   skill.
   Fix: write the pane names into each candidate's prompt with a per-candidate suffix, exactly as
   the workspace label already is - `explorer1` / `explorer1_axi`, and so on.
   The two prompts stay identical except for the skill name, the workspace label, and this suffix.

2. Ground the Router Test fixtures in a real file, not a roleplay primer.
   A primer that asks an agent to answer from an unverifiable in-conversation context is refused
   as a prompt-injection attempt, and the refusal is the answer the candidate then reads.
   Fix: write each fixture's framing to a `BRIEF.md` on disk, start that fixture agent with the
   brief's directory as its cwd, and prime it with "read BRIEF.md and answer questions from it".
   Confirm each fixture answers correctly before running any candidate against it.

3. Confirm every prompt actually landed.
   `herdr agent prompt` can return `agent_prompt_stalled` while the text lands seconds later, and
   can also accept a prompt the agent never sees at all.
   Both happened in the 2026-09-12 run, and one candidate silently sat idle for nine minutes.
   Fix: after sending, poll until either the agent reports `working` or the candidate's `start`
   mark appears. Re-send if neither happens within about a minute, and record the re-send.

4. Never start a candidate or fixture with `--permission-mode bypassPermissions`.
   `herdr agent start` reports `idle` and `interactive_ready` while an acceptance dialog owns the
   pane, and the next prompt's Enter answers that dialog instead. In the 2026-09-12 run this
   selected "No, exit" and killed two fixture agents.
   The trust-this-folder dialog on a brand-new directory does the same thing.
   Fix: use the machine's existing permission mode, and after starting any agent in a directory
   used for the first time, read the pane once and clear a dialog if one is there.

5. Run every candidate sequentially, not only the Router Test pair.
   Timing numbers are only comparable if the machine is under the same load for all of them.

6. Separate the candidate's tokens from its sub-agents' tokens.
   `herdr-axi dispatch` defaults a new agent's cwd to the caller's, so sub-agents write their
   transcripts into the candidate's own project directory and inflate its total.
   Fix: when summing from transcripts, keep only the transcript containing the benchmark prompt's
   own marker text, and cut the sum at the candidate's `end` mark.

7. Stop the clock at `read_done`, not `end`.
   Composing the report file took 16 to 19 seconds in the 2026-09-12 run and is instrumentation,
   not task work. Report `end` separately if it is wanted at all.

8. Treat the harness's own foreground timeout as data, not as candidate slowness.
   A blocking Herdr call longer than about 120 seconds is killed and backgrounded by the Claude
   Code Bash tool, and its return value is lost.
   One candidate lost 241 seconds to this across two calls.
   Record it as a harness boundary in the report; do not score it as the skill being slow.

SETUP: For each test, run herdr and herdr-axi as two separate candidates: identical task prompt,
differing only in the required skill, the workspace label, and the agent-name suffix from NOISE
CONTROL 1. Use claude-sonnet-5 at low reasoning effort for every candidate. Each candidate gets
its OWN workspace named TEST-<test-name> (herdr) / TEST-<test-name>-axi (herdr-axi). All of a
candidate's own subagents live as separate PANES inside that one workspace, not scattered across
other workspaces. If a skill's dispatch-style commands cannot place a second or third agent into
an already-created workspace, falling back to the other skill's raw calls for just that gap is
fine - note it, do not avoid it.

TEST 1 - Read Test
Ask each candidate to create its own workspace (TEST-read / TEST-read-axi), spawn 2 panes inside
it named explorer1 and explorer2 (suffixed per NOISE CONTROL 1), and have both independently
explore the codebase at <repo-path> to find all use cases of the "holiday
calendar" concept (models, usecases, GraphQL surface, migrations, tests - whatever they find).
Both panes must have their working directory set to that repository.
Confirm the two panes' findings agree with each other, with no contradictions. Leave the
workspace and panes open when done - do not close them. After verifying the candidate left it
open, close it yourself.

TEST 2 - Synthesizer Test
Ask each candidate to create its own workspace (TEST-synth / TEST-synth-axi) with 3 panes: two
analysts, each given a different source to analyze -
  Analyst A: ~/jaygents/skills/batch-fleet/SKILL.md
  Analyst B: ~/jaygents/guides/skill-authoring/GUIDE.md
each producing a ~300 word report on what it does and its structure back to the candidate; and a
synthesizer, which the candidate must point at the two analyst panes BY NAME (not by re-reading
the source files itself) to compile a combined report. Skip verifying the content itself - this
test is only about whether the candidate can read pane content and route correctly.

TEST 3 - Router Test
Before running any candidate, create ONE shared workspace named TEST-router with 2 panes: an
"x_engineer" agent and an "x_product_manager" agent, each grounded in its own BRIEF.md per NOISE
CONTROL 2. The engineer's brief carries a technical framing of a fake product (an agentic,
event-driven todolist for high-speed collaboration, with a CRDT-backed store and per-user agent
workers); the product manager's brief carries a vaguer framing of the same fake product ("we're a
todolist app that uses AI"). Verify both fixtures answer in character before proceeding. Then,
for each candidate in turn, ask it to locate the TEST-router workspace and the x_engineer pane
specifically (not the product manager), and ask it exactly: "What is the product you are working
on?" - expect the technical answer, not the marketing one. Run the two candidates SEQUENTIALLY,
since they share the same target workspace.

METRICS to report per test, per candidate.
Each metric names how to measure it, so two runs of this benchmark produce comparable numbers.

1. Time to start on task.
   `first_control` minus `start`.
   This is skill-loading plus whatever ceremony the skill mandates before its first real command.

2. Time to spawn workspaces and panes.
   `spawned` minus `first_control`.
   Not comparable between the two skills on its own: `herdr-axi dispatch` bundles split, start,
   prompt and settle-wait into one call, so a sub-agent's entire first turn lands in this phase,
   while the raw `herdr` candidate's equivalent work lands in the next one.
   Report both phases, but treat the total as the comparable figure and say so in the report.

3. Time to get information back.
   `read_done` minus `spawned`.
   Carries the same caveat as metric 2.

4. Total task time.
   `read_done` minus `start`. This is the primary time figure.

5. Total token usage.
   Sum `input_tokens`, `output_tokens`, `cache_creation_input_tokens` and
   `cache_read_input_tokens` from the candidate's own Claude Code transcript under
   `~/.claude/projects/<slugified-cwd>/`, filtered and cut per NOISE CONTROL 6.
   Report the full total and the output-token subtotal separately; the full total is dominated by
   cache reads and moves with context size, while output tokens track what the candidate actually
   produced.
   Do not ask the candidate to self-report. It cannot run `/cost` on itself.

6. Calls to task.
   Count of Herdr control commands between `first_control` and `read_done`, taken from the
   candidate's COMMANDS section and verified against its transcript.
   Count the skill's own commands only; exclude the benchmark's `mark.sh` calls.
   This is the metric the wrapper is designed to move, and it is far less noisy than wall clock:
   at low effort each tool call costs roughly 1.5 seconds of Bash round trip plus 2.2 seconds of
   model gap regardless of what the command does.

7. Recovery cost.
   Wall-clock seconds and call count spent recovering from an error, reported separately from the
   happy path, with the triggering error named.
   Without this, a single collision or retry hides inside a normal-looking spawn number.

8. Instruction-fidelity defects.
   A count, not a yes or no, with each defect named. Count: wrong number of workspaces or panes,
   orphaned workspaces or panes left behind, management instruction missed (leave open, close,
   do not create), timing marks emitted out of order, and anything done outside the stated scope.
   Verify against a live `herdr-axi` home view after the candidate finishes, not against the
   candidate's own claim.

9. Fallback outside the assigned skill.
   Count of calls made with the other skill, each with the reason. Zero is the expected value; a
   non-zero count names a capability gap and belongs in the tooling-findings section.

10. Task correctness.
    Did the candidate produce the substantive answer the task asked for - the two explorers
    agreeing, the synthesizer routing by pane name rather than re-reading the sources, the
    technical answer rather than the marketing one.

Return a comparison report: a table per test plus an overall verdict.
Call out separately anything that looks like a tooling limitation or a bug in either skill, in
the `herdr` binary, or at the boundary between Herdr and the Claude Code harness. A finding needs
the evidence that produced it - the command, the timing, and the output.
Do not report a candidate being slow as a tooling finding.

Prerequisites this variant assumes are available on the machine running it:
- A git checkout of a target monorepo at <repo-path> (or update the paths above if it lives
  elsewhere).
- A jaygents checkout at ~/jaygents with the batch-fleet skill and skill-authoring guide present
  at the paths above (or substitute any two documents of comparable length for Analyst A/B if
  unavailable).

If either prerequisite is missing, fall back to the generic benchmark.prompt.md in this folder and
fill in its {{RESEARCH_TOPIC}}/{{RESEARCH_METHOD}}/{{DOC_A}}/{{DOC_B}} placeholders with whatever
is available locally instead.

Clean up when you are done: close every workspace the benchmark created, including the candidates'
own BENCH workspaces and the shared TEST-router fixture, and confirm the session is back to the
workspace list it started with.
