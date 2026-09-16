use std::{path::Path, time::Duration};

use anyhow::{Context, ensure};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
    time::timeout,
};

use crate::{packet::RequestContext, request_router::context};

/// Send one context extension and wait for its acknowledgement before disconnecting.
pub(crate) async fn send(socket: &Path, context: &RequestContext) -> anyhow::Result<()> {
    let packet = context::encode(context)?;
    timeout(Duration::from_secs(10), async {
        let mut stream = UnixStream::connect(socket)
            .await
            .with_context(|| format!("could not connect to {}", socket.display()))?;
        stream
            .write_all(&packet)
            .await
            .context("could not send request context")?;

        let mut length = [0; 4];
        stream
            .read_exact(&mut length)
            .await
            .context("could not read context response length")?;
        ensure!(
            u32::from_be_bytes(length) == 1,
            "invalid context response length"
        );
        let status = stream
            .read_u8()
            .await
            .context("could not read context response status")?;
        ensure!(
            status == 6,
            "agent rejected request context (status {status})"
        );
        Ok(())
    })
    .await
    .context("timed out sending request context")?
}

#[cfg(test)]
mod tests {
    use tokio::net::UnixListener;

    use super::*;

    #[tokio::test]
    async fn sends_context_and_checks_acknowledgement() {
        for status in [6, 5, 28] {
            let directory = tempfile::tempdir().unwrap();
            let socket = directory.path().join("agent.sock");
            let listener = UnixListener::bind(&socket).unwrap();
            let context = RequestContext {
                group_id: "d371fa50-458a-4191-8893-d00139c781a2".parse().unwrap(),
                reason: "Push the release".into(),
                command: vec!["git".into(), "push".into(), "--all".into()],
            };
            let expected = context::encode(&context).unwrap();
            let server = async {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut packet = vec![0; expected.len()];
                stream.read_exact(&mut packet).await.unwrap();
                assert_eq!(packet, expected);
                stream.write_all(&[0, 0, 0, 1, status]).await.unwrap();
            };
            let (result, ()) = tokio::join!(send(&socket, &context), server);
            assert_eq!(result.is_ok(), status == 6);
        }
    }
}
