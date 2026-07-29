use axum::http::Uri;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bytes::Bytes;
use p256::PublicKey;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use thiserror::Error;
use uuid::Uuid;

use crate::broker::{RemoteCommand, RequestId, SessionId};

const VERSION: u8 = 1;
const MAX_LABEL_LENGTH: usize = 128;
const MAX_CREDENTIAL_LENGTH: usize = 128;
const MAX_PUSH_ENDPOINT_LENGTH: usize = 4096;
const P256DH_LENGTH: usize = 65;
const AUTH_SECRET_LENGTH: usize = 16;

/// Reserved headroom for non-packet fields, including push registration.
pub const MAX_MESSAGE_OVERHEAD: usize = 8 * 1024;

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
    SetPushSubscription {
        endpoint: String,
        expiration_time: Option<u64>,
        p256_dh: String,
        auth: String,
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
            Self::SetPushSubscription {
                endpoint,
                p256_dh,
                auth,
                ..
            } if !valid_push_endpoint(endpoint)
                || !valid_p256dh(p256_dh)
                || !valid_auth_secret(auth) =>
            {
                Err(ProtocolError::InvalidMessage)
            }
            _ => Ok(()),
        }
    }
}

fn valid_push_endpoint(endpoint: &str) -> bool {
    if endpoint.is_empty() || endpoint.len() > MAX_PUSH_ENDPOINT_LENGTH {
        return false;
    }

    endpoint
        .parse::<Uri>()
        .is_ok_and(|uri| uri.scheme_str() == Some("https") && uri.authority().is_some())
}

fn valid_p256dh(value: &str) -> bool {
    if value.len() > 128 {
        return false;
    }

    URL_SAFE_NO_PAD.decode(value).is_ok_and(|bytes| {
        bytes.len() == P256DH_LENGTH && PublicKey::from_sec1_bytes(&bytes).is_ok()
    })
}

fn valid_auth_secret(value: &str) -> bool {
    value.len() <= 64
        && URL_SAFE_NO_PAD
            .decode(value)
            .is_ok_and(|bytes| bytes.len() == AUTH_SECRET_LENGTH)
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
        vapid_public_key: Bytes,
    },
    Authenticated {
        #[serde(with = "uuid::serde::hyphenated")]
        server_id: Uuid,
        #[serde(with = "uuid::serde::hyphenated")]
        session_id: SessionId,
        vapid_public_key: Bytes,
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

    const P256DH: &str =
        "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
    const AUTH: &str = "AAECAwQFBgcICQoLDA0ODw";

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
    fn round_trips_a_valid_push_subscription() {
        let message = ClientMessage::SetPushSubscription {
            endpoint: "https://push.example.test/subscription".into(),
            expiration_time: Some(1_800_000_000_000),
            p256_dh: P256DH.into(),
            auth: AUTH.into(),
        };
        let frame = encode(&message).unwrap();

        assert_eq!(decode_client(frame).unwrap(), message);
    }

    #[test]
    fn rejects_invalid_push_subscription_fields() {
        for message in [
            ClientMessage::SetPushSubscription {
                endpoint: "http://push.example.test/subscription".into(),
                expiration_time: None,
                p256_dh: P256DH.into(),
                auth: AUTH.into(),
            },
            ClientMessage::SetPushSubscription {
                endpoint: "https://push.example.test/subscription".into(),
                expiration_time: None,
                p256_dh: "not-a-public-key".into(),
                auth: AUTH.into(),
            },
            ClientMessage::SetPushSubscription {
                endpoint: "https://push.example.test/subscription".into(),
                expiration_time: None,
                p256_dh: P256DH.into(),
                auth: "not-an-auth-secret".into(),
            },
        ] {
            assert!(matches!(
                decode_client(encode(message).unwrap()),
                Err(ProtocolError::InvalidMessage)
            ));
        }
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
