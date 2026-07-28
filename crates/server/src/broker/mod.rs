//! Queue-first coordination between local SSH-agent callers and one remote agent.
//!
//! The pure state machine lives in [`model`]. The Tokio actor in [`task`] owns
//! that model and translates its effects into channels used by I/O adapters.

use std::time::Duration;

use bytes::Bytes;
use thiserror::Error;
use tokio::sync::mpsc;
use uuid::Uuid;

mod model;
mod task;

#[cfg(test)]
mod tests;

pub use task::BrokerHandle;

/// Stable identity assigned to one local request.
pub type RequestId = Uuid;

/// Stable identity assigned to one remote WebSocket session.
pub type SessionId = Uuid;

/// Runtime limits enforced by the request broker.
#[derive(Clone, Copy, Debug)]
pub struct BrokerConfig {
    /// Maximum time a local request may remain pending.
    pub request_timeout: Duration,

    /// Maximum combined number of queued and in-flight requests.
    pub max_pending_requests: usize,
}

/// Message emitted by the broker for the active remote session.
#[derive(Debug)]
pub enum RemoteCommand {
    /// Dispatch an opaque SSH-agent packet for remote processing.
    Request {
        /// Request being dispatched.
        request_id: RequestId,

        /// Monotonically increasing dispatch attempt for this request.
        attempt: u32,

        /// Complete length-prefixed SSH-agent packet.
        packet: Bytes,
    },

    /// Stop remote work whose local caller has expired or cancelled.
    Cancel {
        /// Request whose work is no longer needed.
        request_id: RequestId,

        /// Specific dispatch attempt being cancelled.
        attempt: u32,
    },
}

/// Server-side registration returned to a newly connected remote adapter.
pub struct RemoteConnection {
    /// Identity assigned by the broker to this connection.
    pub session_id: SessionId,

    /// Commands that the remote adapter must forward over its transport.
    pub commands: mpsc::UnboundedReceiver<RemoteCommand>,
}

/// Failure to perform a broker control operation.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum BrokerError {
    /// The broker task has stopped.
    #[error("the request broker is unavailable")]
    Unavailable,

    /// A second remote attempted to bind while another remained active.
    #[error("a remote agent is already connected")]
    RemoteAlreadyConnected,

    /// A remote connection advertised no request-processing capacity.
    #[error("remote capacity must be greater than zero")]
    InvalidRemoteCapacity,
}
