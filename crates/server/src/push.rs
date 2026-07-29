//! Web Push key material and, eventually, subscription delivery.

use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

use anyhow::{Context, bail};
use bytes::Bytes;
use p256::{SecretKey, elliptic_curve::sec1::ToEncodedPoint};
use serde::{Deserialize, Serialize};

const PRIVATE_KEY_LENGTH: usize = 32;
const PRIVATE_KEY_MODE: u32 = 0o600;

/// Browser-generated values required to encrypt and deliver a Web Push message.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PushSubscription {
    pub endpoint: String,
    pub expiration_time: Option<u64>,
    pub p256dh: String,
    pub auth: String,
}

/// Persistent P-256 application-server identity used by VAPID.
pub struct VapidKey {
    private_key: SecretKey,
}

impl VapidKey {
    /// Load the configured key or create it with restrictive permissions.
    pub async fn open(path: PathBuf) -> anyhow::Result<Self> {
        tokio::task::spawn_blocking(move || open(&path))
            .await
            .context("VAPID key load task failed")?
    }

    /// Return the uncompressed P-256 public key required by PushManager.
    pub fn public_key(&self) -> Bytes {
        let public_key = self.private_key.public_key().to_encoded_point(false);
        Bytes::copy_from_slice(public_key.as_bytes())
    }
}

fn open(path: &Path) -> anyhow::Result<VapidKey> {
    if let Some(key) = load(path)? {
        return Ok(key);
    }

    create(path)
}

fn load(path: &Path) -> anyhow::Result<Option<VapidKey>> {
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
        bail!("VAPID private key {} must have mode 0600", path.display());
    }

    decode(&bytes)
        .map(Some)
        .with_context(|| format!("could not decode {}", path.display()))
}

fn create(path: &Path) -> anyhow::Result<VapidKey> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .context("VAPID private key path must have a parent directory")?;
    fs::create_dir_all(parent).with_context(|| format!("could not create {}", parent.display()))?;

    let key = generate()?;
    let mut file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(PRIVATE_KEY_MODE)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            return load(path)?.context("VAPID private key disappeared while opening");
        }
        Err(error) => {
            return Err(error).with_context(|| format!("could not create {}", path.display()));
        }
    };
    let result = file
        .write_all(key.private_key.to_bytes().as_ref())
        .and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = result {
        let _ = fs::remove_file(path);
        return Err(error).with_context(|| format!("could not persist {}", path.display()));
    }
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .with_context(|| format!("could not sync parent of {}", path.display()))?;

    Ok(key)
}

fn generate() -> anyhow::Result<VapidKey> {
    loop {
        let mut bytes = [0; PRIVATE_KEY_LENGTH];
        getrandom::fill(&mut bytes).map_err(|_| anyhow::anyhow!("could not generate VAPID key"))?;
        if let Ok(private_key) = SecretKey::from_slice(&bytes) {
            return Ok(VapidKey { private_key });
        }
    }
}

fn decode(bytes: &[u8]) -> anyhow::Result<VapidKey> {
    if bytes.len() != PRIVATE_KEY_LENGTH {
        bail!("expected a {PRIVATE_KEY_LENGTH}-byte P-256 private scalar");
    }

    let private_key = SecretKey::from_slice(bytes)
        .map_err(|_| anyhow::anyhow!("invalid P-256 private scalar"))?;
    Ok(VapidKey { private_key })
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::fs::{MetadataExt, PermissionsExt},
    };

    use tempfile::tempdir;

    use super::{PRIVATE_KEY_LENGTH, PRIVATE_KEY_MODE, VapidKey};

    #[tokio::test]
    async fn creates_and_reopens_a_restrictive_key_file() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("vapid.key");

        let first = VapidKey::open(path.clone()).await.unwrap();
        let reopened = VapidKey::open(path.clone()).await.unwrap();

        assert_eq!(first.public_key(), reopened.public_key());
        assert_eq!(first.public_key().len(), 65);
        assert_eq!(first.public_key()[0], 4);
        assert_eq!(fs::read(&path).unwrap().len(), PRIVATE_KEY_LENGTH);
        assert_eq!(fs::metadata(path).unwrap().mode() & 0o777, PRIVATE_KEY_MODE);
    }

    #[tokio::test]
    async fn rejects_permissive_and_malformed_key_files() {
        let directory = tempdir().unwrap();
        let permissive = directory.path().join("permissive.key");
        fs::write(&permissive, [1; PRIVATE_KEY_LENGTH]).unwrap();
        fs::set_permissions(&permissive, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(VapidKey::open(permissive).await.is_err());

        let malformed = directory.path().join("malformed.key");
        fs::write(&malformed, [1; PRIVATE_KEY_LENGTH - 1]).unwrap();
        fs::set_permissions(&malformed, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(VapidKey::open(malformed).await.is_err());

        let invalid = directory.path().join("invalid.key");
        fs::write(&invalid, [0; PRIVATE_KEY_LENGTH]).unwrap();
        fs::set_permissions(&invalid, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(VapidKey::open(invalid).await.is_err());
    }
}
