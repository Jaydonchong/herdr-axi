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

Node.js and npm are required. This package has no npm dependencies, so you can run the
executable directly from the repo without an install:

```bash
./herdr-axi --help
```

To run `herdr-axi` from any directory, link this checkout into npm's global command directory:

```bash
cd /path/to/herdr-axi
npm link
cd /path/to/another-directory
herdr-axi --help
```

`npm link` creates a global package symlink to this checkout and a command symlink for the
`bin` entry in `package.json`. Edits to this checkout take effect through the links without
reinstalling. The command belongs to the active Node/npm installation; if you switch Node
versions with `nvm`, run `npm link` again. Use `command -v herdr-axi` to check which executable
your shell finds. `npm link` does not publish the package to the npm registry. You do not need
`npm link herdr-axi` in another project unless that project needs this package as a dependency.

### Why this repo is an npm CLI package

A Git repo is not automatically an npm package. This repo's `package.json` gives npm the package
name (`herdr-axi`) and version, and maps the `herdr-axi` command to `./herdr-axi` through its
`bin` field. The target file exists, is executable, and starts with `#!/usr/bin/env node`.
The `scripts.test` field defines `npm test`. A CLI package does not need a `main` field or
dependencies, and local linking does not require publication. The name and version become
required if you publish the package.

Live use requires `herdr` on `PATH` and a running `herdr` server. Run `herdr` in one terminal,
then `herdr-axi` in another. Run `herdr-axi doctor` to compare the installed `herdr` version
and API schema against the version this CLI was tested with. Tests run entirely against fixtures
and need no live `herdr` session.

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
