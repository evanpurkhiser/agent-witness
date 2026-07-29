//! Web Push key material and subscription delivery.

use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, bail};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use bytes::Bytes;
use p256::{SecretKey, elliptic_curve::sec1::ToEncodedPoint};
use serde::{Deserialize, Serialize};
use tokio::{sync::mpsc, time::timeout};
use tracing::{info, warn};
use web_push::{
    ContentEncoding, HyperWebPushClient, SubscriptionInfo, Urgency, VapidSignatureBuilder,
    WebPushClient, WebPushMessage, WebPushMessageBuilder,
};

use crate::remote::PairingService;

const PRIVATE_KEY_LENGTH: usize = 32;
const PRIVATE_KEY_MODE: u32 = 0o600;
const DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);
const NOTIFICATION_TITLE: &str = "SSH authentication requested";
const NOTIFICATION_BODY: &str = "A server is requesting SSH authentication.";

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

    fn encoded_private_key(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.private_key.to_bytes())
    }
}

/// Publishes coalesced wake requests to the paired browser's push service.
pub struct PushService {
    pairing: Arc<PairingService>,
    vapid: VapidKey,
    ttl: u32,
    client: HyperWebPushClient,
}

impl PushService {
    pub fn new(pairing: Arc<PairingService>, vapid: VapidKey, request_timeout: Duration) -> Self {
        Self {
            pairing,
            vapid,
            ttl: request_timeout.as_secs().try_into().unwrap_or(u32::MAX),
            client: HyperWebPushClient::new(),
        }
    }

    /// Deliver each coalesced wake edge without blocking the request broker.
    pub async fn serve(self, mut wakes: mpsc::UnboundedReceiver<()>) {
        while wakes.recv().await.is_some() {
            match self.publish().await {
                Ok(true) => info!("Web Push notification accepted"),
                Ok(false) => {}
                Err(error) => warn!(%error, "could not publish Web Push notification"),
            }
        }
    }

    async fn publish(&self) -> anyhow::Result<bool> {
        let Some(subscription) = self.pairing.push_subscription().await else {
            return Ok(false);
        };
        let message = build_notification(subscription, &self.vapid, self.ttl)?;

        timeout(DELIVERY_TIMEOUT, self.client.send(message))
            .await
            .context("Web Push delivery timed out")?
            .context("push service rejected notification")?;

        Ok(true)
    }
}

fn build_notification(
    subscription: PushSubscription,
    vapid: &VapidKey,
    ttl: u32,
) -> anyhow::Result<WebPushMessage> {
    let subscription = SubscriptionInfo::new(
        subscription.endpoint,
        subscription.p256dh,
        subscription.auth,
    );
    let signature = VapidSignatureBuilder::from_base64(&vapid.encoded_private_key(), &subscription)
        .context("could not create VAPID signature")?
        .build()
        .context("could not sign Web Push request")?;
    let payload = notification_payload()?;
    let mut message = WebPushMessageBuilder::new(&subscription);
    message.set_ttl(ttl);
    message.set_urgency(Urgency::High);
    message.set_payload(ContentEncoding::Aes128Gcm, &payload);
    message.set_vapid_signature(signature);

    message.build().context("could not build Web Push request")
}

fn notification_payload() -> anyhow::Result<Vec<u8>> {
    #[derive(Serialize)]
    struct Notification<'a> {
        title: &'a str,
        body: &'a str,
    }

    serde_json::to_vec(&Notification {
        title: NOTIFICATION_TITLE,
        body: NOTIFICATION_BODY,
    })
    .context("could not encode notification payload")
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

    use super::{
        NOTIFICATION_BODY, NOTIFICATION_TITLE, PRIVATE_KEY_LENGTH, PRIVATE_KEY_MODE,
        PushSubscription, Urgency, VapidKey, build_notification, generate, notification_payload,
    };

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

    #[test]
    fn builds_an_encrypted_notification_with_display_only_content() {
        let vapid = generate().unwrap();
        let message = build_notification(
            PushSubscription {
                endpoint: "https://push.example.test/subscription".into(),
                expiration_time: None,
                p256dh: "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU".into(),
                auth: "AAECAwQFBgcICQoLDA0ODw".into(),
            },
            &vapid,
            90,
        )
        .unwrap();

        assert_eq!(message.ttl, 90);
        assert_eq!(message.urgency, Some(Urgency::High));
        assert!(message.payload.is_some());
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&notification_payload().unwrap()).unwrap(),
            serde_json::json!({
                "title": NOTIFICATION_TITLE,
                "body": NOTIFICATION_BODY,
            })
        );
    }
}
