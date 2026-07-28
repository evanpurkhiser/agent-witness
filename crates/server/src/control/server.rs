use std::{
    fs, io,
    os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, bail};
use futures_util::{SinkExt, StreamExt};
use tokio::{
    net::{UnixListener, UnixStream},
    task::JoinSet,
};
use tokio_util::{codec::LengthDelimitedCodec, sync::CancellationToken};
use tracing::{debug, info, warn};

use crate::remote::PairingService;

use super::protocol::{ControlRequest, ControlResponse, MAX_FRAME_LENGTH, decode, encode};

pub struct ControlSocket {
    listener: UnixListener,
    file: SocketFile,
}

impl ControlSocket {
    pub async fn bind(path: PathBuf, mode: u32) -> anyhow::Result<Self> {
        prepare_path(&path).await?;
        let listener = UnixListener::bind(&path)
            .with_context(|| format!("could not bind control socket {}", path.display()))?;
        if let Err(error) = fs::set_permissions(&path, fs::Permissions::from_mode(mode)) {
            let _ = fs::remove_file(&path);
            return Err(error)
                .with_context(|| format!("could not set permissions on {}", path.display()));
        }
        let metadata = fs::symlink_metadata(&path)
            .with_context(|| format!("could not inspect control socket {}", path.display()))?;

        Ok(Self {
            listener,
            file: SocketFile {
                path,
                device: metadata.dev(),
                inode: metadata.ino(),
            },
        })
    }

    pub async fn serve(
        self,
        pairing: Arc<PairingService>,
        shutdown: CancellationToken,
    ) -> anyhow::Result<()> {
        info!(path = %self.file.path.display(), "control socket listening");
        let mut connections = JoinSet::new();

        loop {
            tokio::select! {
                () = shutdown.cancelled() => break,
                accepted = self.listener.accept() => {
                    let (stream, _) = accepted.context("could not accept a control connection")?;
                    let pairing = pairing.clone();
                    connections.spawn(async move {
                        if let Err(error) = handle_connection(stream, pairing).await {
                            debug!(%error, "control connection closed with an error");
                        }
                    });
                }
                Some(result) = connections.join_next(), if !connections.is_empty() => {
                    if let Err(error) = result {
                        warn!(%error, "control connection task failed");
                    }
                }
            }
        }

        connections.abort_all();
        while connections.join_next().await.is_some() {}
        Ok(())
    }
}

async fn handle_connection(stream: UnixStream, pairing: Arc<PairingService>) -> anyhow::Result<()> {
    let mut framed = LengthDelimitedCodec::builder()
        .max_frame_length(MAX_FRAME_LENGTH)
        .new_framed(stream);
    let frame = framed
        .next()
        .await
        .context("control client closed without a request")?
        .context("could not read control request")?;
    let response = match decode(&frame) {
        Ok(ControlRequest::PairingClear) => match pairing.clear().await {
            Ok(had_client) => ControlResponse::PairingCleared { had_client },
            Err(error) => ControlResponse::Error {
                message: error.to_string(),
            },
        },
        Err(error) => ControlResponse::Error {
            message: error.to_string(),
        },
    };
    framed
        .send(encode(response)?)
        .await
        .context("could not send control response")
}

async fn prepare_path(path: &Path) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if !parent.is_dir() {
        bail!(
            "control socket parent directory does not exist: {}",
            parent.display()
        );
    }

    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("could not inspect control socket {}", path.display()));
        }
    };
    if !metadata.file_type().is_socket() {
        bail!(
            "refusing to replace non-socket control path {}",
            path.display()
        );
    }

    match UnixStream::connect(path).await {
        Ok(_) => bail!("another control server is listening at {}", path.display()),
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("could not probe control socket {}", path.display()));
        }
    }

    let current = fs::symlink_metadata(path)
        .with_context(|| format!("could not inspect control socket {}", path.display()))?;
    if current.dev() != metadata.dev() || current.ino() != metadata.ino() {
        bail!("control socket changed while checking whether it was stale");
    }
    fs::remove_file(path)
        .with_context(|| format!("could not remove stale control socket {}", path.display()))
}

struct SocketFile {
    path: PathBuf,
    device: u64,
    inode: u64,
}

impl Drop for SocketFile {
    fn drop(&mut self) {
        let Ok(metadata) = fs::symlink_metadata(&self.path) else {
            return;
        };
        if metadata.file_type().is_socket()
            && metadata.dev() == self.device
            && metadata.ino() == self.inode
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}
