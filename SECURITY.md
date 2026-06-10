# Security Policy

`up` is a demonstration of persistent Vercel Sandboxes. It is distributed **only** through the
`curl | sh` installer at `https://cdn.upcli.dev/install.sh` and is **not** published to npm.

## Scope and trust model

- Running `up .` syncs your working directory into a Vercel Sandbox and exposes its dev server at a
  **public, unauthenticated** `*.vercel.run` URL. Anyone with the link can reach that server while
  the sandbox is alive. Treat the URL as a secret and do not run `up` against production projects or
  real data.
- The CLI runs on your machine with your privileges and reuses your existing Vercel login. Commands
  read from a checked-in `up.config.json` are displayed and must be confirmed before they run for
  the first time on a machine.
- Running `up .` executes the project's own code in the sandbox: the detected install and dev
  commands (e.g. `npm run dev`, which runs `package.json` scripts) run there, in **your** Vercel
  account, with its resources and network access. The sandbox isolates that code from your machine,
  not from your account — treat `up .` like `npm install && npm run dev` and run it only on
  repositories you trust. Note the split: only the dev command receives an injected env file
  (`--env-file`/`.env.local`); the install step does not, so dependency install hooks never see
  those values.
- Files named `.env*`, obvious key material (`*.pem`, `*.key`, `.ssh/**`, `id_rsa*`, ...) and
  credential config (`.npmrc`, `.netrc`, `.pypirc`, `.yarnrc*`, `.direnv`) are excluded from sync.
  Exclusion is by **filename**, not by scanning file contents.

## Supported versions

Only the latest released version (the default in `install.sh`) is supported. Older `beta` artifacts
remain downloadable for reproducibility but do not receive fixes.

## Verifying a download

The installer checks the SHA-256 of `up.mjs` before installing. Since `up.mjs`, `checksums.txt`,
and `install.sh` are all served from `cdn.upcli.dev`, that check verifies integrity (it catches a
corrupted download), not origin; trust rests on TLS and Vercel's control of the domain.

For an independent check, compare the CDN bundle against the matching
[GitHub Release](https://github.com/vercel-labs/upcli/releases), which CI publishes under separate
infrastructure:

```sh
curl -fsSL https://cdn.upcli.dev/releases/<version>/up.mjs | shasum -a 256
# compare with checksums.txt in the GitHub Release for the same tag
```

`up` is a demo: do not run it against production projects or real data.

## Reporting a vulnerability

Please report suspected vulnerabilities privately instead of opening a public issue. Use Vercel's
security disclosure process at <https://vercel.com/security> (or email **security@vercel.com**) with
a description, reproduction steps, and impact. You will receive an acknowledgement and updates on
the resolution.
