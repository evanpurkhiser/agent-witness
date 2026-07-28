# agent-witness

A remote SSH agent that lets autonomous agents securely authenticate using keys
that never leave your devices.

## Implementation status

This spec describes the whole system; some operational services remain design.
The security-sensitive client core, live browser session, and initial durable
Rust server request path are implemented and unit-tested.

**Implemented (client vault core):** SSH key parsing (`openssh-key-v1`), SSH
wire encoding, public-key fingerprints, the WebCrypto envelope (passkey → master
key → per-key wrapping), IndexedDB storage, the typestate vault API, ssh-agent
message framing and dispatch, and vault-backed signing.

**Implemented (server):** the queue-first request broker and
connection/capacity gates, request deadlines and remote-attempt correlation,
local cancellation through remote `CancelRequest`, daemon configuration and
lifecycle, a bounded permission-restricted Unix SSH-agent socket, and the
MessagePack WebSocket adapter. First-client pairing supports both process-local
memory and atomically replaced persistent state, and the local control socket
can clear pairing and revoke an active remote session.

**Implemented (live client):** the dedicated worker's WebSocket session,
pairing credential storage, locked request buffering, cancellation, signing
over the wire, and embedded production frontend assets.

**Not yet implemented (still as designed below):** the service worker and Web
Push, push-subscription registration and delivery, and the control socket's
status and statistics commands.

Note: there is **no Rust/WASM on the client**. A spike proved a hand-rolled
ssh-agent in TypeScript authenticates against a real OpenSSH `sshd`, and Ed25519
WebCrypto works on-device (iOS 17+). The security-sensitive core is TypeScript
driving WebCrypto, running in a dedicated Web Worker. Rust lives only in the
server (`crates/server`).

## Motivation

There needs to be a way to authenticate SSH agent requests remotely from a
machine a user is actively on. Typically you could use ssh-agent forwarding for
this. But that only works when you're connected to the remote host that needs
SSH authentication via SSH, and the host you're connecting from even supports
SSH agent forwarding.

The use case I have is when a headless agent on a server, that is controlled
remotely by a client on any number of devices, needs to do SSH auth.

I've solved this for my MacBooks by having a socket-activated service on my
server SSH into the MacBook I'm currently using and forward the 1Password SSH
agent socket over the SSH connection. But if I'm not at my Mac (only at my
iPhone) I'm unable to authorize SSH agent usage.

This project will solve that, within the following constraints:

- The SSH private key will never be passed over the wire.
- The private key(s) will be encrypted at rest on the iOS device.
- A salt is stored alongside the vault.
- If you lose the passkey the vault is lost. This should **not** be considered
  the only storage for private keys.
- A WebAuthn PRF extension passkey is used to derive the key that encrypts and
  decrypts the SSH keys.
- Encryption, decryption, and signing happen in a dedicated Web Worker using
  WebCrypto (TypeScript, no WASM). Private keys are held as non-extractable
  `CryptoKey`s, so raw private-key bytes never persist in JS.
- The worker implements an ssh-agent. Data is shuttled from the worker to the
  remote server via a WebSocket. All keys from the vault are presented.
- All agent requests will be approved for the duration the worker stays
  connected and the vault unlocked.
- The web app can be installed as a PWA on iOS and will register a push
  notification handler. When the remote server does not have the worker agent
  connected via a WebSocket, it will use the push notification to ask you to
  authenticate the agent to handle the request.
- The server will only allow one client to bind at a time. Once a client
  disconnects another can bind.
- The push notification URL will be registered in the server into some local
  state file.

## Web app workflow

1. You register a new passkey-backed vault.
2. You register as many private SSH keys (without passphrase) into that vault as
   you would like.
3. At this point the worker is connected over the WebSocket and can authenticate
   agent requests.
4. Install the app as a PWA onto the iPhone, then register for push
   notifications.
