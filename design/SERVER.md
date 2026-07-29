# Server design

This document describes the implementation structure and dependency choices for
the Rust server. `SPEC.md` remains the source of truth for system behavior and
security boundaries; this document explains how to organize the server code to
implement that design incrementally.

## Design principles

- Every accepted local request enters the broker queue. A connected remote
  worker makes the queued phase short; vault readiness does not create a
  separate server path.
- The broker is the only component that decides when to queue, dispatch,
  requeue, cancel, expire, or fail a request.
- Socket and WebSocket handlers are adapters. They translate I/O into broker
  events and broker effects back into I/O.
- Pairing state has one owner and is changed atomically.
- The SSH-agent socket and administrative control socket are separate trust
  boundaries.
- Protocol types live with the protocol that owns them. Avoid generic
  `types.rs`, `utils.rs`, and `error.rs` modules.
- Start with cohesive single files and split them only when independent
  responsibilities emerge.

## Target layout

```text
crates/server/
  src/
    main.rs
    lib.rs

    cli.rs
    config.rs
    daemon.rs
    packet.rs
    storage.rs
    pairing.rs
    stats.rs
    push.rs

    broker/
      mod.rs
      model.rs
      task.rs

    agent_socket/
      mod.rs
      file.rs
      listener.rs

    control/
      mod.rs
      client.rs
      server.rs
      protocol.rs

    remote/
      mod.rs
      session.rs
      protocol.rs

    web/
      mod.rs
      assets.rs

  tests/
    agent_socket.rs
    control.rs
    remote_session.rs
    end_to_end.rs
    support/
      mod.rs
```

The intended dependency direction is:

```text
main / CLI
    ↓
daemon orchestration
    ↓
I/O adapters ─────→ broker
    │                 ↓
    ├─ agent socket   request state
    ├─ WebSocket      reconciliation
    ├─ control IPC    effects
    └─ push
```

The broker must not depend on an I/O adapter. Adapters may depend on the
broker's public handle and protocol types.

## Crate identity

Rename the package from the scaffolded `server` name to
`agent-witness-server`. Keep the installed binary named `agent-witness`. The
library crate is then imported as `agent_witness_server`, which distinguishes
server internals from the product-wide binary name.

## Entrypoints

### `main.rs`

`main.rs` initializes the async runtime and delegates to the library:

```rust
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    agent_witness_server::cli::run().await
}
```

It should not contain configuration loading, listener setup, or protocol
handling.

### `cli.rs`

The CLI owns argument parsing and dispatch for:

```console
agent-witness serve
agent-witness status
agent-witness stats
agent-witness pairing clear
```

`serve` calls `daemon::run`. The other commands use `control::client` to perform
one request against the running daemon. The CLI formats human-readable or JSON
output but does not read or mutate daemon state directly.

### `lib.rs`

The library root exposes the modules needed by the binary and integration
tests. Internal implementation details should remain private by default.

## Daemon and configuration

### `daemon.rs`

The daemon constructs and supervises the server:

- Load configuration and persistent state.
- Create the statistics handle.
- Start the broker task.
- Start the SSH-agent, control, and HTTP/WebSocket listeners.
- Connect broker effects to remote sessions and push delivery.
- Coordinate graceful shutdown.
- Remove owned Unix socket files during shutdown.

The daemon wires components together but does not implement their policy.

### `config.rs`

Configuration is operator-controlled, static input:

- Unix agent socket path and mode
- Control socket path and mode
- HTTP listen address
- Persistent state path
- Request timeout
- Maximum packet size
- Maximum pending requests
- Remote in-flight capacity
- Push and VAPID configuration

Human-readable durations use `humantime-serde`.

### `storage.rs`

Storage owns mutable durable state:

- Server identity
- The optional paired client
- Credential hash
- Optional push subscription

State is small enough for a JSON file. Updates should write a temporary file in
the same directory, flush it, atomically rename it, and preserve restrictive
permissions. Pending agent requests and process-lifetime statistics are not
persisted.

Configuration and mutable state must remain separate.

## Request broker

The broker is the center of the server and the sole owner of request state.

### `broker/model.rs`

