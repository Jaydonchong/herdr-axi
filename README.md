# herdr-axi

A token-lean **Agent Experience Interface (AXI)** over the `herdr` binary: a small Node CLI that emits stdout-**TOON** and collapses the discovery and dispatch rituals an agent would otherwise pay for in raw `herdr` calls.

- **Discovery:** 5 calls -> **1** (`home`).
- **Agent rows:** 22 fields -> **5** (field projection to what an agent acts on).
- **Dispatch:** a 4-call ritual -> **1** (`dispatch <name> --kind <k> --prompt <text>`).

## Commands

- `herdr-axi` (bare) - the `home` view: workspaces, panes, agents, counts, and an attention line.
- `herdr-axi read <target>` - merges `herdr agent get` (status) and `herdr agent read` (pane text) into one document.
- `herdr-axi dispatch <name> --kind <k> --prompt <text>` - splits a pane, starts an agent, and prompts it in one call.
- `herdr-axi doctor` - checks the installed `herdr` version and API schema hash against what this tool was built against.

Run `herdr-axi --help` for the full flag reference.

## Why

Raw `herdr` output is priced in the token budget of the agent driving it. `herdr-axi` sits in
front of it and applies the [AXI](https://axi.md/) design principles: token-efficient output,
minimal default schemas, field projection to what an agent actually acts on, structured errors
and exit codes, and contextual disclosure of next steps. The single largest saving measured
against `herdr`'s shapes came from field projection, not from the wire format (TOON vs. compact
JSON) - see `fixtures/BASELINE.md` for the measurement.

## Installing

```bash
npm install
chmod +x herdr-axi
```

Requires `herdr` on `PATH` for live use. Tests run entirely against fixtures and need no live
`herdr` session.

## Testing

```bash
node --test lib/*.test.mjs
```

## Credits

Built on the [AXI (Agent eXperience Interface)](https://axi.md/) design principles by
[Kun Chen](https://github.com/kunchenguid) ([kunchenguid/axi](https://github.com/kunchenguid/axi)).
`herdr-axi` is an independent implementation of those principles for the `herdr` CLI; it is not
part of the AXI project itself.

`lib/toon.mjs` is a vendored TOON serializer, carried over unmodified from its originating
project.
