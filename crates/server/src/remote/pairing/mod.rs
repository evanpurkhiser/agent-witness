use std::{
    future::Future,
    pin::Pin,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use thiserror::Error;
use tokio::sync::{Mutex, watch};
use uuid::Uuid;

use crate::push::PushSubscription;

const CREDENTIAL_LENGTH: usize = 32;

mod file;
mod memory;

pub use file::FilePairingStore;
pub use memory::MemoryPairingStore;

/// Complete pairing state owned by a [`PairingStore`].
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PairingState {
    pub(crate) server_id: Uuid,
    pub(crate) client: Option<PairedClient>,
}

impl PairingState {
    fn unpaired() -> Self {
        Self {
            server_id: Uuid::new_v4(),
            client: None,
        }
    }
}

/// The single client authorized to connect to this server.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PairedClient {
    pub(crate) client_id: Uuid,
    pub(crate) credential_hash: [u8; 32],
    pub(crate) label: String,
    pub(crate) created_at: u64,
    pub(crate) last_seen_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) push_subscription: Option<PushSubscription>,
}

/// Asynchronous operation performed by a pairing store.
pub type PairingStoreFuture<'a, T> = Pin<Box<dyn Future<Output = anyhow::Result<T>> + Send + 'a>>;

/// Storage boundary used by pairing policy.
pub trait PairingStore: Send + Sync {
    /// Load the current state, returning `None` for a new store.
    fn load(&self) -> PairingStoreFuture<'_, Option<PairingState>>;

    /// Replace the current state.
    fn save<'a>(&'a self, state: &'a PairingState) -> PairingStoreFuture<'a, ()>;
}

/// First-client pairing and authentication policy shared by all stores.
#[derive(Clone)]
pub struct PairingService {
    store: Arc<dyn PairingStore>,
    state: Arc<Mutex<PairingState>>,
    revocations: watch::Sender<u64>,
}

impl PairingService {
    /// Load existing state or initialize and save a new server identity.
    pub async fn open(store: Arc<dyn PairingStore>) -> anyhow::Result<Self> {
        let state = match store.load().await? {
            Some(state) => state,
            None => {
                let state = PairingState::unpaired();
                store.save(&state).await?;
                state
            }
        };

        let (revocations, _) = watch::channel(0);

        Ok(Self {
            store,
            state: Arc::new(Mutex::new(state)),
            revocations,
        })
    }

    /// Persist an unpaired state and revoke the active remote session.
    pub async fn clear(&self) -> anyhow::Result<bool> {
        let mut state = self.state.lock().await;
        if state.client.is_none() {
            return Ok(false);
        }

        let next = PairingState {
            server_id: state.server_id,
            client: None,
        };
        self.store.save(&next).await?;
        *state = next;
        self.revocations.send_modify(|generation| *generation += 1);

        Ok(true)
    }

    /// Return the currently registered Web Push subscription, if any.
    pub(crate) async fn push_subscription(&self) -> Option<PushSubscription> {
        self.state
            .lock()
            .await
            .client
            .as_ref()
            .and_then(|client| client.push_subscription.clone())
    }
}

