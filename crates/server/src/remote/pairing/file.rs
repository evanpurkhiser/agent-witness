use std::{
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{PairingState, PairingStore, PairingStoreFuture};

const STATE_VERSION: u8 = 1;
const STATE_MODE: u32 = 0o600;

/// Pairing storage backed by an atomically replaced JSON file.
pub struct FilePairingStore {
    path: PathBuf,
}

impl FilePairingStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl PairingStore for FilePairingStore {
    fn load(&self) -> PairingStoreFuture<'_, Option<PairingState>> {
        Box::pin(async move {
            let path = self.path.clone();
            tokio::task::spawn_blocking(move || load(&path))
                .await
                .context("pairing state load task failed")?
        })
    }

    fn save<'a>(&'a self, state: &'a PairingState) -> PairingStoreFuture<'a, ()> {
        Box::pin(async move {
            let path = self.path.clone();
            let state = state.clone();
            tokio::task::spawn_blocking(move || save(&path, &state))
                .await
                .context("pairing state save task failed")?
        })
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredState {
    version: u8,
    server_id: Uuid,
    client: Option<super::PairedClient>,
}

impl From<PairingState> for StoredState {
    fn from(state: PairingState) -> Self {
        Self {
            version: STATE_VERSION,
            server_id: state.server_id,
            client: state.client,
        }
    }
}

impl TryFrom<StoredState> for PairingState {
    type Error = anyhow::Error;

    fn try_from(state: StoredState) -> Result<Self, Self::Error> {
        if state.version != STATE_VERSION {
            bail!("unsupported pairing state version {}", state.version);
        }

        Ok(Self {
            server_id: state.server_id,
            client: state.client,
        })
    }
}

fn load(path: &Path) -> anyhow::Result<Option<PairingState>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("could not read {}", path.display()));
        }
    };
    let metadata =
        fs::metadata(path).with_context(|| format!("could not inspect {}", path.display()))?;
    if metadata.mode() & 0o077 != 0 {
        bail!("pairing state {} must have mode 0600", path.display());
    }

    let state: StoredState = serde_json::from_slice(&bytes)
        .with_context(|| format!("could not decode {}", path.display()))?;
    Ok(Some(state.try_into()?))
}

fn save(path: &Path, state: &PairingState) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .context("pairing state path must have a parent directory")?;
    fs::create_dir_all(parent).with_context(|| format!("could not create {}", parent.display()))?;

    let name = path
        .file_name()
        .context("pairing state path must name a file")?
        .to_string_lossy();
    let temporary = parent.join(format!(".{name}.{}.tmp", Uuid::new_v4()));
    let result = write_and_replace(&temporary, path, state);
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_and_replace(temporary: &Path, path: &Path, state: &PairingState) -> anyhow::Result<()> {
    let bytes =
        serde_json::to_vec_pretty(&StoredState::from(state.clone())).context("encode state")?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(STATE_MODE)
        .open(temporary)
        .with_context(|| format!("could not create {}", temporary.display()))?;
    file.write_all(&bytes)
        .with_context(|| format!("could not write {}", temporary.display()))?;
    file.write_all(b"\n")
        .with_context(|| format!("could not finish {}", temporary.display()))?;
    file.sync_all()
        .with_context(|| format!("could not sync {}", temporary.display()))?;
    drop(file);

    fs::rename(temporary, path).with_context(|| format!("could not replace {}", path.display()))?;
    File::open(
        path.parent()
            .context("pairing state path must have a parent directory")?,
    )
    .and_then(|directory| directory.sync_all())
    .with_context(|| format!("could not sync parent of {}", path.display()))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{fs, os::unix::fs::MetadataExt, sync::Arc};

    use tempfile::tempdir;

    use super::{FilePairingStore, STATE_MODE};
    use crate::remote::pairing::{Authorization, AuthorizationError};
    use crate::{
        push::PushSubscription,
        remote::{PairingAuthority, PairingService, PairingStore},
    };

    #[tokio::test]
    async fn persists_pairing_and_push_subscription_across_service_instances() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("state.json");
        let first = PairingService::open(Arc::new(FilePairingStore::new(path.clone())))
            .await
            .unwrap();
        let Authorization::Paired {
            server_id,
            client_id,
            credential,
        } = first.pair("iPhone".into()).await.unwrap()
        else {
            panic!("expected new pairing")
        };
        let subscription = PushSubscription {
            endpoint: "https://push.example.test/subscription".into(),
            expiration_time: None,
            p256dh: "public-key".into(),
            auth: "auth-secret".into(),
        };
        assert!(matches!(
            first
                .set_push_subscription(uuid::Uuid::new_v4(), subscription.clone())
                .await,
            Err(AuthorizationError::Rejected)
        ));
        first
            .set_push_subscription(client_id, subscription.clone())
            .await
            .unwrap();

        let stored = FilePairingStore::new(path.clone())
            .load()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.client.unwrap().push_subscription, Some(subscription));

        let reopened = PairingService::open(Arc::new(FilePairingStore::new(path)))
            .await
            .unwrap();
        let Authorization::Authenticated {
            server_id: reopened_server_id,
            ..
        } = reopened.authenticate(client_id, credential).await.unwrap()
        else {
            panic!("expected authentication")
        };

        assert_eq!(reopened_server_id, server_id);
    }

    #[tokio::test]
    async fn creates_state_with_restrictive_permissions() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("state.json");
        PairingService::open(Arc::new(FilePairingStore::new(path.clone())))
            .await
            .unwrap();

        assert_eq!(fs::metadata(path).unwrap().mode() & 0o777, STATE_MODE);
    }

    #[tokio::test]
    async fn rejects_malformed_and_unsupported_state() {
        let directory = tempdir().unwrap();
        let malformed = directory.path().join("malformed.json");
        fs::write(&malformed, b"not json").unwrap();
        fs::set_permissions(
            &malformed,
            std::os::unix::fs::PermissionsExt::from_mode(0o600),
        )
        .unwrap();
        assert!(
            PairingService::open(Arc::new(FilePairingStore::new(malformed)))
                .await
                .is_err()
        );

        let unsupported = directory.path().join("unsupported.json");
        fs::write(
            &unsupported,
            br#"{"version":2,"server_id":"00000000-0000-0000-0000-000000000000","client":null}"#,
        )
        .unwrap();
        fs::set_permissions(
            &unsupported,
            std::os::unix::fs::PermissionsExt::from_mode(0o600),
        )
        .unwrap();
        assert!(
            PairingService::open(Arc::new(FilePairingStore::new(unsupported)))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn persists_only_the_credential_hash() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("state.json");
        let pairing = PairingService::open(Arc::new(FilePairingStore::new(path.clone())))
            .await
            .unwrap();
        let Authorization::Paired { credential, .. } = pairing.pair("iPhone".into()).await.unwrap()
        else {
            panic!("expected new pairing")
        };

        let stored: serde_json::Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        let client = stored["client"].as_object().unwrap();

        assert!(!client.contains_key("credential"));
        assert_eq!(
            client["credential_hash"].as_array().unwrap().len(),
            credential.len()
        );
        assert_eq!(credential.len(), 32);
    }
}
