use anyhow::{Context, bail};
use bytes::Bytes;
use serde::{Deserialize, Serialize, de::DeserializeOwned};

const VERSION: u8 = 1;
pub const MAX_FRAME_LENGTH: usize = 16 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlRequest {
    PairingClear,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlResponse {
    PairingCleared { had_client: bool },
    Error { message: String },
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Envelope<T> {
    version: u8,
    message: T,
}

pub fn encode<T: Serialize>(message: T) -> anyhow::Result<Bytes> {
    serde_json::to_vec(&Envelope {
        version: VERSION,
        message,
    })
    .map(Bytes::from)
    .context("could not encode control message")
}

pub fn decode<T: DeserializeOwned>(frame: &[u8]) -> anyhow::Result<T> {
    let envelope: Envelope<T> =
        serde_json::from_slice(frame).context("could not decode control message")?;
    if envelope.version != VERSION {
        bail!("unsupported control protocol version {}", envelope.version);
    }

    Ok(envelope.message)
}
