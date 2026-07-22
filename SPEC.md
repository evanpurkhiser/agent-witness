# agent-witness

A remote SSH agent that lets autonomous agents securely authenticate using keys
that never leave your devices.

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
- A WebAuthn PRF extension passkey is used to encrypt and decrypt the SSH key.
- Encryption and decryption will happen in a WASM worker.
- The WASM worker implements an ssh-agent. Data is shuttled from the worker to
  the remote server via a WebSocket. All keys from the vault are presented.
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

- Rust
- Frontend app, service worker WASM, etc. is baked in at compile time

**Frontend**

- React / Vite

**Service worker**

- TypeScript / Rust WASM / Vite?

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

Owns the live agent session and isolates sensitive operations from normal UI
code.

**Responsibilities:**

- Instantiate the WASM module
- Receive transferred PRF output from the page
- Load the encrypted vault from IndexedDB
- Pass encrypted vault data and unlock material into WASM
- Open and maintain the WebSocket
- Receive remote agent messages
- Pass agent packets into WASM
- Return encoded responses over the WebSocket
- Notify the page about connection and request state
- Lock and destroy the WASM agent state when disconnected
- Enforce idle and session timeouts

**Should not:**

- Render UI
- Invoke WebAuthn
- Handle push notifications
- Interpret React state
- Store plaintext private keys outside WASM

The worker is the owner of the active session:

```
WebSocket lifetime ≈ unlocked-agent lifetime ≈ worker lifetime
```

When the worker terminates, the server should treat the agent as unavailable.

### WASM module

Owns the security-sensitive and protocol-sensitive core.

**Responsibilities:**

- Derive the vault wrapping key from the PRF output and salt
- Decrypt and authenticate the vault
- Parse the vault format
- Parse OpenSSH private keys
- Hold decrypted key material in WASM memory
- Implement the SSH-agent protocol
- Process identity-list requests
- Process signing requests
- Process supported extensions
- Enforce key and request policies
- Produce SSH signatures
- Encode SSH-agent responses
- Clear sensitive memory when locked or dropped

**Potential interface:**

```rust
create_agent(encrypted_vault, prf_output, salt) -> AgentHandle
list_public_identities(handle) -> Vec<Identity>
handle_agent_packet(handle, packet) -> Vec<u8>
set_request_context(handle, context)
lock_agent(handle)
```

**Should not:**

- Open browser windows
- Display notifications
- Render approval UI
- Invoke WebAuthn directly
- Depend on React or browser page state
- Store persistent data itself unless exposed through a narrow storage adapter

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

### Web Worker ↔ WASM

Binary and structured security inputs:

- Encrypted vault bytes
- PRF output
- Vault salt
- SSH-agent packets
- Trusted request context
- Policy configuration

Outputs:

- Public identity metadata
- Encoded SSH-agent responses
- Sanitized status information
- Audit metadata

## Storage ownership

### IndexedDB

Store:

- Encrypted vault
- Vault salt
- Credential ID
- Server pairing records
- Push subscription information
- Non-sensitive preferences
- Encrypted audit records, if desired

### WASM memory

Store only while unlocked:

- Vault master key (memory zeroed after decrypting the vault)
- Decrypted private keys
- Parsed signing keys
- Active request context
- Authorization lease state

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

| Component        | Trusted for                                              |
| ---------------- | -------------------------------------------------------- |
| Service worker   | Notification routing                                     |
| Page             | UI and initiating WebAuthn                               |
| Dedicated worker | Session orchestration                                    |
| WASM             | Key handling, policy, and signing                        |
| Server           | Requesting signatures, but not trusted with private keys |
| Relay/network    | Untrusted beyond authenticated encrypted transport       |

The most important boundary is: **the page obtains the WebAuthn result, but the
dedicated worker and WASM module own everything after unlock.** That keeps the UI
layer thin while avoiding the unreliable lifecycle of placing the live agent
inside the service worker.

## Server daemon

The server is the bridge between local SSH-agent clients and the remote unlocked
agent.

### Core responsibilities

- Listen on a Unix socket exposed as `SSH_AUTH_SOCK`
- Accept local SSH-agent protocol requests
- Track whether an unlocked remote agent is currently connected
- Maintain the active WebSocket session
- Forward raw SSH-agent packets to the connected agent
- Correlate responses with waiting Unix-socket requests
- Trigger a push notification when no agent is connected
- Wait for the PWA to connect and unlock
- Resume the pending request once the agent becomes available
- Enforce request deadlines and cancellation
- Persist pairing and push-subscription state
- Expose health and diagnostic state to logs or a local CLI

### Suggested state model

```
disconnected
  ├── no pending requests
  └── pending request
        → push sent
        → waiting for agent

connected
  ├── locked/unavailable
  └── unlocked/ready
```

The distinction between WebSocket connected and agent ready matters. The PWA may
connect before WebAuthn finishes or after the vault has locked.

A more explicit enum:

```rust
enum RemoteAgentState {
    Disconnected,
    Connecting,
    ConnectedLocked,
    Ready {
        session_id: SessionId,
    },
}
```

### Request lifecycle

```
local process writes SSH-agent request
        ↓
server assigns request ID
        ↓
agent ready?
   yes ───────────────→ send over WebSocket
   no
        ↓
coalesce pending requests
        ↓
send push notification
        ↓
wait for PWA connection and unlock
        ↓
send request
        ↓
receive response
        ↓
write raw response to Unix socket
```

The local Unix connection should remain blocked while the phone is being opened
and unlocked.

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
    AgentReady {
        session_id: Uuid,
    },
    AgentLocked,
    AgentResponse {
        request_id: Uuid,
        payload: Vec<u8>,
    },
    Pong,
}

enum ServerMessage {
    AgentRequest {
        request_id: Uuid,
        payload: Vec<u8>,
    },
    CancelRequest {
        request_id: Uuid,
    },
    Ping,
}
```

Use a binary serialization format such as:

- MessagePack
- CBOR
- postcard
- A tiny custom binary envelope

Since the SSH-agent payload is already binary, JSON would just add base64
overhead.

A custom envelope could be as simple as:

```
version       u8
message_type  u8
request_id    16 bytes
payload_len   u32
payload       n bytes
```

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
    push_subscription: PushSubscription,
    client_public_key: Vec<u8>,
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

[[clients]]
id = "..."
label = "Evan's iPhone"
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

When the PWA first registers, it should pair with the server using a one-time
token or QR code.

Pairing establishes:

- Server identity
- Client identity
- WebSocket authorization
- Push subscription
- Optional display name
- Optional allowed Tailscale identity

The server should not accept arbitrary browser connections merely because they
know the WebSocket URL.

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
socket_mode = "0600"
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
```

The central component is a request broker:

```rust
struct RequestBroker {
    remote_agent: Option<RemoteAgentSession>,
    pending: HashMap<RequestId, PendingRequest>,
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