The model contains the pure state machine:

```rust
struct BrokerState {
    agent: RemoteAgentState,
    /// Authoritative set of all queued and in-flight requests.
    pending: HashMap<RequestId, PendingRequest>,
    /// FIFO subset of pending requests that have not been dispatched.
    queue: VecDeque<RequestId>,
}
```

Its main interface is conceptually:

```rust
fn apply(&mut self, event: Event, now: Instant) -> Vec<Effect>;
```

Events update facts. Reconciliation then produces effects based on the current
gates:

```text
request queued
  + authenticated client connected
  + remote capacity available
  + deadline not reached
  = dispatch permitted
```

The remote capacity bounds requests delivered to the worker but not yet
answered, including requests buffered while its vault is locked. Readiness is
tracked for status and client behavior, not as a server dispatch gate.

The model knows nothing about Tokio sockets, WebSockets, JSON, files, or Web
Push. Most state-transition and edge-case tests should exercise this module
directly.

### `broker/task.rs`

The broker task wraps the model in a Tokio actor:

- Receive local requests and remote-control commands over separate `mpsc`
  channels.
- Apply events to the model.
- Execute or forward resulting effects.
- Own deadline timers.
- Return local responses through `oneshot` channels.
- Publish sanitized snapshots to control IPC.

The daemon owns the local request channel and passes its two ends directly to
the socket adapter and broker:

```rust
let (local_requests, incoming_requests) = mpsc::channel(capacity);
let (broker, task) = BrokerHandle::spawn(config, incoming_requests);
let socket_task = socket.serve(local_requests, shutdown);
```

The socket and broker both depend on the neutral `PacketRequest` channel
protocol in `packet.rs`; neither depends on the other. Request-level failures
such as timeout and queue exhaustion also live there rather than in the
broker's control error. Each packet also carries a child cancellation token
owned by its local connection. The broker watches that token, removes cancelled
queued requests, and forwards cancellation for active remote attempts. The
handle used by remote and control adapters remains narrow:

```rust
impl BrokerHandle {
    async fn remote_connected(&self, outbound: Sender<ServerMessage>) -> SessionId;
    async fn remote_ready(&self, session: SessionId);
    async fn remote_locked(&self, session: SessionId);
    async fn remote_response(&self, response: AgentResponse);
    async fn snapshot(&self) -> BrokerSnapshot;
}
```

Every `PacketRequest` received by the broker enters the queue. There is no
adapter-visible "dispatch immediately if connected" path.

### `broker/mod.rs`

The module root defines or re-exports the public handle, events, effects,
snapshots, and identifiers. Internal queue structures remain private.

## I/O adapters

### `agent_socket/`

The local SSH-agent adapter:

- Accept Unix stream connections.
- Read bounded, big-endian, length-prefixed SSH-agent frames.
- Submit complete frames through the neutral packet channel.
- Await and write the packet response unchanged.
- Cancel each packet token when its local connection ends.

It does not inspect SSH message types or remote-agent readiness.

`mod.rs` is the public facade and keeps the socket-file ownership guard alive
for the listener's lifetime. `file.rs` owns safe binding, stale-socket
detection, permissions, and inode-aware cleanup. `listener.rs` owns the accept
loop, connection tasks, packet framing, and cancellation-token propagation.

### `remote/protocol.rs`

This module defines serialization for:

- Pairing and authentication handshake messages
- Agent ready and locked state
- Agent requests and responses
- Request attempts and cancellations
- Heartbeats

The protocol uses named-field MessagePack values derived from explicit Serde
types. UUIDs remain hyphenated strings, while credentials and raw,
length-prefixed SSH-agent packets use MessagePack binary values. Rust and
TypeScript share semantic fixtures rather than maintaining separate manual
codecs.

### `remote/session.rs`

One remote session owns one authenticated WebSocket:

- Automatically pair the first client or authenticate an existing credential.
- Register and unregister the session with the broker.
- Translate readiness, locking, and response messages into broker events.
- Forward broker requests and cancellations even while the vault is locked.
- Enforce heartbeat and message-size limits.

It cannot directly inspect or mutate the request queue.

