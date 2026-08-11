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
