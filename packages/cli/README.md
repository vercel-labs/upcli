# up

`up` is an experimental demo of persistent Vercel Sandboxes; we recommend trying it on experimental
workloads, not production data. Run a local working directory in a persistent Vercel Sandbox and
receive a public live development URL:

```sh
npm install -g up
cd ~/projects/my-app
up .
```

Requires Node.js `>=20.19.0`. Releases are published exclusively by CI from
[vercel-labs/upcli](https://github.com/vercel-labs/upcli) using npm trusted publishing, so every
version carries provenance. Installation needs no login. `up` reuses your existing Vercel CLI
login (or a `VERCEL_TOKEN`); if the machine is not logged in, it tells you to run `vercel login`
first. Run `up .` from a project directory; the CLI refuses the home directory and filesystem
root.

The `up` command supports Node projects automatically and supports Python or custom servers
through `--command` or `up.config.json`. Projects declaring Bun, pnpm, Yarn, or a fixed npm
version provision that package-manager runtime remotely in the Sandbox; lockfile-only Bun, pnpm
and Yarn projects use tested fixed fallbacks, so those tools are not required locally. Static
folders and obvious Django projects use port `8080` automatically. The public supervisor remains on
port `3000` and proxies HTTP and WebSocket traffic.

Checked-in `up.config.json` commands are executable inside the sandbox. The CLI shows those
commands and stores local trust only after confirmation; changed commands and switching between a
run with and without `--env-file` or `--include-sensitive-config` require confirmation again.

Files named `.env*` are never uploaded because Sandbox snapshots persist. Use `--env-file
.env.local` to read a local dotenv file and inject its values into the app process only; the file
itself is not uploaded or persisted. When `.env.local` exists, `up .` prompts once to enable that
same behavior automatically for that local project and remembers the decision in local state only.
`up` does not scan other files for secrets. On `Ctrl-C`, the CLI detaches and leaves the sandbox
and its public URL running. Run `up stop` to stop the sandbox and save a snapshot. A later
`up .` reconnects instantly if the sandbox is still running, or restores from the snapshot.

By default, `up` also omits credential-bearing config such as `.npmrc`, `.yarnrc*`, `.netrc`,
`.pypirc` and `.direnv/**`. Use `--include-sensitive-config` only when the remote install needs
those files; they can persist in the sandbox snapshot, and this explicit opt-in overrides
`.gitignore` for those matching config files. Obvious key material such as `.ssh/**`,
`.aws/**`, `.gnupg/**`, `*.pem`, `*.key`, `id_rsa*` and `id_ed25519*` is never uploaded, even with
that flag.

See the repository README for launch profile configuration and development instructions.