### `control/protocol.rs`

Defines the versioned, length-prefixed JSON request/response protocol for
status, statistics, and clearing pairing.

### `control/server.rs`

The server side:

- Accept connections on the restricted control socket.
- Verify peer credentials where supported.
- Decode exactly one request.
- Query the broker, statistics, or pairing service.
- Return exactly one response and close.

### `control/client.rs`

The CLI side:

- Discover or accept an override for the control socket.
- Send one request and receive one response.
- Preserve structured control errors for CLI formatting.

## Supporting services

### `pairing.rs`

Pairing owns the single paired-client lifecycle:

- Atomically claim the first client.
- Generate and hash the long-lived credential.
- Authenticate reconnecting clients in constant time.
- Update last-seen metadata.
- Register or replace a push subscription.
- Clear pairing.

Clearing pairing persists the unpaired state before invalidating the active
session. Push-subscription writes carry the authenticated client ID and are
rejected if the pairing has since been cleared or replaced. A failed persistent
update closes the authenticated session.

### `stats.rs`

Statistics begin as a cloneable set of atomic counters. Exact cross-counter
snapshot consistency is not required, but every snapshot includes the
collection start time.

No general metrics framework is needed initially.

### `push.rs`

Push delivery consumes coalesced wake effects emitted while no remote worker is
connected:

- Build the non-sensitive wake-up payload.
- Encrypt and authenticate it for Web Push.
- Deliver it using the stored subscription.
- Apply retry and notification-coalescing policy.
- Update delivery statistics and diagnostics.

It does not decide whether requests should be dispatched or queued.

### `web/mod.rs`

Constructs the HTTP router for:

- WebSocket upgrades
- Optional health diagnostics
- Embedded frontend assets and SPA fallback

### `web/assets.rs`

Contains only compile-time frontend embedding and HTTP asset metadata.

## Incremental file creation

The target layout should not be scaffolded all at once.

The broker and Unix-agent increment starts with:

```text
src/
  main.rs
  lib.rs
  cli.rs
  config.rs
  daemon.rs
  agent_socket/
    mod.rs
    file.rs
    listener.rs
  broker/
    mod.rs
    model.rs
    task.rs
    tests.rs
```

Phase 1 already gives the pure model and Tokio actor substantial independent
responsibilities, so the broker starts split rather than growing through one
large transitional file.

Add the `control`, `remote`, and `web` directories with their corresponding
increments.

## Dependencies

Dependency versions below indicate intended compatibility lines. `Cargo.lock`
pins the exact versions used to build the application.

### Foundation

These dependencies cover the broker, Unix sockets, control IPC, pairing,
configuration, and CLI:

```toml
[dependencies]
anyhow = "1"
base64 = "0.22"
bytes = { version = "1", features = ["serde"] }
clap = { version = "4", features = ["derive"] }
figment = { version = "0.10", features = ["toml"] }
futures-util = "0.3"
getrandom = "0.4"
humantime = "2"
humantime-serde = "1"
rmp-serde = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.11"
subtle = "2"
thiserror = "2"
time = { version = "0.3", features = ["serde", "formatting", "parsing"] }
tokio = { version = "1", features = [
  "fs",
  "io-util",
  "macros",
  "net",
  "rt-multi-thread",
  "signal",
  "sync",
  "time",
] }
tokio-util = { version = "0.7", features = ["codec", "rt"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter", "json"] }
uuid = { version = "1", features = ["serde", "v4"] }
zeroize = { version = "1", features = ["derive"] }
```

Responsibilities:

- `tokio` provides the runtime, tasks, channels, timers, signals, and Unix/TCP
  sockets.
- `tokio-util` provides cancellation tokens and bounded length-delimited
  codecs.
- `bytes` carries packet ownership between adapters and the broker.
- `rmp-serde` encodes the named remote WebSocket protocol without copying
  binary packet fields into text representations.
- `clap` defines the nested CLI.
- `figment` layers serialized defaults, an optional TOML file, and explicit CLI
  overrides.
- `serde` and `serde_json` encode control messages and persistent state.
- `humantime` parses duration CLI overrides, and `humantime-serde` parses
  configuration values such as `request_timeout = "90s"`.
