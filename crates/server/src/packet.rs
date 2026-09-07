//! Transport-neutral request and response types for SSH-agent packets.

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use ssh_agent_lib::{
    proto::{Identity, PublicCredential, Request, Response},
    ssh_encoding::{Decode, Encode},
};
use thiserror::Error;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

const OPENSSH_SESSION_BIND_EXTENSION: &[u8] = b"session-bind@openssh.com";

/// Public key metadata needed to construct an SSH-agent identities answer.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AgentIdentity {
    pub key_blob: Bytes,
    pub comment: String,
}

/// Return whether a complete packet is an SSH-agent identity-list request.
pub fn is_identity_request(packet: &[u8]) -> bool {
    let Some(mut payload) = packet_payload(packet) else {
        return false;
    };

    matches!(
        Request::decode(&mut payload),
        Ok(Request::RequestIdentities)
    ) && payload.is_empty()
}

/// Return whether a complete packet is OpenSSH's session-binding extension.
pub fn is_openssh_session_bind_request(packet: &[u8]) -> bool {
    let Some(payload) = packet_payload(packet) else {
        return false;
    };
    let Some((&27, extension)) = payload.split_first() else {
        return false;
    };
    let Some(name) = ssh_string(extension) else {
        return false;
    };

    name == OPENSSH_SESSION_BIND_EXTENSION
}

/// Encode a complete SSH-agent identities answer from public metadata.
pub fn identities_answer(identities: &[AgentIdentity]) -> Result<Bytes, IdentityError> {
    let response = identities_response(identities)?;
    let payload_length = response_payload_length(&response)?;
    let mut packet = Vec::with_capacity(payload_length as usize + 4);
    packet.extend_from_slice(&payload_length.to_be_bytes());
    response
        .encode(&mut packet)
        .map_err(|_| IdentityError::TooLarge)?;

    Ok(packet.into())
}

/// Validate public identity metadata without retaining an encoded answer.
pub fn validate_identities(identities: &[AgentIdentity]) -> Result<(), IdentityError> {
    let response = identities_response(identities)?;
    response_payload_length(&response)?;

    Ok(())
}

fn identities_response(identities: &[AgentIdentity]) -> Result<Response, IdentityError> {
    let identities = identities
        .iter()
        .map(|identity| {
            let mut key_blob = identity.key_blob.as_ref();
            let credential =
                PublicCredential::decode(&mut key_blob).map_err(|_| IdentityError::InvalidKey)?;
            if !key_blob.is_empty() {
                return Err(IdentityError::InvalidKey);
            }

            Ok(Identity {
                credential,
                comment: identity.comment.clone(),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Response::IdentitiesAnswer(identities))
}

fn response_payload_length(response: &Response) -> Result<u32, IdentityError> {
    response
        .encoded_len()
        .map_err(|_| IdentityError::TooLarge)?
        .try_into()
        .map_err(|_| IdentityError::TooLarge)
}

fn packet_payload(packet: &[u8]) -> Option<&[u8]> {
    let length = u32::from_be_bytes(packet.get(..4)?.try_into().ok()?) as usize;
    let payload = packet.get(4..)?;

    (payload.len() == length).then_some(payload)
}

fn ssh_string(value: &[u8]) -> Option<&[u8]> {
    let length = u32::from_be_bytes(value.get(..4)?.try_into().ok()?) as usize;
    value.get(4..4 + length)
}

/// Invalid public identity metadata supplied by the paired client.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum IdentityError {
    #[error("identity contains an invalid SSH public key")]
    InvalidKey,

    #[error("identity answer is too large")]
    TooLarge,
}

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

#[cfg(test)]
mod tests {
    use super::{
        AgentIdentity, identities_answer, is_identity_request, is_openssh_session_bind_request,
    };
    use bytes::Bytes;

    #[test]
    fn recognizes_only_complete_identity_requests() {
        assert!(is_identity_request(&[0, 0, 0, 1, 11]));
        assert!(!is_identity_request(&[0, 0, 0, 1, 13]));
        assert!(!is_identity_request(&[0, 0, 0, 2, 11]));
        assert!(!is_identity_request(&[0, 0, 0, 2, 11, 0]));
    }

    #[test]
    fn recognizes_openssh_session_binding_extensions() {
        let packet = extension_packet("session-bind@openssh.com", b"binding evidence");

        assert!(is_openssh_session_bind_request(&packet));
        assert!(!is_openssh_session_bind_request(&extension_packet(
            "query@openssh.com",
            b""
        )));
        assert!(!is_openssh_session_bind_request(
            &packet[..packet.len() - 1]
        ));
    }

    #[test]
    fn builds_a_framed_identities_answer() {
        let answer = identities_answer(&[AgentIdentity {
            key_blob: ed25519_blob(),
            comment: "phone key".into(),
        }])
        .unwrap();

        assert_eq!(&answer[..4], &(answer.len() as u32 - 4).to_be_bytes());
        assert_eq!(answer[4], 12);
        assert_eq!(&answer[5..9], &1_u32.to_be_bytes());
    }

    #[test]
    fn rejects_invalid_public_keys() {
        assert!(
            identities_answer(&[AgentIdentity {
                key_blob: Bytes::from_static(b"not an SSH public key"),
                comment: String::new(),
            }])
            .is_err()
        );
    }

    fn ed25519_blob() -> Bytes {
        let algorithm = b"ssh-ed25519";
        let mut blob = Vec::new();
        blob.extend_from_slice(&(algorithm.len() as u32).to_be_bytes());
        blob.extend_from_slice(algorithm);
        blob.extend_from_slice(&32_u32.to_be_bytes());
        blob.extend_from_slice(&[7; 32]);
        blob.into()
    }

    fn extension_packet(name: &str, contents: &[u8]) -> Vec<u8> {
        let payload_length = 1 + 4 + name.len() + contents.len();
        let mut packet = Vec::with_capacity(payload_length + 4);
        packet.extend_from_slice(&(payload_length as u32).to_be_bytes());
        packet.push(27);
        packet.extend_from_slice(&(name.len() as u32).to_be_bytes());
        packet.extend_from_slice(name.as_bytes());
        packet.extend_from_slice(contents);
        packet
    }
}
