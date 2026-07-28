//! Remote WebSocket adapter and its wire protocol.

mod pairing;
pub mod protocol;
mod session;

pub use pairing::{
    FilePairingStore, MemoryPairingStore, PairingAuthority, PairingService, PairingStore,
};
pub use session::{SessionConfig, serve};
