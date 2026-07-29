#![cfg(feature = "embedded-ui")]

use std::{sync::Arc, time::Duration};

use agent_witness_server::{
    broker::{BrokerConfig, BrokerHandle},
    remote::{MemoryPairingStore, PairingService, SessionConfig},
    web,
};
use axum::{
    body::{Body, to_bytes},
    http::{
        Request, StatusCode,
        header::{CACHE_CONTROL, CONTENT_TYPE, ETAG, IF_NONE_MATCH},
    },
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

#[tokio::test]
async fn serves_the_embedded_application_with_cache_validation() {
    let (_local_requests, incoming_requests) = mpsc::channel(1);
    let (broker, broker_task) = BrokerHandle::spawn(
        BrokerConfig {
            request_timeout: Duration::from_secs(1),
            max_pending_requests: 1,
        },
        incoming_requests,
    );
    let pairing = PairingService::open(Arc::new(MemoryPairingStore::new()))
        .await
        .unwrap();
    let app = web::router(
        SessionConfig {
            broker: broker.clone(),
            pairing: Arc::new(pairing),
            remote_capacity: 1,
            shutdown: CancellationToken::new(),
        },
        1024,
    );

    let index = app
        .clone()
        .oneshot(Request::get("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(index.status(), StatusCode::OK);
    assert_eq!(index.headers()[CONTENT_TYPE], "text/html");
    assert_eq!(index.headers()[CACHE_CONTROL], "no-cache");
    assert_eq!(index.headers()["x-content-type-options"], "nosniff");
    let index = to_bytes(index.into_body(), usize::MAX).await.unwrap();
    let index = str::from_utf8(&index).unwrap();
    assert!(index.contains(r#"rel="manifest" href="/manifest.webmanifest""#));
    let asset_path = attribute(index, "src=\"");

    let manifest = app
        .clone()
        .oneshot(
            Request::get("/manifest.webmanifest")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(manifest.status(), StatusCode::OK);
    assert_eq!(
        manifest.headers()[CONTENT_TYPE],
        "application/manifest+json"
    );
    assert_eq!(manifest.headers()[CACHE_CONTROL], "no-cache");

    let head = app
        .clone()
        .oneshot(Request::head("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(head.status(), StatusCode::OK);
    assert!(
        to_bytes(head.into_body(), usize::MAX)
            .await
            .unwrap()
            .is_empty()
    );

    let asset = app
        .clone()
        .oneshot(Request::get(asset_path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(asset.status(), StatusCode::OK);
    assert_eq!(asset.headers()[CONTENT_TYPE], "text/javascript");
    assert_eq!(
        asset.headers()[CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );
    let etag = asset.headers()[ETAG].clone();
    assert!(
        !to_bytes(asset.into_body(), usize::MAX)
            .await
            .unwrap()
            .is_empty()
    );

    let unchanged = app
        .clone()
        .oneshot(
            Request::get(asset_path)
                .header(IF_NONE_MATCH, etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unchanged.status(), StatusCode::NOT_MODIFIED);
    assert!(
        to_bytes(unchanged.into_body(), usize::MAX)
            .await
            .unwrap()
            .is_empty()
    );

    let missing = app
        .clone()
        .oneshot(
            Request::get("/assets/missing.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);

    let api = app
        .oneshot(Request::get("/api/agent").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_ne!(
        api.headers().get(CONTENT_TYPE),
        Some(&"text/html".parse().unwrap())
    );

    broker.shutdown().await;
    broker_task.await.unwrap();
}

fn attribute<'a>(html: &'a str, prefix: &str) -> &'a str {
    let start = html.find(prefix).expect("attribute must exist") + prefix.len();
    let end = html[start..]
        .find('"')
        .map(|offset| start + offset)
        .expect("attribute must be terminated");

    &html[start..end]
}
