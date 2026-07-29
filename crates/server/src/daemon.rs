use std::sync::Arc;

use anyhow::Context;
use tokio::{
    net::TcpListener,
    signal::unix::{SignalKind, signal},
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::{
    agent_socket::AgentSocket,
    broker::{BrokerConfig, BrokerHandle},
    config::Config,
    control::ControlSocket,
    push::{PushService, VapidKey},
    remote::{
        FilePairingStore, MemoryPairingStore, PairingService, PairingStore, SessionConfig,
        protocol::MAX_MESSAGE_OVERHEAD,
    },
    web,
};

pub async fn run(config: Config) -> anyhow::Result<()> {
    let vapid = VapidKey::open(config.vapid_private_key_file.clone()).await?;
    let vapid_public_key = vapid.public_key();
    let pairing_store: Arc<dyn PairingStore> = match &config.state_path {
        Some(path) => Arc::new(FilePairingStore::new(path.clone())),
        None => {
            warn!("state_path is unset; pairing will be lost when the daemon stops");
            Arc::new(MemoryPairingStore::new())
        }
    };
    let pairing = Arc::new(PairingService::open(pairing_store).await?);
    let push = PushService::new(pairing.clone(), vapid, config.request_timeout);
    let (wakes, wake_requests) = mpsc::unbounded_channel();
    let _push_task = tokio::spawn(push.serve(wake_requests));
    let socket = AgentSocket::bind(
        config.unix_socket.clone(),
        config.socket_mode,
        config.max_agent_packet_size,
    )
    .await?;
    let control_socket =
        ControlSocket::bind(config.control_socket.clone(), config.control_socket_mode).await?;
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
        wakes,
    );
    let shutdown = CancellationToken::new();
    let mut socket_task = tokio::spawn(socket.serve(local_requests, shutdown.clone()));
    let mut control_task = tokio::spawn(control_socket.serve(pairing.clone(), shutdown.clone()));
    let router = web::router(
        SessionConfig {
            broker: broker.clone(),
            pairing,
            vapid_public_key,
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
            control_task.await.context("control socket task failed")??;
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
            control_task.await.context("control socket task failed")??;
            broker_task.await.context("request broker task failed")?;
            return Ok(());
        }
        result = &mut control_task => {
            result.context("control socket task failed")??;
            shutdown.cancel();
            broker.shutdown().await;
            socket_task
                .await
                .context("SSH-agent socket task failed")??;
            web_task.await.context("HTTP/WebSocket task failed")??;
            broker_task.await.context("request broker task failed")?;
            return Ok(());
        }
        result = &mut broker_task => {
            shutdown.cancel();
            socket_task
                .await
                .context("SSH-agent socket task failed")??;
            web_task.await.context("HTTP/WebSocket task failed")??;
            control_task.await.context("control socket task failed")??;
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
    control_task.await.context("control socket task failed")??;
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
