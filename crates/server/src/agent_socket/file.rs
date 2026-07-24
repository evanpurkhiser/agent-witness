use std::{
    fs, io,
    os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
};

use tokio::net::{UnixListener, UnixStream};

use super::{AgentSocketError, PathIoError};

/// Ownership guard for one bound socket filesystem entry.
pub(super) struct SocketFile {
    path: PathBuf,
    device: u64,
    inode: u64,
}

impl SocketFile {
    /// Prepare and bind a socket path, returning a guard that owns its cleanup.
    pub(super) async fn bind(
        path: PathBuf,
        mode: u32,
    ) -> Result<(Self, UnixListener), AgentSocketError> {
        prepare_path(&path).await?;

        let path_error = |source| PathIoError::new(path.clone(), source);

        let listener = UnixListener::bind(&path)
            .map_err(|source| AgentSocketError::Bind(path_error(source)))?;

        if let Err(source) = fs::set_permissions(&path, fs::Permissions::from_mode(mode)) {
            let _ = fs::remove_file(&path);
            return Err(AgentSocketError::Permissions(path_error(source)));
        }

        let metadata = fs::symlink_metadata(&path)
            .map_err(|source| AgentSocketError::Metadata(path_error(source)))?;
        let file = Self {
            path,
            device: metadata.dev(),
            inode: metadata.ino(),
        };

        Ok((file, listener))
    }

    /// Return the filesystem path owned by this guard.
    pub(super) fn path(&self) -> &Path {
        &self.path
    }
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

/// Remove a stale socket only after verifying that its filesystem identity is stable.
async fn prepare_path(path: &Path) -> Result<(), AgentSocketError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if !parent.is_dir() {
        return Err(AgentSocketError::MissingParent(parent.to_owned()));
    }

    let path_error = |source| PathIoError::new(path.to_owned(), source);
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(source) => return Err(AgentSocketError::Metadata(path_error(source))),
    };
    if !metadata.file_type().is_socket() {
        return Err(AgentSocketError::NotSocket(path.to_owned()));
    }

    match UnixStream::connect(path).await {
        Ok(_) => return Err(AgentSocketError::AlreadyActive(path.to_owned())),
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => {}
        Err(source) => return Err(AgentSocketError::Probe(path_error(source))),
    }

    let current = fs::symlink_metadata(path)
        .map_err(|source| AgentSocketError::Metadata(path_error(source)))?;
    if current.dev() != metadata.dev() || current.ino() != metadata.ino() {
        return Err(AgentSocketError::Changed(path.to_owned()));
    }

    fs::remove_file(path).map_err(|source| AgentSocketError::RemoveStale(path_error(source)))
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::unix::{
            fs::{MetadataExt, PermissionsExt},
            net::UnixListener as StdUnixListener,
        },
    };

    use tempfile::tempdir;

    use super::super::{AgentSocket, AgentSocketError};

    #[tokio::test]
    async fn refuses_to_replace_a_regular_file() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("agent.sock");
        fs::write(&path, "keep me").unwrap();

        let result = AgentSocket::bind(path.clone(), 0o600, 1024).await;

        assert!(matches!(result, Err(AgentSocketError::NotSocket(found)) if found == path));
        assert_eq!(fs::read_to_string(path).unwrap(), "keep me");
    }

    #[tokio::test]
    async fn replaces_a_stale_socket() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("agent.sock");
        drop(StdUnixListener::bind(&path).unwrap());

        let socket = AgentSocket::bind(path.clone(), 0o600, 1024).await.unwrap();

        assert!(path.exists());
        drop(socket);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn refuses_to_replace_an_active_socket() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("agent.sock");
        let socket = AgentSocket::bind(path.clone(), 0o600, 1024).await.unwrap();
        let inode = fs::metadata(&path).unwrap().ino();

        let result = AgentSocket::bind(path.clone(), 0o600, 1024).await;

        assert!(matches!(
            result,
            Err(AgentSocketError::AlreadyActive(found)) if found == path
        ));
        assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
        drop(socket);
    }

    #[tokio::test]
    async fn applies_configured_permissions() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("agent.sock");
        let socket = AgentSocket::bind(path.clone(), 0o640, 1024).await.unwrap();

        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );

        drop(socket);
    }
}
