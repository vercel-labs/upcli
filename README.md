# up

`up .` runs your local project in a persistent Vercel Sandbox and gives you a public
`*.vercel.run` URL. Edit locally and changes sync up; stop it and a later `up .` resumes from a
snapshot. It is an experimental demo of
[persistent Vercel Sandboxes](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes),
distributed as the [`up`](https://www.npmjs.com/package/up) package on npm.

> **Experimental.** Try `up` on experimental workloads, not production projects or real data. The
> `*.vercel.run` URL is **public and unauthenticated**: anyone with the link can reach your dev
> server while the sandbox is alive. Secrets are excluded by **filename**, not by content, so a
> secret hardcoded in source or in a non-`.env*` file is uploaded. See [SECURITY.md](SECURITY.md).

## Install

```sh
npm install -g up
cd ~/projects/my-app
up .
```

Requires Node.js `>=20.19.0`. Releases are published to npm exclusively by this repository's CI
using [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), so every version
carries provenance; installing needs no login. To run, `up` reuses your Vercel CLI login (or
`VERCEL_TOKEN`) and must run inside a project, not your home directory. (Versions up to
`0.1.0-beta.5` were distributed via a `curl | sh` installer; those artifacts remain available
but are frozen.)

## Usage

```sh
up .                        # sync, install, run; prints the public URL
up . --open                 # also open the URL in your browser
up . --port 8080            # override the dev server port
up . --command '<cmd>'      # set the start command ($PORT is provided)
up . --env-file .env.local  # inject a local dotenv into the app process only
up . --save-config          # write the resolved setup to up.config.json
up stop                     # stop the sandbox and save a snapshot
up ls                       # list your sandboxes
```

`up` auto-detects most frameworks (Next, Vite, Astro, SvelteKit, ...) and the package manager
(npm, pnpm, Yarn, Bun, provisioned in the sandbox). Python and custom apps take a command once via
`--command` or a checked-in `up.config.json`, which `up` shows and asks you to trust before running.

## Sync and persistence

- One-way sync from your project directory. `.env*`, key material (`.ssh`, `*.pem`, `id_rsa*`, ...),
  credential config (`.npmrc`, `.netrc`, ...), VCS metadata and build outputs are never uploaded
  (credential config can be opted in with `--include-sensitive-config`). Exclusion is by filename,
  not content, and files over 20 MB are skipped.
- `Ctrl-C` detaches and leaves the sandbox running. `up stop` snapshots it; a later `up .`
  reconnects if it is still up, or restores from the snapshot. Sandbox names are stable per local
  install and project path.

## Development

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

The landing page lives in `landing/` and the installer host in `apps/downloads/` (served at
`cdn.upcli.dev`).
