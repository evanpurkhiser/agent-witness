use std::{io, path::Path};

use bytes::Bytes;
use futures_util::StreamExt;
use tokio::{
    io::AsyncWriteExt,
    net::{UnixListener, UnixStream},
    sync::{mpsc, oneshot},
    task::JoinSet,
};
use tokio_util::{codec::LengthDelimitedCodec, sync::CancellationToken};
use tracing::{debug, info, warn};

use crate::packet::{PacketRequest, RequestError};

use super::AgentSocketError;

const AGENT_FAILURE_FRAME: &[u8] = &[0, 0, 0, 1, 5];

/// Accept connections until shutdown and supervise their packet-processing tasks.
pub(super) async fn serve(
    listener: &UnixListener,
    path: &Path,
    requests: mpsc::Sender<PacketRequest>,
    shutdown: CancellationToken,
    max_packet_size: usize,
) -> Result<(), AgentSocketError> {
    info!(path = %path.display(), "SSH-agent socket listening");
    let mut connections = JoinSet::new();

    loop {
        tokio::select! {
            () = shutdown.cancelled() => break,
            accepted = listener.accept() => {
                let (stream, _) = accepted.map_err(AgentSocketError::Accept)?;
                let requests = requests.clone();
                connections.spawn(async move {
                    if let Err(error) = handle_connection(stream, requests, max_packet_size).await {
                        debug!(%error, "SSH-agent connection closed with an error");
                    }
                });
            }
            Some(result) = connections.join_next(), if !connections.is_empty() => {
                if let Err(error) = result {
                    warn!(%error, "SSH-agent connection task failed");
                }
            }
        }
    }

    connections.abort_all();
    while connections.join_next().await.is_some() {}
    Ok(())
}

/// Forward bounded packets sequentially between one Unix client and the processor.
async fn handle_connection(
    stream: UnixStream,
    requests: mpsc::Sender<PacketRequest>,
    max_packet_size: usize,
) -> io::Result<()> {
    let cancellation = CancellationToken::new();
    let _cancel_on_drop = cancellation.clone().drop_guard();
    let (reader, mut writer) = stream.into_split();
    let mut frames = LengthDelimitedCodec::builder()
        .big_endian()
        .length_field_type::<u32>()
        .length_adjustment(4)
        .num_skip(0)
        .max_frame_length(max_packet_size + 4)
        .new_read(reader);

    while let Some(frame) = frames.next().await {
        let response = match frame {
            Ok(packet) => submit(&requests, packet.freeze(), cancellation.child_token())
                .await
                .unwrap_or_else(|error| {
                    debug!(%error, "SSH-agent request failed");
                    Bytes::from_static(AGENT_FAILURE_FRAME)
                }),
            Err(error) => {
                warn!(%error, "rejecting malformed or oversized SSH-agent packet");
                writer.write_all(AGENT_FAILURE_FRAME).await?;
                return Ok(());
            }
        };

        writer.write_all(&response).await?;
    }

    Ok(())
}

/// Submit one complete packet and await its processor response.
async fn submit(
    requests: &mpsc::Sender<PacketRequest>,
    packet: Bytes,
    cancellation: CancellationToken,
) -> Result<Bytes, RequestError> {
    let (response, receiver) = oneshot::channel();
    requests
        .send(PacketRequest {
            packet,
            response,
            cancellation,
        })
        .await
        .map_err(|_| RequestError::Unavailable)?;

    receiver.await.unwrap_or(Err(RequestError::Unavailable))
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;
    use tempfile::tempdir;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::UnixStream,
        sync::mpsc,
    };
    use tokio_util::sync::CancellationToken;

    use crate::packet::RequestError;

    use super::{super::AgentSocket, AGENT_FAILURE_FRAME};

    #[tokio::test]
    async fn serves_a_valid_failure_when_the_processor_rejects_a_request() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("agent.sock");
        let socket = AgentSocket::bind(path.clone(), 0o600, 1024).await.unwrap();
        let (requests, mut incoming) = mpsc::channel(1);
        let shutdown = CancellationToken::new();
        let server_task = tokio::spawn(socket.serve(requests, shutdown.clone()));
        let processor_task = tokio::spawn(async move {
            let request = incoming.recv().await.unwrap();
            request.response.send(Err(RequestError::TimedOut)).unwrap();
        });

        let mut client = UnixStream::connect(&path).await.unwrap();
        client.write_all(&[0, 0, 0, 1, 11]).await.unwrap();
        let mut response = [0; 5];
        client.read_exact(&mut response).await.unwrap();

        assert_eq!(response, AGENT_FAILURE_FRAME);
        processor_task.await.unwrap();

        shutdown.cancel();
        server_task.await.unwrap().unwrap();
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn cancels_requests_when_the_connection_task_stops() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("agent.sock");
        let socket = AgentSocket::bind(path.clone(), 0o600, 1024).await.unwrap();
        let (requests, mut incoming) = mpsc::channel(1);
        let shutdown = CancellationToken::new();
        let server_task = tokio::spawn(socket.serve(requests, shutdown.clone()));

        let mut client = UnixStream::connect(&path).await.unwrap();
        client.write_all(&[0, 0, 0, 1, 11]).await.unwrap();
        let request = incoming.recv().await.unwrap();
        assert!(!request.cancellation.is_cancelled());

        shutdown.cancel();
        server_task.await.unwrap().unwrap();

        assert!(request.cancellation.is_cancelled());
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn forwards_complete_frames_without_interpreting_them() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("agent.sock");
        let socket = AgentSocket::bind(path.clone(), 0o600, 1024).await.unwrap();
        let (requests, mut incoming) = mpsc::channel(1);
        let shutdown = CancellationToken::new();
        let server_task = tokio::spawn(socket.serve(requests, shutdown.clone()));

        let request = [0, 0, 0, 1, 11];
        let response = [0, 0, 0, 2, 12, 34];
        let processor_task = tokio::spawn(async move {
            let local_request = incoming.recv().await.unwrap();
            assert_eq!(local_request.packet.as_ref(), request);
            local_request
                .response
                .send(Ok(Bytes::copy_from_slice(&response)))
                .unwrap();
        });

        let mut client = UnixStream::connect(&path).await.unwrap();
        client.write_all(&request).await.unwrap();
        let mut received = [0; 6];
        client.read_exact(&mut received).await.unwrap();
        assert_eq!(received, response);
        processor_task.await.unwrap();

        shutdown.cancel();
        server_task.await.unwrap().unwrap();
    }
}
