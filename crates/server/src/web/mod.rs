//! HTTP entrypoints for remote clients.

use axum::{
    Router,
    extract::{State, WebSocketUpgrade},
    response::Response,
    routing::get,
};

use crate::remote::{SessionConfig, serve};

#[cfg(feature = "embedded-ui")]
mod assets;

/// Build the HTTP router without binding it to a listener.
pub fn router(session: SessionConfig, max_message_size: usize) -> Router {
    let router = Router::new().route("/api/agent", get(upgrade_agent));

    #[cfg(feature = "embedded-ui")]
    let router = router
        .route("/", get(assets::index))
        .route("/manifest.webmanifest", get(assets::manifest))
        .route("/assets/{*path}", get(assets::asset));

    router.with_state(WebState {
        session,
        max_message_size,
    })
}

#[derive(Clone)]
struct WebState {
    session: SessionConfig,
    max_message_size: usize,
}

async fn upgrade_agent(upgrade: WebSocketUpgrade, State(state): State<WebState>) -> Response {
    upgrade
        .max_message_size(state.max_message_size)
        .on_upgrade(move |socket| serve(socket, state.session))
}
