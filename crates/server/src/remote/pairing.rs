use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

use bytes::Bytes;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use thiserror::Error;
use uuid::Uuid;

const CREDENTIAL_LENGTH: usize = 32;

/// Process-local first-client pairing used until durable state is implemented.
///
/// This type deliberately lives behind the session adapter boundary. Replacing
/// it with persistent pairing does not change WebSocket or broker behavior.
#[derive(Clone)]
pub struct EphemeralPairing {
    server_id: Uuid,
    state: Arc<Mutex<Option<PairedClient>>>,
}

impl EphemeralPairing {
    /// Create an unpaired authority with a new process-local server identity.
    pub fn new() -> Self {
        Self {
            server_id: Uuid::new_v4(),
            state: Arc::new(Mutex::new(None)),
        }
    }
}

impl PairingAuthority for EphemeralPairing {
    fn pair<'a>(&'a self, label: String) -> AuthorizationFuture<'a> {
        Box::pin(async move {
            let mut state = self.state.lock().expect("pairing mutex poisoned");
            if state.is_some() {
                return Err(AuthorizationError::AlreadyPaired);
            }

            let client_id = Uuid::new_v4();
            let mut credential = vec![0; CREDENTIAL_LENGTH];
            getrandom::fill(&mut credential)
                .map_err(|_| AuthorizationError::CredentialGeneration)?;
            *state = Some(PairedClient {
                client_id,
                credential_hash: Sha256::digest(&credential).into(),
                label,
            });

            Ok(Authorization::Paired {
                server_id: self.server_id,
                client_id,
                credential: Bytes::from(credential),
            })
        })
    }

    fn authenticate<'a>(&'a self, client_id: Uuid, credential: Bytes) -> AuthorizationFuture<'a> {
        Box::pin(async move {
            let state = self.state.lock().expect("pairing mutex poisoned");
            let Some(client) = state.as_ref() else {
                return Err(AuthorizationError::NotPaired);
            };
            let credential_hash: [u8; 32] = Sha256::digest(&credential).into();
            let matches_id = client.client_id == client_id;
            let matches_credential = bool::from(client.credential_hash.ct_eq(&credential_hash));

            if !matches_id || !matches_credential {
                return Err(AuthorizationError::Rejected);
            }

            Ok(Authorization::Authenticated {
                server_id: self.server_id,
            })
        })
    }
}

impl Default for EphemeralPairing {
    fn default() -> Self {
        Self::new()
    }
}

struct PairedClient {
    client_id: Uuid,
    credential_hash: [u8; 32],
    #[allow(dead_code)]
    label: String,
}

/// Successful authorization data needed to establish a remote session.
pub enum Authorization {
    /// The first client claimed the server and must retain its new credential.
    Paired {
        /// Stable server identity for this process.
        server_id: Uuid,

        /// Identity assigned to the paired client.
        client_id: Uuid,

        /// Secret presented only during the pairing response.
        credential: Bytes,
    },

    /// An existing client presented its assigned ID and credential.
    Authenticated {
        /// Stable server identity for this process.
        server_id: Uuid,
    },
}

/// Reason a remote handshake could not be authorized.
#[derive(Debug, Error)]
pub enum AuthorizationError {
    /// Another client already claimed the single pairing slot.
    #[error("a client is already paired")]
    AlreadyPaired,

    /// Authentication was attempted before the server was paired.
    #[error("the server is not paired")]
    NotPaired,

    /// The supplied client identity or credential did not match.
    #[error("the client credential was rejected")]
    Rejected,

    /// The operating system could not provide a random credential.
    #[error("could not generate a client credential")]
    CredentialGeneration,
}

/// Pairing boundary consumed by the WebSocket adapter.
///
/// Durable pairing can implement this interface without changing session
/// framing or broker translation.
pub trait PairingAuthority: Send + Sync {
    fn pair<'a>(&'a self, label: String) -> AuthorizationFuture<'a>;

    fn authenticate<'a>(&'a self, client_id: Uuid, credential: Bytes) -> AuthorizationFuture<'a>;
}

/// Asynchronous pairing decision returned by a [`PairingAuthority`].
pub type AuthorizationFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Authorization, AuthorizationError>> + Send + 'a>>;

#[cfg(test)]
mod tests {
    use super::{Authorization, AuthorizationError, EphemeralPairing, PairingAuthority};

    #[tokio::test]
    async fn first_client_pairs_and_can_authenticate_again() {
        let pairing = EphemeralPairing::new();
        let Authorization::Paired {
            client_id,
            credential,
            ..
        } = pairing.pair("iPhone".into()).await.unwrap()
        else {
            panic!("expected a new pairing")
        };

        assert!(matches!(
            pairing.authenticate(client_id, credential).await,
            Ok(Authorization::Authenticated { .. })
        ));
    }

    #[tokio::test]
    async fn pairing_slot_can_only_be_claimed_once() {
        let pairing = EphemeralPairing::new();
        pairing.pair("first".into()).await.unwrap();

        assert!(matches!(
            pairing.pair("second".into()).await,
            Err(AuthorizationError::AlreadyPaired)
        ));
    }
}
