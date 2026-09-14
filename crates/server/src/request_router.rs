//! Classifies SSH-agent packets and routes them to local or remote handlers.

use bytes::Bytes;
use futures_util::{FutureExt, future, future::BoxFuture};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::packet::{
    AgentIdentity, IdentityError, PacketRequest, RequestError, identities_answer,
    is_identity_request, is_openssh_session_bind_request,
};

const AGENT_FAILURE_FRAME: &[u8] = &[0, 0, 0, 1, 5];

/// Shared dependencies used to construct an independent router per connection.
#[derive(Clone)]
pub struct RequestRouter {
    identities: watch::Receiver<Option<Vec<AgentIdentity>>>,
    broker: mpsc::Sender<PacketRequest>,
}

impl RequestRouter {
    pub fn new(
        identities: watch::Receiver<Option<Vec<AgentIdentity>>>,
        broker: mpsc::Sender<PacketRequest>,
    ) -> Result<Self, IdentityError> {
        derive_answer(&identities.borrow())?;

        Ok(Self { identities, broker })
    }

    /// Create a router whose mutable state belongs to one socket connection.
    pub fn connection(&self) -> Result<ConnectionRouter, IdentityError> {
        ConnectionRouter::new(self.identities.clone(), self.broker.clone())
    }
}

/// Packet router and mutable state for one socket connection.
pub struct ConnectionRouter {
    identities: watch::Receiver<Option<Vec<AgentIdentity>>>,
    identity_answer: Option<Bytes>,
    broker: mpsc::Sender<PacketRequest>,
}

impl ConnectionRouter {
    fn new(
        identities: watch::Receiver<Option<Vec<AgentIdentity>>>,
        broker: mpsc::Sender<PacketRequest>,
    ) -> Result<Self, IdentityError> {
        let identity_answer = derive_answer(&identities.borrow())?;

        Ok(Self {
            identities,
            identity_answer,
            broker,
        })
    }

    /// Classify a packet immediately and return its eventual response.
    pub(crate) fn route(
        &mut self,
        packet: Bytes,
        cancellation: CancellationToken,
    ) -> Result<RoutedResponse, RouteError> {
        self.refresh_identity_answer()?;

        if is_identity_request(&packet)
            && let Some(answer) = self.identity_answer.as_ref()
        {
            return Ok(ready_response(answer.clone()));
        }

        if is_openssh_session_bind_request(&packet) {
            return Ok(ready_response(Bytes::from_static(AGENT_FAILURE_FRAME)));
        }

        Ok(submit(self.broker.clone(), packet, cancellation).boxed())
    }

    fn refresh_identity_answer(&mut self) -> Result<(), IdentityError> {
        if !self.identities.has_changed().unwrap_or(false) {
            return Ok(());
        }

        self.identity_answer = derive_answer(&self.identities.borrow_and_update())?;
        Ok(())
    }
}

pub(crate) type RoutedResponse = BoxFuture<'static, Result<Bytes, RequestError>>;

fn ready_response(response: Bytes) -> RoutedResponse {
    future::ready(Ok(response)).boxed()
}

async fn submit(
    broker: mpsc::Sender<PacketRequest>,
    packet: Bytes,
    cancellation: CancellationToken,
) -> Result<Bytes, RequestError> {
    let (response, receiver) = oneshot::channel();
    broker
        .send(PacketRequest {
            packet,
            response,
            cancellation,
        })
        .await
        .map_err(|_| RequestError::Unavailable)?;

    receiver.await.unwrap_or(Err(RequestError::Unavailable))
}

fn derive_answer(identities: &Option<Vec<AgentIdentity>>) -> Result<Option<Bytes>, IdentityError> {
    identities.as_deref().map(identities_answer).transpose()
}

#[derive(Debug, Error)]
pub(crate) enum RouteError {
    #[error("paired client identities are invalid")]
    InvalidIdentities(#[from] IdentityError),
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;
    use tokio::sync::{mpsc, watch};
    use tokio_util::sync::CancellationToken;

    use crate::packet::RequestError;

    use super::RequestRouter;

    #[tokio::test]
    async fn answers_cached_identity_requests_locally() {
        let answer = crate::packet::identities_answer(&[]).unwrap();
        let (_identities, identity_updates) = watch::channel(Some(Vec::new()));
        let (broker, mut broker_requests) = mpsc::channel(1);
        let mut router = RequestRouter::new(identity_updates, broker)
            .unwrap()
            .connection()
            .unwrap();

        let response = router
            .route(
                Bytes::from_static(&[0, 0, 0, 1, 11]),
                CancellationToken::new(),
            )
            .unwrap()
            .await;

        assert_eq!(response, Ok(answer));
        assert!(broker_requests.try_recv().is_err());
    }

    #[tokio::test]
    async fn forwards_unknown_identity_requests_unchanged() {
        let (_identities, identity_updates) = watch::channel(None);
        let (broker, mut broker_requests) = mpsc::channel(1);
        let mut router = RequestRouter::new(identity_updates, broker)
            .unwrap()
            .connection()
            .unwrap();
        let cancellation = CancellationToken::new();
        let packet = Bytes::from_static(&[0, 0, 0, 1, 11]);
        let response = router.route(packet.clone(), cancellation.clone()).unwrap();
        let response_task = tokio::spawn(response);

        let forwarded = broker_requests.recv().await.unwrap();
        assert_eq!(forwarded.packet, packet);
        cancellation.cancel();
        assert!(forwarded.cancellation.is_cancelled());
        forwarded
            .response
            .send(Err(RequestError::Cancelled))
            .unwrap();
        assert_eq!(response_task.await.unwrap(), Err(RequestError::Cancelled));
    }

    #[tokio::test]
    async fn forwards_signing_requests_when_the_identity_cache_is_known() {
        let (_identities, identity_updates) = watch::channel(Some(Vec::new()));
        let (broker, mut broker_requests) = mpsc::channel(1);
        let mut router = RequestRouter::new(identity_updates, broker)
            .unwrap()
            .connection()
            .unwrap();
        let packet = Bytes::from_static(&[0, 0, 0, 1, 13]);
        let response = router
            .route(packet.clone(), CancellationToken::new())
            .unwrap();
        let response_task = tokio::spawn(response);

        let forwarded = broker_requests.recv().await.unwrap();
        assert_eq!(forwarded.packet, packet);
        forwarded
            .response
            .send(Err(RequestError::Cancelled))
            .unwrap();
        assert_eq!(response_task.await.unwrap(), Err(RequestError::Cancelled));
    }

    #[tokio::test]
    async fn rejects_openssh_session_binding_without_brokering_it() {
        let (_identities, identity_updates) = watch::channel(None);
        let (broker, mut broker_requests) = mpsc::channel(1);
        let mut router = RequestRouter::new(identity_updates, broker)
            .unwrap()
            .connection()
            .unwrap();
        let name = b"session-bind@openssh.com";
        let payload_length = 1 + 4 + name.len();
        let mut packet = Vec::new();
        packet.extend_from_slice(&(payload_length as u32).to_be_bytes());
        packet.push(27);
        packet.extend_from_slice(&(name.len() as u32).to_be_bytes());
        packet.extend_from_slice(name);

        let response = router
            .route(packet.into(), CancellationToken::new())
            .unwrap()
            .await;

        assert_eq!(response, Ok(Bytes::from_static(&[0, 0, 0, 1, 5])));
        assert!(broker_requests.try_recv().is_err());
    }
}
