use std::{sync::Arc, time::Duration};

use axum::extract::ws::{Message, WebSocket};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::time::{MissedTickBehavior, interval};
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use crate::broker::{BrokerError, BrokerHandle, RemoteConnection};
use crate::push::PushSubscription;

use super::{
    PairingAuthority,
    pairing::Authorization,
    protocol::{ClientMessage, ServerMessage, decode_client, encode_server},
};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

/// Dependencies and limits for one upgraded remote connection.
#[derive(Clone)]
pub struct SessionConfig {
    /// Broker controlled by messages received from this adapter.
    pub broker: BrokerHandle,

    /// Authority that pairs or authenticates the first application message.
    pub pairing: Arc<dyn PairingAuthority>,

    /// Uncompressed P-256 application-server key used to create push subscriptions.
    pub vapid_public_key: Bytes,

    /// Maximum broker requests assigned to this remote session at once.
    pub remote_capacity: usize,

    /// Daemon-wide cancellation signal.
    pub shutdown: CancellationToken,
}

/// Authenticate one WebSocket and adapt it to the broker remote interface.
pub async fn serve(mut socket: WebSocket, config: SessionConfig) {
    let revocations = config.pairing.subscribe_revocations();
    let Some(message) = receive_client(&mut socket).await else {
        return;
    };
    let authorization = match message {
        ClientMessage::PairRequest { label } => config.pairing.pair(label).await,
        ClientMessage::Authenticate {
            client_id,
            credential,
        } => config.pairing.authenticate(client_id, credential).await,
        _ => {
            send_rejected(&mut socket).await;
            return;
        }
    };
    let authorization = match authorization {
        Ok(authorization) => authorization,
        Err(_) => {
            send_rejected(&mut socket).await;
            return;
        }
    };
    let connection = match config.broker.connect_remote(config.remote_capacity).await {
        Ok(connection) => connection,
        Err(BrokerError::RemoteAlreadyConnected) => {
            send_rejected(&mut socket).await;
            return;
        }
        Err(error) => {
            warn!(%error, "could not register remote session");
            return;
        }
    };

    let client_id = authorization.client_id();
    let response = handshake_response(
        authorization,
        connection.session_id,
        config.vapid_public_key.clone(),
    );
    let Ok(response) = encode_server(response) else {
        let _ = config
            .broker
            .remote_disconnected(connection.session_id)
            .await;
        return;
    };
    if socket.send(Message::Binary(response)).await.is_err() {
        let _ = config
            .broker
            .remote_disconnected(connection.session_id)
            .await;
        return;
    }

    run_authenticated(socket, connection, revocations, client_id, &config).await;
}

async fn send_rejected(socket: &mut WebSocket) {
    if let Ok(frame) = encode_server(ServerMessage::Rejected) {
        let _ = socket.send(Message::Binary(frame)).await;
    }
}

async fn receive_client(socket: &mut WebSocket) -> Option<ClientMessage> {
    match socket.recv().await? {
        Ok(Message::Binary(frame)) => match decode_client(frame) {
            Ok(message) => Some(message),
            Err(error) => {
                debug!(%error, "rejected invalid remote handshake");
                None
            }
        },
        _ => None,
    }
}

fn handshake_response(
    authorization: Authorization,
    session_id: crate::broker::SessionId,
    vapid_public_key: Bytes,
) -> ServerMessage {
    match authorization {
        Authorization::Paired {
            server_id,
            client_id,
            credential,
        } => ServerMessage::Paired {
            server_id,
            client_id,
            credential,
            session_id,
            vapid_public_key,
        },
        Authorization::Authenticated { server_id, .. } => ServerMessage::Authenticated {
            server_id,
            session_id,
            vapid_public_key,
        },
    }
}

async fn run_authenticated(
    socket: WebSocket,
    mut connection: RemoteConnection,
    mut revocations: tokio::sync::watch::Receiver<u64>,
    client_id: uuid::Uuid,
    config: &SessionConfig,
) {
    let session_id = connection.session_id;
    let (mut sender, mut receiver) = socket.split();
    let mut heartbeat = interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    heartbeat.tick().await;
    let mut awaiting_pong = false;

    loop {
        tokio::select! {
            command = connection.commands.recv() => {
                let Some(command) = command else {
                    break;
                };
                let Ok(frame) = encode_server(command.into()) else {
                    break;
                };

                if sender
                    .send(Message::Binary(frame))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            message = receiver.next() => {
                let Some(Ok(message)) = message else {
                    break;
                };

                if !handle_client_message(
                    message,
                    config,
                    session_id,
                    client_id,
                    &mut awaiting_pong,
                ).await {
                    break;
                }
            }
            _ = heartbeat.tick() => {
                let Ok(frame) = encode_server(ServerMessage::Ping) else {
                    break;
                };

                if awaiting_pong
                    || sender.send(Message::Binary(frame)).await.is_err()
                {
                    break;
                }

                awaiting_pong = true;
            }
            _ = revocations.changed() => break,
            () = config.shutdown.cancelled() => break,
        }
    }

    let _ = config.broker.remote_disconnected(session_id).await;
}

async fn handle_client_message(
    message: Message,
    config: &SessionConfig,
    session_id: crate::broker::SessionId,
    client_id: uuid::Uuid,
    awaiting_pong: &mut bool,
) -> bool {
    let Message::Binary(frame) = message else {
        return matches!(message, Message::Ping(_) | Message::Pong(_));
    };
    let Ok(message) = decode_client(frame) else {
        return false;
    };

    let result = match message {
        ClientMessage::AgentReady => config.broker.remote_ready(session_id).await,
        ClientMessage::AgentLocked => config.broker.remote_locked(session_id).await,
        ClientMessage::AgentResponse {
            request_id,
            attempt,
            packet,
        } => {
            config
                .broker
                .remote_response(session_id, request_id, attempt, packet)
                .await
        }
        ClientMessage::Pong => {
            *awaiting_pong = false;
            Ok(())
        }
        ClientMessage::SetPushSubscription {
            endpoint,
            expiration_time,
            p256_dh,
            auth,
        } => {
            let subscription = PushSubscription {
                endpoint,
                expiration_time,
                p256dh: p256_dh,
                auth,
            };
            if let Err(error) = config
                .pairing
                .set_push_subscription(client_id, subscription)
                .await
            {
                warn!(%error, "could not persist push subscription");
                return false;
            }

            return true;
        }
        ClientMessage::PairRequest { .. } | ClientMessage::Authenticate { .. } => {
            return false;
        }
    };

    result.is_ok()
}