5. Now anytime the remote server gets an SSH agent request, it will trigger the
   notification. Clicking the notification opens the PWA and triggers the
   WebAuthn request to unlock the vault, activate the agent, and handle the
   request over the WebSocket.

## Language choices

**Server app**

- Rust (the only Rust in the project — see `crates/server`)
- The built frontend assets are baked in at compile time

**Frontend**

- React / Vite
- TypeScript throughout, including the dedicated Web Worker that owns the
  security-sensitive core. All crypto is WebCrypto; there is no WASM.

**Service worker**

- TypeScript / Vite (push wake-up and asset caching only)

The server runs as a systemd service and listens on a Unix socket for local
SSH-agent clients. Its browser-facing WebSocket endpoint must use TLS.
Deployments should preferably expose that endpoint only over Tailscale or
another private authenticated network.

## Responsibilities

### Page

Owns everything that requires a visible, foreground browser context.

**Responsibilities:**

- Render the React UI
- Register the service worker
- Start and stop the dedicated Web Worker
- Invoke WebAuthn and request the PRF output
- Display pending SSH authentication requests
- Show connection, vault, and approval state
- Handle vault creation, key import, pairing, and settings
- Transfer unlock material to the Web Worker
- Lock the agent when the user requests it
- Receive status and audit events from the worker

**Should not:**

- Parse private SSH keys
- Hold the decrypted vault
- Produce SSH signatures
- Maintain long-lived private-key state
- Directly handle SSH-agent packets

**Typical flow:**

```
notification opens PWA
→ page starts worker
→ page calls WebAuthn
→ page transfers PRF output to worker
→ page shows "agent active"
```

### Service worker

Acts only as the background wake-up and notification coordinator.

**Responsibilities:**

- Receive Web Push events
- Display notifications
- Handle notification clicks
- Open or focus the PWA
- Pass non-sensitive request identifiers to the page
- Cache static application assets for PWA installation
- Manage service-worker update lifecycle

**Should not:**

- Hold the decrypted vault
- Hold the PRF output
- Maintain the SSH-agent WebSocket
- Perform signing
- Be considered continuously alive
- Make authorization decisions

The service worker should receive something minimal:

```json
{
  "request_id": "abc123",
  "server": "build-server",
  "expires_at": 1784671200
}
```

It should not receive the signing payload or private-key material.

### Dedicated Web Worker

Owns the live agent session and the security-sensitive core, isolating sensitive
operations from normal UI code. This is where key handling, the vault, and
signing live — in TypeScript over WebCrypto, not in WASM.

**Responsibilities:**

- Receive transferred PRF output from the page
- Load the vault and encrypted key blobs from IndexedDB
- Derive the wrapping key and unlock the vault (recover the master key)
- Hold unlocked keys as non-extractable `CryptoKey`s
- Open and maintain the WebSocket
- Receive remote agent messages
- Buffer a bounded number of agent requests in memory while the vault is locked
- Implement the ssh-agent protocol and produce signatures via WebCrypto
- Return encoded responses over the WebSocket
- Notify the page about connection and request state
- Drop the resident master key and signing keys when locked or disconnected
- Enforce idle and session timeouts

**Should not:**

- Render UI
- Invoke WebAuthn
- Handle push notifications
- Interpret React state
- Expose private-key material or the decrypted master key to the page

The worker is the owner of the active session:

```
WebSocket lifetime ≈ worker lifetime
unlocked-agent lifetime ⊆ WebSocket lifetime
```

The authenticated worker may receive requests before WebAuthn unlocks the
vault. Those requests stay only in worker memory and are processed after
unlock. When the worker terminates, the server should treat the agent as
unavailable.

### Vault core (crypto and protocol)

The security-sensitive and protocol-sensitive core, implemented in TypeScript
over WebCrypto and run inside the dedicated worker. The vault core is built and
unit-tested; the ssh-agent protocol handling on top of it is not yet written.

**Responsibilities:**

