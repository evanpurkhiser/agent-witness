//! Local administrative control socket and client.

pub use client::clear_pairing;
pub use server::ControlSocket;

mod client;
mod protocol;
mod server;

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tempfile::tempdir;
    use tokio_util::sync::CancellationToken;

    use crate::remote::{MemoryPairingStore, PairingAuthority, PairingService};

    use super::*;

    #[tokio::test]
    async fn clears_pairing_through_the_control_socket() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("control.sock");
        let pairing = Arc::new(
            PairingService::open(Arc::new(MemoryPairingStore::new()))
                .await
                .unwrap(),
        );
        pairing.pair("iPhone".into()).await.unwrap();
        let shutdown = CancellationToken::new();
        let socket = ControlSocket::bind(path.clone(), 0o600).await.unwrap();
        let task = tokio::spawn(socket.serve(pairing.clone(), shutdown.clone()));

        assert!(clear_pairing(&path).await.unwrap());
        assert!(!clear_pairing(&path).await.unwrap());
        assert!(pairing.pair("replacement".into()).await.is_ok());

        shutdown.cancel();
        task.await.unwrap().unwrap();
    }
}
