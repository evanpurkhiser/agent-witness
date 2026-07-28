use bytes::Bytes;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use thiserror::Error;
use uuid::Uuid;

use crate::broker::{RemoteCommand, RequestId, SessionId};

const VERSION: u8 = 1;
const MAX_LABEL_LENGTH: usize = 128;
const MAX_CREDENTIAL_LENGTH: usize = 128;

/// Reserved headroom for MessagePack field names and identifiers.
pub const MAX_MESSAGE_OVERHEAD: usize = 1024;

/// Messages accepted from a remote client.
#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    PairRequest {
        label: String,
    },
    Authenticate {
        #[serde(with = "uuid::serde::hyphenated")]
        client_id: Uuid,
        credential: Bytes,
    },
    AgentReady,
    AgentLocked,
    AgentResponse {
        #[serde(with = "uuid::serde::hyphenated")]
        request_id: RequestId,
        attempt: u32,
        packet: Bytes,
    },
    Pong,
}

impl ClientMessage {
    fn validate(&self) -> Result<(), ProtocolError> {
        match self {
            Self::PairRequest { label } if label.is_empty() || label.len() > MAX_LABEL_LENGTH => {
                Err(ProtocolError::InvalidMessage)
            }
            Self::Authenticate { credential, .. }
                if credential.is_empty() || credential.len() > MAX_CREDENTIAL_LENGTH =>
            {
                Err(ProtocolError::InvalidMessage)
            }
            _ => Ok(()),
        }
    }
}

/// Messages sent to a remote client.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Paired {
        #[serde(with = "uuid::serde::hyphenated")]
        server_id: Uuid,
        #[serde(with = "uuid::serde::hyphenated")]
        client_id: Uuid,
        credential: Bytes,
        #[serde(with = "uuid::serde::hyphenated")]
        session_id: SessionId,
    },
    Authenticated {
        #[serde(with = "uuid::serde::hyphenated")]
        server_id: Uuid,
        #[serde(with = "uuid::serde::hyphenated")]
        session_id: SessionId,
    },
    Rejected,
    AgentRequest {
        #[serde(with = "uuid::serde::hyphenated")]
        request_id: RequestId,
        attempt: u32,
        packet: Bytes,
    },
    CancelRequest {
        #[serde(with = "uuid::serde::hyphenated")]
        request_id: RequestId,
        attempt: u32,
    },
    Ping,
}

impl From<RemoteCommand> for ServerMessage {
    fn from(command: RemoteCommand) -> Self {
        match command {
            RemoteCommand::Request {
                request_id,
                attempt,
                packet,
            } => Self::AgentRequest {
                request_id,
                attempt,
                packet,
            },
            RemoteCommand::Cancel {
                request_id,
                attempt,
            } => Self::CancelRequest {
                request_id,
                attempt,
            },
        }
    }
}

#[derive(Deserialize, Serialize)]
struct Envelope<T> {
    version: u8,
    message: T,
}

/// Decode and validate one remote client message.
pub fn decode_client(frame: Bytes) -> Result<ClientMessage, ProtocolError> {
    let message: ClientMessage = decode(frame)?;
    message.validate()?;
    Ok(message)
}

/// Encode one remote server message.
pub fn encode_server(message: ServerMessage) -> Result<Bytes, ProtocolError> {
    encode(message)
}

fn encode<T: Serialize>(message: T) -> Result<Bytes, ProtocolError> {
    rmp_serde::to_vec_named(&Envelope {
        version: VERSION,
        message,
    })
    .map(Bytes::from)
    .map_err(ProtocolError::Encode)
}

fn decode<T: DeserializeOwned>(frame: Bytes) -> Result<T, ProtocolError> {
    let envelope: Envelope<T> = rmp_serde::from_slice(&frame).map_err(ProtocolError::Decode)?;
    if envelope.version != VERSION {
        return Err(ProtocolError::UnsupportedVersion(envelope.version));
    }

    Ok(envelope.message)
}

/// Failure to encode or decode a remote application message.
#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("unsupported remote protocol version {0}")]
    UnsupportedVersion(u8),

    #[error("remote protocol message is invalid")]
    InvalidMessage,

    #[error("could not decode remote protocol message")]
    Decode(#[source] rmp_serde::decode::Error),

    #[error("could not encode remote protocol message")]
    Encode(#[source] rmp_serde::encode::Error),
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;
    use uuid::Uuid;

    use super::{ClientMessage, ProtocolError, decode_client, encode};

    #[test]
    fn round_trips_pair_request() {
        let frame = encode(ClientMessage::PairRequest {
            label: "iPhone".into(),
        })
        .unwrap();

        assert_eq!(
            decode_client(frame).unwrap(),
            ClientMessage::PairRequest {
                label: "iPhone".into()
            }
        );
    }

    #[test]
    fn round_trips_authentication() {
        let client_id = Uuid::new_v4();
        let frame = encode(ClientMessage::Authenticate {
            client_id,
            credential: Bytes::from_static(b"credential"),
        })
        .unwrap();

        assert_eq!(
            decode_client(frame).unwrap(),
            ClientMessage::Authenticate {
                client_id,
                credential: Bytes::from_static(b"credential"),
            }
        );
    }

    #[test]
    fn round_trips_agent_response_without_inspecting_packet() {
        let request_id = Uuid::new_v4();
        let frame = encode(ClientMessage::AgentResponse {
            request_id,
            attempt: 4,
            packet: Bytes::from_static(b"\0\0\0\x01\x06"),
        })
        .unwrap();

        assert_eq!(
            decode_client(frame).unwrap(),
            ClientMessage::AgentResponse {
                request_id,
                attempt: 4,
                packet: Bytes::from_static(b"\0\0\0\x01\x06"),
            }
        );
    }

    #[test]
    fn rejects_an_unsupported_version() {
        let frame = rmp_serde::to_vec_named(&super::Envelope {
            version: 2,
            message: ClientMessage::AgentReady,
        })
        .unwrap();

        assert!(matches!(
            decode_client(Bytes::from(frame)),
            Err(ProtocolError::UnsupportedVersion(2))
        ));
    }
}