- `uuid` provides request, client, and session identifiers.
- `getrandom` creates high-entropy pairing credentials.
- `sha2`, `subtle`, and `zeroize` hash credentials, compare them in constant
  time, and clear temporary secret buffers.
- `time` represents persisted and displayed timestamps. Broker deadlines use
  `std::time::Instant`.
- `thiserror` defines structured subsystem errors. `anyhow` is restricted to
  top-level CLI and daemon error context.
- `tracing` and `tracing-subscriber` provide human-readable and optional JSON
  logs.

Tokio's Unix stream API provides peer credentials on supported platforms, so
the initial implementation does not need `nix`.

### HTTP and WebSocket

Add with the remote transport increment:

```toml
axum = { version = "0.8", features = ["ws"] }
tower-http = { version = "0.6", features = ["trace"] }
```

Axum's built-in WebSocket support is sufficient. Do not add a second WebSocket
server implementation. `futures-util` supplies the stream and sink extension
traits used by WebSocket sessions.

The remote protocol uses `rmp-serde` with named fields. Its browser counterpart
uses `@msgpack/msgpack`. Avoid relying on `rmp-serde`'s positional struct or
default enum representations; explicit names and tags are part of the wire
contract.

### Frontend assets

Add when the server packages the PWA:

```toml
mime_guess = "2"
rust-embed = "8"
```

Packaging should build the frontend explicitly before compiling the release
server. Avoid hiding pnpm invocation inside `build.rs`.

The `embedded-ui` Cargo feature adds the built Vite output to the server binary.
It remains opt-in so normal Rust development does not require a populated
frontend `dist` directory. The root production build command owns the required
ordering:

```console
pnpm install --frozen-lockfile
pnpm build:production
```

This builds `packages/app/dist` before running the locked release build with
`embedded-ui`. Missing frontend output must fail the release build rather than
silently producing a server without its browser application.

### Web Push

VAPID key generation uses:

```toml
p256 = { version = "0.13", default-features = false, features = ["arithmetic"] }
```

The private scalar is stored separately with mode `0600`; the uncompressed
public point is derived at startup and included in successful remote
handshakes.

The provisional choice for push request construction and delivery is:

```toml
web-push-native = "0.4"
reqwest = { version = "0.13", default-features = false, features = [
  "http2",
  "rustls",
] }
```

`web-push-native` builds the encrypted and VAPID-authenticated HTTP request;
`reqwest` sends it using Rustls. Verify this combination against a real iOS Web
Push subscription in a small interoperability spike before making it a core
dependency.

The higher-level `web-push` crate remains an alternative, but its transport
dependency alignment and TLS backend should be evaluated before adoption.

### TLS

Do not add a direct TLS dependency initially. Production deployments can
terminate TLS with Tailscale Serve, Caddy, or another local reverse proxy.

If direct TLS becomes a requirement, choose the Rustls integration in a
separate increment that also addresses certificate loading, reloads, and
operational ownership.

### Development dependencies

```toml
[dev-dependencies]
assert_cmd = "2"
predicates = "3"
proptest = "1"
tempfile = "3"
tokio-tungstenite = "0.30"
tower = { version = "0.5", features = ["util"] }
```

- `proptest` exercises packet framing and broker event sequences.
- `tempfile` isolates sockets, configuration, and state in integration tests.
- `tokio-tungstenite` acts only as the integration-test WebSocket client.
- `tower` tests the Axum router without opening a TCP listener.
- `assert_cmd` and `predicates` cover CLI behavior.

Prefer small handwritten fakes over a mocking framework. The broker's explicit
event/effect boundary should make fakes straightforward.

## Deliberately omitted dependencies

- No database or SQL toolkit; persisted state is one small JSON document.
- No `dashmap`, `parking_lot`, or crossbeam queue; the broker actor owns mutable
  request state on one task.
- No general metrics framework; process-lifetime atomic counters are enough.
- No `nix` until an operation cannot be implemented safely through Tokio or the
  standard library.
- No direct TLS stack until the deployment model requires it.
- No mocking framework.
