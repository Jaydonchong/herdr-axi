I have 2 ways to control Herdr (a terminal multiplexer for coding agents): the raw /herdr skill,
and /herdr-axi, a CLI wrapper optimized for agent use. I want to benchmark the two against each
other. Facilitate the benchmark and return a report.

PRE-FLIGHT (do this before anything else):
1. Confirm HERDR_ENV=1 and that both `herdr` and `herdr-axi` are on PATH.
2. Confirm both the /herdr and /herdr-axi skills resolve to stable, merged code - not an
   in-progress branch or worktree. Check what each skill's file symlinks to (or where it's
   installed from) and whether that source is on the main/default branch with no pending
   uncommitted changes. If /herdr-axi (or either skill) points at an unmerged branch, flag it
   and ask how to proceed before running anything - testing against a moving target invalidates
   the results.

SETUP: For each test, run herdr and herdr-axi as two separate "candidates": identical task
prompt, only the required skill differs. Use {{MODEL}} at {{EFFORT}} effort for every candidate.
Each test's own workspace is named TEST-<test-name>; each candidate gets its OWN workspace named
TEST-<test-name> (herdr) / TEST-<test-name>-axi (herdr-axi). All of a candidate's own subagents
live as separate PANES inside that one workspace, not scattered across other workspaces. If a
skill's dispatch-style commands can't place a second/third agent into an already-created
workspace, falling back to the other skill's raw calls for just that gap is fine - note it, don't
avoid it.

TEST 1 - Research Test
Ask each candidate to create its own workspace, spawn 2 panes inside it, and have both
independently research {{RESEARCH_TOPIC}} (e.g. a concept in a codebase you have access to, a
well-documented open-source project, or any topic answerable via web search) using
{{RESEARCH_METHOD}} (e.g. "explore the codebase at <path>" or "use web search"). Confirm the two
panes' findings agree. Leave the workspace and panes open when done - do not close them. After
verifying the candidate left it open, close it yourself.

TEST 2 - Synthesizer Test
Ask each candidate to create its own workspace with 3 panes: two analysts, each given a
different source to analyze ({{DOC_A}} and {{DOC_B}} - e.g. two README files, two docs pages, two
sections of a spec), each producing a ~300 word report on what it does and its structure back to
the candidate; and a synthesizer, which the candidate must point at the two analyst panes BY NAME
(not by re-reading the sources itself) to compile a combined report. Skip verifying the content
itself - this test is only about whether the candidate can read pane content and route correctly.

TEST 3 - Router Test
Before running any candidate, create ONE shared workspace named TEST-router with 2 panes: an
"x_engineer" agent primed with a technical framing of a fake product (e.g. "this is an agentic,
event-driven todolist for high-speed collaboration"), and an "x_product_manager" agent primed with
a vaguer framing of the same fake product (e.g. "we're a todolist app that uses AI"). Then, for
each candidate in turn, ask it to locate the TEST-router workspace and the x_engineer pane
specifically (not the product manager), and ask it exactly: "What is the product you are working
on?" - expect the technical answer, not the marketing one. Run the two candidates SEQUENTIALLY,
not in parallel, since they share the same target workspace and concurrent access would skew the
timing metric.

METRICS to report per test, per candidate:
1. Time to spawn workspaces/panes
2. Time to get information back (read)
3. Total token usage (ask each candidate to self-report; note if the harness exposes no
   equivalent to a /cost command, and fall back to whatever token/tool-call tracking your
   orchestration layer provides)
4. Time to start on task
5. Task completion - correct number of workspaces/panes spawned, management instructions
   followed (leave open/close), content read effectively
6. Whether subagents/panes spawn correctly, and whether any candidate had to fall back outside
   its assigned skill (and why)

Return a comparison report: a table per test plus an overall verdict, and call out anything that
looks like a tooling limitation or bug in either skill (not just "candidate was slow").

What to fill in before running:
- {{MODEL}} / {{EFFORT}} — e.g. a fast/cheap model at low reasoning effort, so the benchmark measures tool overhead rather than model latency.
- {{RESEARCH_TOPIC}} / {{RESEARCH_METHOD}} — pick something the receiving agent can actually verify agreement on: a local codebase they have access to, or a well-documented public topic if they'd rather use web search.
- {{DOC_A}} / {{DOC_B}} — any two documents of comparable length and different subject matter; they don't need to relate to each other.

The Router Test needed no repo-specific change — it was already a fake, self-contained scenario, so it carried over unchanged.