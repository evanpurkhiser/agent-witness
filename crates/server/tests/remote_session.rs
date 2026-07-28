use std::{sync::Arc, time::Duration};

use agent_witness_server::{
    broker::{BrokerConfig, BrokerHandle},
    packet::{PacketRequest, RequestError},
    remote::{MemoryPairingStore, PairingService, SessionConfig},
    web,
};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[tokio::test]
async fn websocket_adapts_a_remote_worker_to_the_broker() {
    let (local_requests, incoming_requests) = mpsc::channel(8);
    let (broker, broker_task) = BrokerHandle::spawn(
        BrokerConfig {
            request_timeout: Duration::from_secs(1),
            max_pending_requests: 8,
        },
        incoming_requests,
    );
    let shutdown = CancellationToken::new();
    let pairing = Arc::new(
        PairingService::open(Arc::new(MemoryPairingStore::new()))
            .await
            .unwrap(),
    );
    let app = web::router(
        SessionConfig {
            broker: broker.clone(),
            pairing: pairing.clone(),
            remote_capacity: 1,
            shutdown: shutdown.clone(),
        },
        1024,
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let web_task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let (mut remote, _) = connect_async(format!("ws://{address}/api/agent"))
        .await
        .unwrap();
    send(
        &mut remote,
        ClientMessage::PairRequest {
            label: "iPhone".into(),
        },
    )
    .await;
    let ServerMessage::Paired {
        server_id,
        client_id,
        credential,
        session_id,
    } = receive::<ServerMessage>(&mut remote).await
    else {
        panic!("expected a pairing response")
    };
    assert!(Uuid::parse_str(&server_id).is_ok());
    assert!(Uuid::parse_str(&client_id).is_ok());
    assert!(Uuid::parse_str(&session_id).is_ok());
    assert_eq!(credential.len(), 32);

    let request_packet = Bytes::from_static(b"\0\0\0\x01\x0b");
    let response_packet = Bytes::from_static(b"\0\0\0\x01\x0c");
    let (response, response_receiver) = oneshot::channel();
    local_requests
        .send(PacketRequest {
            packet: request_packet.clone(),
            response,
            cancellation: CancellationToken::new(),
        })
        .await
        .unwrap();

    let ServerMessage::AgentRequest {
        request_id,
        attempt,
        packet,
    } = receive(&mut remote).await
    else {
        panic!("expected an agent request")
    };
    assert_eq!(packet, request_packet);

    send(
        &mut remote,
        ClientMessage::AgentResponse {
            request_id,
            attempt,
            packet: response_packet.clone(),
        },
    )
    .await;

    assert_eq!(response_receiver.await.unwrap().unwrap(), response_packet);

    let cancellation = CancellationToken::new();
    let (response, response_receiver) = oneshot::channel();
    local_requests
        .send(PacketRequest {
            packet: request_packet,
            response,
            cancellation: cancellation.clone(),
        })
        .await
        .unwrap();
    let ServerMessage::AgentRequest {
        request_id,
        attempt,
        ..
    } = receive(&mut remote).await
    else {
        panic!("expected an agent request")
    };

    cancellation.cancel();

    assert!(matches!(
        receive(&mut remote).await,
        ServerMessage::CancelRequest {
            request_id: cancelled_request,
            attempt: cancelled_attempt,
        } if cancelled_request == request_id && cancelled_attempt == attempt
    ));
    assert_eq!(
        response_receiver.await.unwrap(),
        Err(RequestError::Cancelled)
    );

    assert!(pairing.clear().await.unwrap());
    match tokio::time::timeout(Duration::from_secs(1), remote.next())
        .await
        .unwrap()
    {
        None | Some(Ok(Message::Close(_))) | Some(Err(_)) => {}
        Some(Ok(message)) => panic!("expected remote session to close, received {message:?}"),
    }

    shutdown.cancel();
    broker.shutdown().await;
    broker_task.await.unwrap();
    web_task.abort();
}

async fn send(remote: &mut RemoteSocket, message: ClientMessage) {
    let frame = rmp_serde::to_vec_named(&Envelope {
        version: 1,
        message,
    })
    .unwrap();
    remote
        .send(Message::Binary(Bytes::from(frame)))
        .await
        .unwrap();
}

async fn receive<T: DeserializeOwned>(remote: &mut RemoteSocket) -> T {
    let Message::Binary(frame) = remote.next().await.unwrap().unwrap() else {
        panic!("expected a binary message")
    };
    let envelope: Envelope<T> = rmp_serde::from_slice(&frame).unwrap();
    assert_eq!(envelope.version, 1);
    envelope.message
}

type RemoteSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Deserialize, Serialize)]
struct Envelope<T> {
    version: u8,
    message: T,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    PairRequest {
        label: String,
    },
    AgentResponse {
        request_id: String,
        attempt: u32,
        packet: Bytes,
    },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMessage {
    Paired {
        server_id: String,
        client_id: String,
        credential: Bytes,
        session_id: String,
    },
    AgentRequest {
        request_id: String,
        attempt: u32,
        packet: Bytes,
    },
    CancelRequest {
        request_id: String,
        attempt: u32,
    },
}
