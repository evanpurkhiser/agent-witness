//! HTTP entrypoints for remote clients.

use axum::{
    Router,
    extract::{State, WebSocketUpgrade},
    response::Response,
    routing::get,
};

use crate::remote::{SessionConfig, serve};

/// Build the HTTP router without binding it to a listener.
pub fn router(session: SessionConfig, max_message_size: usize) -> Router {
    Router::new()
        .route("/api/agent", get(upgrade_agent))
        .with_state(WebState {
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
