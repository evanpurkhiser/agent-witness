//! HTTP entrypoints for remote clients.

use axum::{
    Router,
    body::Body,
    extract::{State, WebSocketUpgrade},
    http::Request,
    response::Response,
    routing::get,
};

use crate::remote::{SessionConfig, serve};

#[cfg(feature = "embedded-ui")]
mod assets;

/// Build the HTTP router without binding it to a listener.
pub fn router(
    session: SessionConfig,
    max_message_size: usize,
    sentry_frontend_dsn: Option<String>,
) -> Router {
    let router = Router::new().route("/api/agent", get(upgrade_agent));

    #[cfg(feature = "embedded-ui")]
    let router = router
        .route("/", get(assets::index))
        .route("/manifest.webmanifest", get(assets::manifest))
        .route("/service-worker.js", get(assets::service_worker))
        .route("/assets/{*path}", get(assets::asset));

    router
        .with_state(WebState {
            session,
            max_message_size,
            sentry_frontend_dsn,
        })
        .layer(sentry::integrations::tower::SentryHttpLayer::new().enable_transaction())
        .layer(sentry::integrations::tower::NewSentryLayer::<Request<Body>>::new_from_top())
}

#[derive(Clone)]
struct WebState {
    session: SessionConfig,
    max_message_size: usize,
    #[cfg_attr(not(feature = "embedded-ui"), allow(dead_code))]
    sentry_frontend_dsn: Option<String>,
}

async fn upgrade_agent(upgrade: WebSocketUpgrade, State(state): State<WebState>) -> Response {
    upgrade
        .max_message_size(state.max_message_size)
        .on_upgrade(move |socket| serve(socket, state.session))
}