- Derive the wrapping key from the PRF output and per-passkey salt
- Recover the master key from any enrolled passkey
- Parse OpenSSH private keys (`openssh-key-v1`, cipher "none")
- Import keys as non-extractable signing `CryptoKey`s
- Implement the SSH-agent protocol (identity list, signing, extensions)
- Enforce key and request policies
- Produce SSH signatures via WebCrypto
- Encode SSH-agent responses
- Drop the resident master key and signing keys when locked or dropped

**Crypto / envelope design (implemented):**

- The WebAuthn PRF output plus a stored per-passkey salt feed **HKDF-SHA256**
  (`deriveWrappingKey`) to produce a non-extractable AES-GCM **wrapping key**.
  The PRF output is already high-entropy, so there is no Argon2/PBKDF2.
- A random AES-GCM **master key** (`generateMasterKey`) is wrapped under each
  enrolled passkey's wrapping key and stored (`wrappedMasterKey`). Multiple
  passkeys can be enrolled; unlock tries each and succeeds on the first match.
- Each SSH private key is imported into a WebCrypto `CryptoKey` and wrapped under
  the master key with AES-GCM (`wrapSSHKey`), with the key id bound as AEAD
  associated data. The encrypted blob is stored separately from its metadata.
- After unlock, all keys are held **non-extractable** and signing is done via
  WebCrypto, so raw private-key bytes never persist in JS. Ed25519 requires
  iOS 17+.
- Envelope blob format throughout is `nonce(12) || AES-GCM ciphertext`.
- Supported key types: `ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256`.

**Vault API (typestate machine, implemented):**

`openVault(store)` returns `NoVault | LockedVault`. Each state exposes only the
transitions valid from it, so state-invalid operations are unrepresentable at
the type level:

```ts
NoVault.createVault(params) -> UnlockedVault
LockedVault.unlock(prfOutput) -> UnlockedVault
UnlockedVault.addKey(pem, name?) -> UnlockedVault
UnlockedVault.lock() -> LockedVault
// shared by both loaded states:
removeKey(keyId) -> Self
destroy() -> NoVault
```

Errors are narrowed to `WrongPasskey` and `DuplicateKey`, plus the SSH parse
errors `InvalidKeyFormat` and `UnsupportedKey`.

**Should not:**

- Open browser windows
- Display notifications
- Render approval UI
- Invoke WebAuthn directly
- Depend on React or browser page state
- Expose the master key or private-key material to the page

## Message boundaries

### Service worker → page

Only wake-up metadata:

```ts
type WakeMessage = {
  requestId: string;
  serverLabel: string;
  expiresAt: number;
};
```

### Page → Web Worker

Control messages and transferred unlock material:

```ts
type PageToWorker =
  | {type: 'unlock'; prfOutput: ArrayBuffer}
  | {type: 'lock'}
  | {type: 'connect'}
  | {type: 'disconnect'};
```

Use transferable `ArrayBuffer`s so the page loses access to the PRF buffer after
sending it.

### Web Worker → page

Status and display-safe metadata:

```ts
type WorkerToPage =
  | {type: 'status'; status: 'locked' | 'connecting' | 'active'}
  | {type: 'request'; request: DisplayRequest}
  | {type: 'error'; message: string}
  | {type: 'audit'; event: AuditEvent};
```

No private keys, decrypted vault contents, or raw signing payloads should be
sent back.

### Worker-internal (vault core)

The security-sensitive core is not a separate module boundary — it is TypeScript
running inside the worker. Its inputs and outputs are the worker's own state:

Inputs:

- PRF output (transferred from the page)
- The vault record and encrypted key blobs loaded from IndexedDB
- SSH-agent packets from the WebSocket
- Trusted request context
- Policy configuration

Outputs:

- Public identity metadata
- Encoded SSH-agent responses
- Sanitized status information
- Audit metadata

## Storage ownership

### IndexedDB

Backed by the `idb` library (see `vault/storage.ts`). Byte fields are stored as
raw bytes (structured-cloned), not base64. Two object stores:

- `vault`: a single `Vault` record — `id`, `version`, `createdAt`, `passkeys[]`
  (each an `EnrolledPasskey`: `label`, `credentialId`, `salt`,
  `wrappedMasterKey`, `addedAt`), and `keys[]` (per-key `PrivateKeyMeta`:
  `id`, `name`, `type`, `publicKey`, `fingerprint`, `comment`, `addedAt`)
- `keys`: each SSH key's encrypted private blob (`EncryptedKey`), keyed by the
  owning key's id and written in the same transaction as the vault record

Still to be added alongside these: server pairing records, push subscription
information, non-sensitive preferences, and optional encrypted audit records.

### Worker memory

Held while connected:

- Bounded agent requests waiting for vault unlock
- Active request IDs, attempts, and deadlines

Held only while unlocked:

- Vault master key, as a non-extractable `CryptoKey`
- Per-key signing keys, as non-extractable `CryptoKey`s
- Active request context
- Authorization lease state

Because keys are non-extractable `CryptoKey`s, plaintext key bytes are never
resident in JS; dropping the references discards them when the vault locks.

### Page state

Store:

- UI state
- Public key names and fingerprints
- Connection status
- Sanitized request descriptions

### Service-worker storage

Store:

- Cached frontend assets
- Push subscription metadata
- Pending request IDs if needed

## Recommended trust model

| Component        | Trusted for                                                               |
| ---------------- | ------------------------------------------------------------------------- |
| Service worker   | Notification routing                                                      |
| Page             | UI and initiating WebAuthn                                                |
| Dedicated worker | Session orchestration, key handling, policy, and signing (TS + WebCrypto) |
| Server           | Requesting signatures, but not trusted with private keys                  |
| Relay/network    | Untrusted beyond authenticated encrypted transport                        |

The most important boundary is: **the page obtains the WebAuthn result, but the
dedicated worker owns everything after unlock.** That keeps the UI layer thin
while avoiding the unreliable lifecycle of placing the live agent inside the
service worker.

## Server daemon

The server is the bridge between local SSH-agent clients and the remote browser
worker.

The detailed Rust module layout and dependency plan live in
[`design/SERVER.md`](design/SERVER.md).

### Core responsibilities

- Listen on a Unix socket exposed as `SSH_AUTH_SOCK`
- Accept local SSH-agent protocol requests
- Track whether an authenticated remote worker is connected and whether its
  vault is locked
- Maintain the active WebSocket session
- Forward raw SSH-agent packets to the connected worker, including while locked
- Correlate responses with waiting Unix-socket requests
- Trigger a push notification when no worker is connected
- Wait for the PWA to connect when it is unavailable
- Let a connected worker hold requests until the user unlocks the vault
- Enforce request deadlines and cancellation
- Persist pairing and push-subscription state
- Expose health, diagnostic state, and administrative operations through a
  local control socket and CLI

### Suggested state model

```
disconnected
  ├── no pending requests
  └── pending request
        → push sent
        → waiting for agent

connected
  ├── locked/buffering requests
  └── unlocked/ready
```

The distinction between WebSocket connected and vault ready still matters for
status and client behavior, but not for server dispatch. The PWA may connect
before WebAuthn finishes or remain connected after the vault locks.

A more explicit enum:

```rust
enum RemoteAgentState {
    Disconnected,
    Connecting,
    Locked,
    Ready {
        session_id: SessionId,
    },
}
```

A request does not take a different path based on this state. Every accepted
local request enters the same broker queue first, even when a worker is already
connected. Connection state and remote buffer capacity act as gates controlling
when queued requests may be dispatched:

```
request queued
  + authenticated client connected
  + remote capacity available
  + deadline not reached
  = dispatch permitted
```

Vault readiness is not a dispatch gate. A locked worker holds delivered requests
in memory, prompts the page to unlock, and responds after WebAuthn succeeds.
This avoids separate disconnected, locked, and ready server flows.

### Request lifecycle

