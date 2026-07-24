//! Transport-neutral request and response types for SSH-agent packets.

use bytes::Bytes;
use thiserror::Error;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// One complete SSH-agent packet awaiting processing.
pub struct PacketRequest {
    /// Complete length-prefixed SSH-agent packet.
    pub packet: Bytes,

    /// Channel used to return the final response.
    pub response: oneshot::Sender<Result<Bytes, RequestError>>,

    /// Cancelled when the local transport no longer needs the response.
    pub cancellation: CancellationToken,
}

/// Failure to admit or complete an SSH-agent packet request.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum RequestError {
    /// The request processor has stopped.
    #[error("the request processor is unavailable")]
    Unavailable,

    /// The configured pending-request limit has been reached.
    #[error("the pending request queue is full")]
    QueueFull,

    /// The request reached its original deadline.
    #[error("the request timed out")]
    TimedOut,

    /// The local caller no longer needs the request.
    #[error("the request was cancelled")]
    Cancelled,
}
