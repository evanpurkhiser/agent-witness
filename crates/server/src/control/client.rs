use std::path::Path;

use anyhow::{Context, bail};
use futures_util::{SinkExt, StreamExt};
use tokio::net::UnixStream;
use tokio_util::codec::LengthDelimitedCodec;

use super::protocol::{ControlRequest, ControlResponse, MAX_FRAME_LENGTH, decode, encode};

pub async fn clear_pairing(path: &Path) -> anyhow::Result<bool> {
    let stream = UnixStream::connect(path)
        .await
        .with_context(|| format!("could not connect to control socket {}", path.display()))?;
    let mut framed = LengthDelimitedCodec::builder()
        .max_frame_length(MAX_FRAME_LENGTH)
        .new_framed(stream);
    framed
        .send(encode(ControlRequest::PairingClear)?)
        .await
        .context("could not send control request")?;
    let frame = framed
        .next()
        .await
        .context("control server closed without a response")?
        .context("could not read control response")?;

    match decode(&frame)? {
        ControlResponse::PairingCleared { had_client } => Ok(had_client),
        ControlResponse::Error { message } => bail!("control server: {message}"),
    }
}
