//! Remote WebSocket adapter and its wire protocol.

mod pairing;
pub mod protocol;
mod session;

pub use pairing::{MemoryPairingStore, PairingAuthority, PairingService};
pub use session::{SessionConfig, serve};
