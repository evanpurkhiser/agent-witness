//! Local SSH-agent socket lifecycle and packet transport.

use std::{io, path::PathBuf};

use thiserror::Error;
use tokio::{net::UnixListener, sync::mpsc};
use tokio_util::sync::CancellationToken;

use crate::packet::PacketRequest;

use self::file::SocketFile;

mod file;
mod listener;

/// Bound SSH-agent listener and ownership guard for its filesystem entry.
pub struct AgentSocket {
    listener: UnixListener,
    file: SocketFile,
    max_packet_size: usize,
}

impl AgentSocket {
    /// Safely claim a filesystem path and bind the local SSH-agent listener.
    pub async fn bind(
        path: PathBuf,
        mode: u32,
        max_packet_size: usize,
    ) -> Result<Self, AgentSocketError> {
        let (file, listener) = SocketFile::bind(path, mode).await?;

        Ok(Self {
            listener,
            file,
            max_packet_size,
        })
    }

    /// Serve local connections until shutdown while retaining ownership of the socket file.
    pub async fn serve(
        self,
        requests: mpsc::Sender<PacketRequest>,
        shutdown: CancellationToken,
    ) -> Result<(), AgentSocketError> {
        listener::serve(
            &self.listener,
            self.file.path(),
            requests,
            shutdown,
            self.max_packet_size,
        )
        .await
    }
}

/// Filesystem path and underlying I/O failure for a socket operation.
#[derive(Debug, Error)]
#[error("{}", path.display())]
pub struct PathIoError {
    path: PathBuf,

    #[source]
    source: io::Error,
}

impl PathIoError {
    /// Associate an underlying I/O failure with the path being operated on.
    fn new(path: PathBuf, source: io::Error) -> Self {
        Self { path, source }
    }
}

#[derive(Debug, Error)]
pub enum AgentSocketError {
    #[error("the SSH-agent socket parent directory does not exist: {0}")]
    MissingParent(PathBuf),

    #[error("refusing to replace a non-socket file at {0}")]
    NotSocket(PathBuf),

    #[error("another SSH-agent server is already listening at {0}")]
    AlreadyActive(PathBuf),

    #[error("could not determine whether SSH-agent socket {0} is active")]
    Probe(#[source] PathIoError),

    #[error("the SSH-agent socket changed while checking whether it was stale: {0}")]
    Changed(PathBuf),

    #[error("could not inspect SSH-agent socket {0}")]
    Metadata(#[source] PathIoError),

    #[error("could not remove stale SSH-agent socket {0}")]
    RemoveStale(#[source] PathIoError),

    #[error("could not bind SSH-agent socket {0}")]
    Bind(#[source] PathIoError),

    #[error("could not set permissions on SSH-agent socket {0}")]
    Permissions(#[source] PathIoError),

    #[error("could not accept an SSH-agent connection")]
    Accept(#[source] io::Error),
}
