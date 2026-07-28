# agent-witness

A remote SSH agent that lets autonomous agents securely authenticate using
keys that never leave your devices.

The SSH private keys stay encrypted on your phone, unlocked with a WebAuthn
passkey. A local daemon exposes an `SSH_AUTH_SOCK`, and when something needs to
sign, it wakes your phone with a push notification to authorize the request.

> [!WARNING]
> Early work in progress.

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