```
local process writes SSH-agent request
        ↓
server assigns request ID
        ↓
server admits request to queue
        ↓
reconcile connection/capacity gates
        ↓
client connected?
   no → coalesce wake demand
        → send push notification
        → wait for PWA connection
        → reconcile connection/capacity gates
        ↓
   yes ─┘
send request over WebSocket
        ↓
vault unlocked?
   no → buffer in worker memory
        → notify page and wait for unlock
   yes
        ↓
process request
        ↓
receive response
        ↓
write raw response to Unix socket
```

The local Unix connection should remain blocked while the phone is being opened
and unlocked.

The broker should behave like a controller rather than a collection of
state-specific workflows. Each event updates the broker's facts and runs the
same reconciliation step. Relevant events include:

- Local request admitted
- Local caller disconnected
- Remote client connected
- Vault became ready
- Vault locked
- Remote client disconnected
- Remote response received
- Request deadline expired

Each request follows one lifecycle:

```
queued → delivered/in flight → completed
   │                  │
   └──────────────────┴──→ expired or cancelled
```

A disconnect returns that session's in-flight requests to the queue, subject to
their original deadlines. The broker records a session ID and attempt number
for each dispatch, and the attempt number travels over the wire, so a late
response from an earlier session or attempt cannot complete a requeued request.

You will need a timeout, likely configurable:

```toml
request_timeout = "90s"
```

On timeout, return an SSH-agent failure response and discard any later phone
response.

### WebSocket protocol

You can preserve the raw SSH-agent bytes and add only a thin envelope:

```rust
enum ClientMessage {
    PairRequest {
        label: String,
    },
    Authenticate {
        client_id: Uuid,
        credential: Vec<u8>,
    },
    AgentReady,
    AgentLocked,
    AgentResponse {
        request_id: Uuid,
        attempt: u32,
        payload: Vec<u8>,
    },
    Pong,
}

enum ServerMessage {
    Paired {
        server_id: Uuid,
        client_id: Uuid,
        credential: Vec<u8>,
        session_id: Uuid,
    },
    Authenticated {
        server_id: Uuid,
        session_id: Uuid,
    },
    Rejected,
    AgentRequest {
        request_id: Uuid,
        attempt: u32,
        payload: Vec<u8>,
    },
    CancelRequest {
        request_id: Uuid,
        attempt: u32,
    },
    Ping,
}
```

The first application message on a new WebSocket must be a handshake message.
The server assigns the connection's session ID and does not process
`ClientMessage` values until pairing or authentication succeeds. Once
authenticated, the server may send `AgentRequest` while the client reports
locked. The worker buffers it in memory and uses the request event to prompt the
page for unlock. `CancelRequest` removes a buffered or active attempt when its
local caller expires.

Each application message occupies exactly one binary WebSocket message and
contains one named-field MessagePack value:

```text
{
  version: 1,
  message: {
    type: "agent_response",
    request_id: "81cbbdd8-fd6e-44d3-88e8-41ed8f3f3499",
    attempt: 1,
    packet: <MessagePack binary>
  }
}
```

The `message.type` values are the snake-case names shown by the Rust enums
above. UUIDs use standard hyphenated strings so the TypeScript side does not
need a custom extension codec. Credentials and complete SSH-agent packets use
MessagePack's binary type and decode to `Uint8Array` in the browser.

Named maps are slightly larger than positional tuples, but keep field order
out of the protocol and make additions easier to handle across Rust and
TypeScript. Breaking representation changes increment the envelope version.
Rust and TypeScript maintain shared semantic fixtures that each implementation
must encode and decode.

The server sends an application `Ping` every 30 seconds. A client that does not
send the application `Pong` before the next interval is disconnected and its
unfinished requests return to the broker queue.

### Concurrency model

Do not assume only one SSH-agent request at a time. Git, deployment tooling, or
multiple local processes may issue concurrent requests.

The server should maintain:

```rust
HashMap<RequestId, PendingRequest>
```

Each pending request contains:

- Unix connection or response channel
- Deadline
- Cancellation token
- Whether it has been sent remotely
- Optional request context

You can initially serialize all requests through a single queue, but request IDs
are still useful for cancellation and future concurrency.

### Push behavior

The push should be a wake-up hint, not carry sensitive protocol data.

Example payload:

```json
{
  "server_id": "build-server",
  "pending_requests": 1,
  "expires_at": 1784671200
}
```

Avoid putting the following into the push payload:

- SSH signing blobs
- Key identities
- Commands
- Raw agent packets

Also coalesce notifications. If ten requests arrive while the phone is offline,
send one notification rather than ten.

### Persistent state

The server needs to store more than just a push URL.

Likely state:

```rust
struct PairedClient {
    client_id: Uuid,
    label: String,
    push_subscription: Option<PushSubscription>,
    credential_hash: Vec<u8>,
    created_at: DateTime<Utc>,
    last_seen_at: Option<DateTime<Utc>>,
}
```

A web-push subscription normally includes:

- Endpoint URL
- p256dh public key
- Authentication secret

Store the complete subscription object, not just the URL.

You will also need the server's Web Push credentials, usually a VAPID keypair.

Example state file:

```toml
server_id = "build-server"

[vapid]
public_key = "..."
private_key_file = "/var/lib/agent-witness/vapid.key"

[client]
id = "..."
label = "Evan's iPhone"
credential_hash = "..."

[client.push_subscription]
endpoint = "https://..."
p256dh = "..."
auth = "..."
```

Secrets should not be world-readable. A better layout is:

```
/etc/agent-witness/config.toml
/var/lib/agent-witness/state.json
/var/lib/agent-witness/vapid.key
```

owned by the service user with mode `0600` where appropriate.

### Pairing

Pairing is automatic. An unpaired server atomically claims the first browser
client that opens the WebSocket and completes the pairing handshake. There is no
QR code or separately generated one-time token.

Pairing establishes:

- Server identity
- Client identity
- WebSocket authorization
- Authorization to register a push subscription
- Optional display name
- Optional allowed Tailscale identity

The initial WebSocket handshake should work as follows:

1. The client connects over TLS and sends a `PairRequest`.
2. If the server has no paired client, it generates a client ID and random
   long-lived credential, persists the credential hash, and responds with the
   client ID and credential.
3. The browser stores that credential in IndexedDB.
4. Future WebSocket connections authenticate by sending the client ID and
   credential as their first application message.
5. The server does not accept agent readiness or protocol messages until the
   connection is authenticated.

The credential must have enough entropy to resist guessing without a
password-hardening function. The server stores only its cryptographic hash and
compares presented credentials in constant time.

The server stores at most one paired client, and only one authenticated
connection may hold the active agent session. Once pairing state exists,
unauthenticated pairing requests are rejected. Pairing can be reset explicitly
through a local administrative command, which invalidates the existing client
and returns the server to its unpaired state.

Automatic first-client pairing deliberately makes initial deployment a
trust-on-first-use operation. The server must be reached through TLS and should
preferably be exposed only over Tailscale or another private authenticated
network before it is started unpaired. If an unexpected client wins the initial
race, the administrator must reset pairing before using the service.

### Local control CLI

The `agent-witness` binary should also provide a local administrative CLI that
communicates with the running daemon over a dedicated Unix control socket. The
control protocol must not share the SSH-agent socket: `SSH_AUTH_SOCK` accepts
untrusted ssh-agent packets, while the control socket exposes privileged
operations and diagnostic state.

Initial commands:

```console
agent-witness serve
agent-witness status
agent-witness stats
agent-witness pairing clear
```

`serve` runs the daemon and is the command used by the systemd service. Client
commands discover the control socket from the normal configuration and accept a
global `--control-socket PATH` override for recovery and testing.

`status` reports a current snapshot:

- Server ID and process uptime
- Whether a client is paired, including its label and last-seen time
- Remote agent state: disconnected, connected and locked, or ready
- Active session ID and connection age where applicable
- Queued and in-flight request counts
- Earliest pending request deadline
- Unix agent and control socket paths
- Push configuration and last delivery result, without subscription secrets

`stats` reports process-lifetime counters with the time at which collection
started:

- Local requests accepted, completed, failed, timed out, and cancelled
- Requests requeued after a remote disconnect
- Remote connection attempts, successful authentications, and authentication
  failures
- Push notifications attempted, accepted by the push service, and failed
- Pairing and pairing-reset counts

These counters do not initially need to survive a daemon restart. Persistent
metrics can be added later without changing the CLI contract.

`pairing clear` idempotently removes the paired client, its credential hash, and
its push subscription. It also disconnects the active remote session and
returns the server to its unpaired state. Any in-flight requests return to the
queue and all pending requests retain their original deadlines while waiting
for a new client to pair. The interactive CLI asks for confirmation when a
client is paired; `--yes` permits explicit non-interactive use. Success reports
whether pairing state actually existed.

Human-readable output is the default. Read-only commands should also accept
`--json` so scripts and diagnostics can consume a stable, versioned response
without parsing presentation text. Errors should distinguish connection
failure, permission denial, incompatible protocol version, invalid command, and
daemon-side failure.

The control protocol should be a small versioned request/response protocol over
a length-prefixed Unix stream. Requests and responses may use JSON initially
because control messages are small and contain no SSH-agent payloads. Each CLI
invocation connects, performs one request, receives one response, and closes.

Example protocol shape:

```rust
enum ControlRequest {
    Status,
    Stats,
    ClearPairing,
}

enum ControlResponse {
    Status(StatusSnapshot),
    Stats(StatsSnapshot),
    PairingCleared {
        had_client: bool,
    },
    Error(ControlError),
}
```

The daemon must create the control socket with restrictive permissions and
should verify local peer credentials where the platform supports it. Mutating
commands must never be exposed over the browser-facing HTTP or WebSocket
interface. Control responses must not include pairing credentials, credential
hashes, push-subscription secrets, raw SSH-agent packets, or signing payloads.

### Unix socket behavior

The daemon should:

- Create the socket with restrictive permissions
- Remove stale sockets on startup
- Support socket activation if desired
- Expose configurable path and ownership
- Verify local peer credentials where useful
- Cleanly reject malformed or oversized packets

Example config:

```toml
unix_socket = "/run/user/1000/agent-witness.sock"
control_socket = "/run/user/1000/agent-witness-control.sock"
socket_mode = "0600"
control_socket_mode = "0600"
request_timeout = "90s"
max_pending_requests = 32
```

### Suggested Rust structure

```
server/
  unix_agent.rs
  websocket.rs
  request_broker.rs
  push.rs
  pairing.rs
  state.rs
  config.rs
  control.rs
  cli.rs
  stats.rs
```

The central component is a request broker:

```rust
struct RequestBroker {
    remote_agent: Option<RemoteAgentSession>,
    /// Authoritative set of all queued and in-flight requests.
    pending: HashMap<RequestId, PendingRequest>,
    /// FIFO subset of pending requests that have not been dispatched.
    queue: VecDeque<RequestId>,
}
```

It should be the only component deciding:

- Whether to push
- Whether to queue
- When to send
- When to fail
- When to cancel

### Important edge cases

- PWA connects but never unlocks
- Push subscription expired
- Phone responds after the local caller disconnected
- WebSocket drops while a request is in flight
- Second PWA attempts to bind while one is connected
- Server restarts with pending requests
- Agent reconnects with stale responses
- Service worker opens multiple PWA windows
- Repeated requests trigger notification spam

I would not persist pending requests across server restarts. Fail them and
require the local client to retry.

The clean conceptual boundary is: **the server owns availability, queuing,
transport, and local socket semantics. The phone owns keys, policy, and
signing.** The server should never interpret or alter the SSH-agent payload
unless it is adding separately authenticated request context.
