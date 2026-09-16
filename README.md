# agent-witness

[![Build Status](https://github.com/evanpurkhiser/agent-witness/actions/workflows/build.yml/badge.svg)](https://github.com/evanpurkhiser/agent-witness/actions/workflows/build.yml)

A remote SSH agent that lets autonomous agents securely authenticate using
keys that never leave your devices.

The SSH private keys stay encrypted on your phone, unlocked with a WebAuthn
passkey. A local daemon exposes an `SSH_AUTH_SOCK`, and when something needs to
sign, it wakes your phone with a push notification to authorize the request.

> [!WARNING]
> Early work in progress.

## Development

Run the app and an isolated development daemon:

```console
pnpm dev
```

The daemon listens on `127.0.0.1:19345`, while Vite listens on
`127.0.0.1:5173`. Use an HTTPS reverse proxy to open the Vite server on the
phone, add it to the Home Screen, and launch it from there.

Development pairing state and the VAPID key persist in the ignored `.dev`
directory. Press Ctrl-C to stop both processes.

## Production build

Install the pinned toolchain and JavaScript dependencies, then build the
frontend and release server in the required order:

```console
mise install
pnpm install --frozen-lockfile
pnpm build:production
```

The resulting `target/release/agent-witness` binary contains the complete Vite
application and does not need `packages/app/dist` at runtime. Production
deployments should terminate TLS in front of its HTTP listener.

## Sentry

Configure separate Sentry projects for the daemon and browser application. The
server embeds the public frontend DSN in the HTML response at runtime, so the
frontend build contains no environment-specific configuration:

```toml
sentry_backend_dsn = "https://public@example.ingest.sentry.io/1"
sentry_frontend_dsn = "https://public@example.ingest.sentry.io/2"
```

Both SDKs send errors, structured logs, and traces when their DSN is configured.
Tracing uses a `1.0` sample rate.

## Pairing state

Pairing remains process-local when `state_path` is omitted. Configure a state
file to retain the server identity and paired client across restarts:

```toml
state_path = "/var/lib/agent-witness/state.json"
control_socket = "/run/agent-witness/control.sock"
control_socket_mode = "0600"
```

The state file is atomically replaced with mode `0600` and contains only the
client credential hash. Clear the current pairing through the running daemon:

```console
agent-witness pairing clear
```

## Systemd

The Arch package installs `agent-witness.service`. Configure the daemon in
`/etc/agent-witness.toml`, then enable and start the service. Systemd manages
`/run/agent-witness` and `/var/lib/agent-witness` with root-only access.

To retain pairing across restarts, configure:

```toml
state_path = "/var/lib/agent-witness/state.json"
```

Use a systemd drop-in to grant a local group access to the runtime directory,
and set `socket_mode` in the daemon configuration for access to the agent socket.

## Versioning

The Cargo workspace version is shared by the server and both JavaScript package
manifests. To bump it, run the Bump workflow on `main` with a semantic
version:

```console
gh workflow run bump.yml --ref main -f version=0.2.0
```

The workflow requires passing lint, tests, and Docker build checks for its base
commit. It updates the manifests and Cargo lockfile, then pushes a release commit
and matching `vX.Y.Z` tag together. If `main` advances during the workflow, rerun
it against the new commit.

After pushing the tag, Bump dispatches the Release workflow. Release verifies the
tag against the Cargo workspace version and triggers the agent-witness package
build in `evanpurkhiser/PKGBUILDs`. It also accepts version-tag pushes and manual
dispatches on a version tag.

The repository secret `AUR_BUMP_DISPATCH_PAT` must contain a token with
`actions:write` and `contents:read` access to `evanpurkhiser/PKGBUILDs`.
