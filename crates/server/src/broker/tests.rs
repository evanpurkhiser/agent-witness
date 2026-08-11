use std::time::{Duration, Instant};

use bytes::Bytes;
use tokio::{
    sync::{mpsc, oneshot},
    time::timeout,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::packet::{PacketRequest, RequestError};

use super::{
    BrokerConfig, BrokerHandle, RemoteCommand,
    model::{BrokerState, Effect, Event},
};

fn submit(
    state: &mut BrokerState,
    request_id: Uuid,
    packet: &'static [u8],
    now: Instant,
) -> Vec<Effect> {
    state
        .apply(
            Event::Submit {
                request_id,
                packet: Bytes::from_static(packet),
                deadline: now + Duration::from_secs(30),
                requested_at: 1_799_999_970_000,
                deadline_timestamp: 1_800_000_000_000,
            },
            now,
        )
        .unwrap()
}

async fn submit_local(
    requests: &mpsc::Sender<PacketRequest>,
    packet: Bytes,
) -> Result<Bytes, RequestError> {
    let (response, receiver) = oneshot::channel();
    requests
        .send(PacketRequest {
            packet,
            response,
            cancellation: CancellationToken::new(),
        })
        .await
        .map_err(|_| RequestError::Unavailable)?;

    receiver.await.unwrap_or(Err(RequestError::Unavailable))
}

#[test]
fn every_request_queues_before_dispatch() {
    let now = Instant::now();
    let request_id = Uuid::new_v4();
    let session_id = Uuid::new_v4();
    let mut state = BrokerState::new(8);

    let effects = submit(&mut state, request_id, b"request", now);
    assert!(matches!(effects.as_slice(), [Effect::WakeRequired]));

    let effects = state
        .apply(
            Event::Connected {
                session_id,
                capacity: 1,
            },
            now,
        )
        .unwrap();

    assert!(matches!(
        effects.as_slice(),
        [Effect::Dispatch {
            request_id: dispatched,
            attempt: 1,
            ..
        }] if *dispatched == request_id
    ));
}

#[test]
fn capacity_is_a_dispatch_gate() {
    let now = Instant::now();
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();
    let session_id = Uuid::new_v4();
    let mut state = BrokerState::new(8);

    submit(&mut state, first, b"first", now);
    submit(&mut state, second, b"second", now);
    let effects = state
        .apply(
            Event::Connected {
                session_id,
                capacity: 1,
            },
            now,
        )
        .unwrap();
    assert_eq!(effects.len(), 1);

    let effects = state
        .apply(
            Event::Response {
                session_id,
                request_id: first,
                attempt: 1,
                packet: Bytes::from_static(b"response"),
            },
            now,
        )
        .unwrap();

    assert!(matches!(
        effects.as_slice(),
        [
            Effect::Complete {
                request_id: completed,
                ..
            },
            Effect::Dispatch {
                request_id: dispatched,
                ..
            }
        ] if *completed == first && *dispatched == second
    ));
}

#[test]
fn disconnect_requeues_with_a_new_attempt() {
    let now = Instant::now();
    let request_id = Uuid::new_v4();
    let first_session = Uuid::new_v4();
    let second_session = Uuid::new_v4();
    let mut state = BrokerState::new(8);

    submit(&mut state, request_id, b"request", now);
    state
        .apply(
            Event::Connected {
                session_id: first_session,
                capacity: 1,
            },
            now,
        )
        .unwrap();
    state
        .apply(
            Event::Disconnected {
                session_id: first_session,
            },
            now,
        )
        .unwrap();
    let effects = state
        .apply(
            Event::Connected {
                session_id: second_session,
                capacity: 1,
            },
            now,
        )
        .unwrap();

    assert!(matches!(
        effects.as_slice(),
        [Effect::Dispatch {
            request_id: dispatched,
            attempt: 2,
            ..
        }] if *dispatched == request_id
    ));

    let stale = state
        .apply(
            Event::Response {
                session_id: first_session,
                request_id,
                attempt: 1,
                packet: Bytes::from_static(b"stale"),
            },
            now,
        )
        .unwrap();
    assert!(stale.is_empty());
}

#[test]
fn connecting_locked_dispatches_existing_request() {
    let now = Instant::now();
    let request_id = Uuid::new_v4();
    let session_id = Uuid::new_v4();
    let mut state = BrokerState::new(8);

    submit(&mut state, request_id, b"request", now);
    let effects = state
        .apply(
            Event::Connected {
                session_id,
                capacity: 1,
            },
            now,
        )
        .unwrap();

    assert!(matches!(
        effects.as_slice(),
        [Effect::Dispatch {
            request_id: dispatched,
            attempt: 1,
            ..
        }] if *dispatched == request_id
    ));
}

#[test]
fn locking_keeps_delivered_requests_in_flight() {
    let now = Instant::now();
    let request_id = Uuid::new_v4();
    let session_id = Uuid::new_v4();
    let mut state = BrokerState::new(8);

    submit(&mut state, request_id, b"request", now);
    state
        .apply(
            Event::Connected {
                session_id,
                capacity: 1,
            },
            now,
        )
        .unwrap();
    state.apply(Event::Ready { session_id }, now).unwrap();
    let effects = state.apply(Event::Locked { session_id }, now).unwrap();
    assert!(effects.is_empty());

    let effects = state
        .apply(
            Event::Response {
                session_id,
                request_id,
                attempt: 1,
                packet: Bytes::from_static(b"response"),
            },
            now,
        )
        .unwrap();

    assert!(matches!(
        effects.as_slice(),
        [Effect::Complete {
            request_id: completed,
            result: Ok(packet),
        }] if *completed == request_id && packet == &Bytes::from_static(b"response")
    ));
}

#[test]
fn rejects_a_second_remote_session() {
    let now = Instant::now();
    let mut state = BrokerState::new(8);
    state
        .apply(
            Event::Connected {
                session_id: Uuid::new_v4(),
                capacity: 1,
            },
            now,
        )
        .unwrap();

    let result = state.apply(
        Event::Connected {
            session_id: Uuid::new_v4(),
            capacity: 1,
        },
        now,
    );

    assert!(result.is_err());
}

#[test]
fn expiration_completes_a_queued_request() {
    let now = Instant::now();
    let request_id = Uuid::new_v4();
    let mut state = BrokerState::new(8);

    submit(&mut state, request_id, b"request", now);
    let effects = state
        .apply(Event::Tick, now + Duration::from_secs(31))
        .unwrap();

    assert!(matches!(
        effects.as_slice(),
        [Effect::Complete {
            request_id: completed,
            result: Err(RequestError::TimedOut),
        }] if *completed == request_id
    ));
}

#[test]
fn cancellation_removes_a_queued_request() {
    let now = Instant::now();
    let request_id = Uuid::new_v4();
    let mut state = BrokerState::new(8);

    submit(&mut state, request_id, b"request", now);
    let effects = state.apply(Event::Cancelled { request_id }, now).unwrap();

    assert!(matches!(
        effects.as_slice(),
        [Effect::Complete {
            request_id: cancelled,
            result: Err(RequestError::Cancelled),
        }] if *cancelled == request_id
    ));
}

#[test]
fn cancellation_stops_an_in_flight_attempt_and_frees_capacity() {
    let now = Instant::now();
    let request_id = Uuid::new_v4();
    let next_request_id = Uuid::new_v4();
    let session_id = Uuid::new_v4();
    let mut state = BrokerState::new(8);

    submit(&mut state, request_id, b"request", now);
    submit(&mut state, next_request_id, b"next", now);
    state
        .apply(
            Event::Connected {
                session_id,
                capacity: 1,
            },
            now,
        )
        .unwrap();
    let effects = state.apply(Event::Cancelled { request_id }, now).unwrap();

    assert!(matches!(
        effects.as_slice(),
        [
            Effect::Cancel {
                session_id: cancelled_session,
                request_id: cancelled_request,
                attempt: 1,
            },
            Effect::Complete {
                request_id: completed,
                result: Err(RequestError::Cancelled),
            },
            Effect::Dispatch {
                request_id: dispatched,
                attempt: 1,
                ..
            },
        ] if *cancelled_session == session_id
            && *cancelled_request == request_id
            && *completed == request_id
            && *dispatched == next_request_id
    ));

    let late_response = state
        .apply(
            Event::Response {
                session_id,
                request_id,
                attempt: 1,
                packet: Bytes::from_static(b"late"),
            },
            now,
        )
        .unwrap();
    assert!(late_response.is_empty());
}

#[tokio::test]
async fn actor_forwards_and_correlates_a_request() {
    let (requests, incoming) = mpsc::channel(8);
    let (wakes, _wake_requests) = mpsc::unbounded_channel();
    let (broker, task) = BrokerHandle::spawn(
        BrokerConfig {
            request_timeout: Duration::from_secs(1),
            max_pending_requests: 8,
        },
        incoming,
        wakes,
    );
    let mut remote = broker.connect_remote(1).await.unwrap();

    let submit =
        tokio::spawn(async move { submit_local(&requests, Bytes::from_static(b"request")).await });
    let RemoteCommand::Request {
        request_id,
        attempt,
        requested_at,
        deadline,
        packet,
    } = remote.commands.recv().await.unwrap()
    else {
        panic!("expected a request")
    };
    assert_eq!(packet, Bytes::from_static(b"request"));
    assert_eq!(deadline - requested_at, 1_000);
    let remaining = deadline.saturating_sub(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64,
    );
    assert!(remaining <= 1_000 && remaining > 0);

    broker
        .remote_response(
            remote.session_id,
            request_id,
            attempt,
            Bytes::from_static(b"response"),
        )
        .await
        .unwrap();
    assert_eq!(
        submit.await.unwrap().unwrap(),
        Bytes::from_static(b"response")
    );

    broker.shutdown().await;
    task.await.unwrap();
}

#[tokio::test]
async fn actor_forwards_local_cancellation_to_the_remote() {
    let (requests, incoming) = mpsc::channel(8);
    let (wakes, _wake_requests) = mpsc::unbounded_channel();
    let (broker, task) = BrokerHandle::spawn(
        BrokerConfig {
            request_timeout: Duration::from_secs(1),
            max_pending_requests: 8,
        },
        incoming,
        wakes,
    );
    let mut remote = broker.connect_remote(1).await.unwrap();
    let cancellation = CancellationToken::new();
    let (response, receiver) = oneshot::channel();
    requests
        .send(PacketRequest {
            packet: Bytes::from_static(b"request"),
            response,
            cancellation: cancellation.clone(),
        })
        .await
        .unwrap();
    let RemoteCommand::Request {
        request_id,
        attempt,
        ..
    } = remote.commands.recv().await.unwrap()
    else {
        panic!("expected a request")
    };

    cancellation.cancel();

    assert!(matches!(
        remote.commands.recv().await,
        Some(RemoteCommand::Cancel {
            request_id: cancelled_request,
            attempt: cancelled_attempt,
        }) if cancelled_request == request_id && cancelled_attempt == attempt
    ));
    assert_eq!(receiver.await.unwrap(), Err(RequestError::Cancelled));

    broker.shutdown().await;
    task.await.unwrap();
}

#[tokio::test]
async fn actor_times_out_without_a_remote() {
    let (requests, incoming) = mpsc::channel(8);
    let (wakes, mut wake_requests) = mpsc::unbounded_channel();
    let (broker, task) = BrokerHandle::spawn(
        BrokerConfig {
            request_timeout: Duration::from_millis(10),
            max_pending_requests: 8,
        },
        incoming,
        wakes,
    );

    let submit = submit_local(&requests, Bytes::from_static(b"request"));
    let (wake, result) = tokio::join!(
        timeout(Duration::from_secs(1), wake_requests.recv()),
        timeout(Duration::from_secs(1), submit),
    );
    assert_eq!(wake.unwrap(), Some(()));
    let result = result.unwrap();
    assert_eq!(result, Err(RequestError::TimedOut));

    broker.shutdown().await;
    task.await.unwrap();
}
