use std::sync::Mutex;

use super::{PairingState, PairingStore, PairingStoreFuture};

/// Process-local pairing storage for tests and explicitly ephemeral servers.
#[derive(Default)]
pub struct MemoryPairingStore {
    state: Mutex<Option<PairingState>>,
}

impl MemoryPairingStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl PairingStore for MemoryPairingStore {
    fn load(&self) -> PairingStoreFuture<'_, Option<PairingState>> {
        Box::pin(async move {
            Ok(self
                .state
                .lock()
                .expect("pairing store mutex poisoned")
                .clone())
        })
    }

    fn save<'a>(&'a self, state: &'a PairingState) -> PairingStoreFuture<'a, ()> {
        Box::pin(async move {
            *self.state.lock().expect("pairing store mutex poisoned") = Some(state.clone());
            Ok(())
        })
    }
}
