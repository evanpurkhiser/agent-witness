# agent-witness

A remote SSH agent that lets autonomous agents securely authenticate using
keys that never leave your devices.

The SSH private keys stay encrypted on your phone, unlocked with a WebAuthn
passkey. A local daemon exposes an `SSH_AUTH_SOCK`, and when something needs to
sign, it wakes your phone with a push notification to authorize the request.

> [!WARNING]
> Early work in progress.