impl PairingAuthority for PairingService {
    fn pair<'a>(&'a self, label: String) -> AuthorizationFuture<'a> {
        Box::pin(async move {
            let mut state = self.state.lock().await;
            if state.client.is_some() {
                return Err(AuthorizationError::AlreadyPaired);
            }

            let client_id = Uuid::new_v4();
            let mut credential = vec![0; CREDENTIAL_LENGTH];
            getrandom::fill(&mut credential)
                .map_err(|_| AuthorizationError::CredentialGeneration)?;
            let next = PairingState {
                server_id: state.server_id,
                client: Some(PairedClient {
                    client_id,
                    credential_hash: Sha256::digest(&credential).into(),
                    label,
                    created_at: now(),
                    last_seen_at: None,
                    push_subscription: None,
                }),
            };
            self.store
                .save(&next)
                .await
                .map_err(AuthorizationError::Storage)?;
            *state = next;

            Ok(Authorization::Paired {
                server_id: state.server_id,
                client_id,
                credential: Bytes::from(credential),
            })
        })
    }

    fn authenticate<'a>(&'a self, client_id: Uuid, credential: Bytes) -> AuthorizationFuture<'a> {
        Box::pin(async move {
            let mut state = self.state.lock().await;
            let Some(client) = state.client.as_ref() else {
                return Err(AuthorizationError::NotPaired);
            };
            let credential_hash: [u8; 32] = Sha256::digest(&credential).into();
            let matches_id = client.client_id == client_id;
            let matches_credential = bool::from(client.credential_hash.ct_eq(&credential_hash));

            if !matches_id || !matches_credential {
                return Err(AuthorizationError::Rejected);
            }

            let mut next = state.clone();
            next.client
                .as_mut()
                .expect("paired client disappeared")
                .last_seen_at = Some(now());
            self.store
                .save(&next)
                .await
                .map_err(AuthorizationError::Storage)?;
            *state = next;

            Ok(Authorization::Authenticated {
                server_id: state.server_id,
                client_id,
            })
        })
    }

    fn set_push_subscription<'a>(
        &'a self,
        client_id: Uuid,
        subscription: PushSubscription,
    ) -> PairingUpdateFuture<'a> {
        Box::pin(async move {
            let mut state = self.state.lock().await;
            let Some(client) = state.client.as_ref() else {
                return Err(AuthorizationError::NotPaired);
            };
            if client.client_id != client_id {
                return Err(AuthorizationError::Rejected);
            }

            let mut next = state.clone();
            next.client
                .as_mut()
                .expect("paired client disappeared")
                .push_subscription = Some(subscription);
            self.store
                .save(&next)
                .await
                .map_err(AuthorizationError::Storage)?;
            *state = next;

            Ok(())
        })
    }

    fn subscribe_revocations(&self) -> watch::Receiver<u64> {
        self.revocations.subscribe()
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Successful authorization data needed to establish a remote session.
pub enum Authorization {
    /// The first client claimed the server and must retain its new credential.
    Paired {
        /// Stable server identity for this store.
        server_id: Uuid,

        /// Identity assigned to the paired client.
        client_id: Uuid,

        /// Secret presented only during the pairing response.
        credential: Bytes,
    },

    /// An existing client presented its assigned ID and credential.
    Authenticated {
        /// Stable server identity for this store.
        server_id: Uuid,

        /// Identity whose credential authorized the session.
        client_id: Uuid,
    },
}

impl Authorization {
    pub(crate) fn client_id(&self) -> Uuid {
        match self {
            Self::Paired { client_id, .. } | Self::Authenticated { client_id, .. } => *client_id,
        }
    }
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

    /// The pairing state could not be saved.
    #[error("could not save pairing state")]
    Storage(#[source] anyhow::Error),
}

/// Pairing boundary consumed by the WebSocket adapter.
pub trait PairingAuthority: Send + Sync {
    fn pair<'a>(&'a self, label: String) -> AuthorizationFuture<'a>;

    fn authenticate<'a>(&'a self, client_id: Uuid, credential: Bytes) -> AuthorizationFuture<'a>;

    fn set_push_subscription<'a>(
        &'a self,
        client_id: Uuid,
        subscription: PushSubscription,
    ) -> PairingUpdateFuture<'a>;

    fn subscribe_revocations(&self) -> watch::Receiver<u64>;
}

/// Asynchronous pairing decision returned by a [`PairingAuthority`].
pub type AuthorizationFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Authorization, AuthorizationError>> + Send + 'a>>;

/// Asynchronous authenticated update returned by a [`PairingAuthority`].
pub type PairingUpdateFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), AuthorizationError>> + Send + 'a>>;

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{
        Authorization, AuthorizationError, MemoryPairingStore, PairingAuthority, PairingService,
    };

    #[tokio::test]
    async fn first_client_pairs_and_can_authenticate_again() {
        let pairing = PairingService::open(Arc::new(MemoryPairingStore::new()))
            .await
            .unwrap();
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
        let pairing = PairingService::open(Arc::new(MemoryPairingStore::new()))
            .await
            .unwrap();
        pairing.pair("first".into()).await.unwrap();

        assert!(matches!(
            pairing.pair("second".into()).await,
            Err(AuthorizationError::AlreadyPaired)
        ));
    }

    #[tokio::test]
    async fn state_survives_reopening_the_service() {
        let store = Arc::new(MemoryPairingStore::new());
        let first = PairingService::open(store.clone()).await.unwrap();
        let Authorization::Paired {
            server_id,
            client_id,
            credential,
        } = first.pair("iPhone".into()).await.unwrap()
        else {
            panic!("expected a new pairing")
        };

        let reopened = PairingService::open(store).await.unwrap();
        let Authorization::Authenticated {
            server_id: authenticated_server_id,
            ..
        } = reopened.authenticate(client_id, credential).await.unwrap()
        else {
            panic!("expected authentication")
        };

        assert_eq!(authenticated_server_id, server_id);
    }

    #[tokio::test]
    async fn clearing_pairing_persists_and_revokes_the_session() {
        let store = Arc::new(MemoryPairingStore::new());
        let pairing = PairingService::open(store.clone()).await.unwrap();
        let mut revocations = pairing.subscribe_revocations();
        pairing.pair("iPhone".into()).await.unwrap();

        assert!(pairing.clear().await.unwrap());
        revocations.changed().await.unwrap();
        assert!(!pairing.clear().await.unwrap());

        let reopened = PairingService::open(store).await.unwrap();
        assert!(matches!(
            reopened
                .authenticate(
                    uuid::Uuid::new_v4(),
                    bytes::Bytes::from_static(b"credential")
                )
                .await,
            Err(AuthorizationError::NotPaired)
        ));
        assert!(reopened.pair("replacement".into()).await.is_ok());
    }
}
