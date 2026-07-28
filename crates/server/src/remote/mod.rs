//! Remote WebSocket adapter and its wire protocol.

mod pairing;
pub mod protocol;
mod session;

pub use pairing::{EphemeralPairing, PairingAuthority};
pub use session::{SessionConfig, serve};
