use std::sync::Arc;

use anyhow::Context;
use tokio::{
    net::TcpListener,
    signal::unix::{SignalKind, signal},
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;
use tracing::info;

use crate::{
    agent_socket::AgentSocket,
    broker::{BrokerConfig, BrokerHandle},
    config::Config,
    remote::{MemoryPairingStore, PairingService, SessionConfig, protocol::MAX_MESSAGE_OVERHEAD},
    web,
};

pub async fn run(config: Config) -> anyhow::Result<()> {
    let socket = AgentSocket::bind(
        config.unix_socket.clone(),
        config.socket_mode,
        config.max_agent_packet_size,
    )
    .await?;
    let http_listener = TcpListener::bind(config.http_listen)
        .await
        .with_context(|| format!("could not bind HTTP listener {}", config.http_listen))?;
    let (local_requests, incoming_requests) = mpsc::channel(config.max_pending_requests);
    let (broker, mut broker_task) = BrokerHandle::spawn(
        BrokerConfig {
            request_timeout: config.request_timeout,
            max_pending_requests: config.max_pending_requests,
        },
        incoming_requests,
    );
    let shutdown = CancellationToken::new();
    let mut socket_task = tokio::spawn(socket.serve(local_requests, shutdown.clone()));
    let pairing = Arc::new(PairingService::open(Arc::new(MemoryPairingStore::new())).await?);
    let router = web::router(
        SessionConfig {
            broker: broker.clone(),
            pairing,
            remote_capacity: config.remote_capacity,
            shutdown: shutdown.clone(),
        },
        config.max_agent_packet_size + 4 + MAX_MESSAGE_OVERHEAD,
    );
    let web_shutdown = shutdown.clone();
    let mut web_task = tokio::spawn(async move {
        axum::serve(http_listener, router)
            .with_graceful_shutdown(web_shutdown.cancelled_owned())
            .await
    });

    info!(address = %config.http_listen, "HTTP/WebSocket listener ready");

    tokio::select! {
        result = wait_for_shutdown() => result?,
        result = &mut socket_task => {
            result.context("SSH-agent socket task failed")??;
            shutdown.cancel();
            broker.shutdown().await;
            web_task.await.context("HTTP/WebSocket task failed")??;
            broker_task.await.context("request broker task failed")?;
            return Ok(());
        }
        result = &mut web_task => {
            result.context("HTTP/WebSocket task failed")??;
            shutdown.cancel();
            broker.shutdown().await;
            socket_task
                .await
                .context("SSH-agent socket task failed")??;
            broker_task.await.context("request broker task failed")?;
            return Ok(());
        }
        result = &mut broker_task => {
            shutdown.cancel();
            socket_task
                .await
                .context("SSH-agent socket task failed")??;
            web_task.await.context("HTTP/WebSocket task failed")??;
            result.context("request broker task failed")?;
            return Err(anyhow::anyhow!("request broker stopped unexpectedly"));
        }
    }

    info!("shutting down");
    shutdown.cancel();
    broker.shutdown().await;

    socket_task
        .await
        .context("SSH-agent socket task failed")??;
    web_task.await.context("HTTP/WebSocket task failed")??;
    broker_task.await.context("request broker task failed")?;
    Ok(())
}

async fn wait_for_shutdown() -> anyhow::Result<()> {
    let mut terminate =
        signal(SignalKind::terminate()).context("could not install SIGTERM handler")?;

    tokio::select! {
        result = tokio::signal::ctrl_c() => {
            result.context("could not install Ctrl-C handler")?;
        }
        _ = terminate.recv() => {}
    }

    Ok(())
}
