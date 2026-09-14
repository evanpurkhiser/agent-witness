//! Classifies SSH-agent packets and routes them to local or remote handlers.

use bytes::Bytes;
use futures_util::{FutureExt, future, future::BoxFuture};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_util::sync::CancellationToken;

use crate::packet::{
    AgentIdentity, IdentityError, PacketRequest, RequestContext, RequestError, identities_answer,
    is_identity_request, is_openssh_session_bind_request,
};

use self::context::ContextError;

mod context;

const AGENT_FAILURE_FRAME: &[u8] = &[0, 0, 0, 1, 5];
const AGENT_SUCCESS_FRAME: &[u8] = &[0, 0, 0, 1, 6];

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

/// Packet router and negotiated state for one socket connection.
pub struct ConnectionRouter {
    identities: watch::Receiver<Option<Vec<AgentIdentity>>>,
    identity_answer: Option<Bytes>,
    broker: mpsc::Sender<PacketRequest>,
    context: Option<RequestContext>,
    accepts_context: bool,
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
            context: None,
            accepts_context: true,
        })
    }

    /// Classify a packet immediately and return its eventual response.
    pub(crate) fn route(
        &mut self,
        packet: Bytes,
        cancellation: CancellationToken,
    ) -> Result<RoutedResponse, RouteError> {
        self.refresh_identity_answer()?;

        match context::decode(&packet) {
            Ok(Some(received)) if self.accepts_context => {
                self.context = Some(received);
                self.accepts_context = false;

                return Ok(ready_response(Bytes::from_static(AGENT_SUCCESS_FRAME)));
            }
            Ok(Some(_)) => return Err(RouteError::LateContext),
            Err(error) => return Err(RouteError::InvalidContext(error)),
            Ok(None) => self.accepts_context = false,
        }

        if is_identity_request(&packet)
            && let Some(answer) = self.identity_answer.as_ref()
        {
            return Ok(ready_response(answer.clone()));
        }

        if is_openssh_session_bind_request(&packet) {
            return Ok(ready_response(Bytes::from_static(AGENT_FAILURE_FRAME)));
        }

        Ok(submit(
            self.broker.clone(),
            packet,
            self.context.clone(),
            cancellation,
        )
        .boxed())
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
    context: Option<RequestContext>,
    cancellation: CancellationToken,
) -> Result<Bytes, RequestError> {
    let (response, receiver) = oneshot::channel();
    broker
        .send(PacketRequest {
            packet,
            context,
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

    #[error(transparent)]
    InvalidContext(#[from] ContextError),

    #[error("Agent Witness context extension arrived after the first packet")]
    LateContext,
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;
    use tokio::sync::{mpsc, watch};
    use tokio_util::sync::CancellationToken;

    use crate::packet::{RequestContext, RequestError};

    use super::{RequestRouter, RouteError};

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

    #[tokio::test]
    async fn associates_initial_context_with_every_connection_request() {
        let (_identities, identity_updates) = watch::channel(None);
        let (broker, mut broker_requests) = mpsc::channel(2);
        let mut router = RequestRouter::new(identity_updates, broker)
            .unwrap()
            .connection()
            .unwrap();
        let context = RequestContext {
            group_id: "release-123".into(),
            reason: "Push the release".into(),
            command: vec!["git".into(), "push".into()],
        };

        assert_eq!(
            router
                .route(context_packet(&context, 1), CancellationToken::new())
                .unwrap()
                .await,
            Ok(Bytes::from_static(&[0, 0, 0, 1, 6]))
        );

        let first_response = router
            .route(
                Bytes::from_static(&[0, 0, 0, 1, 11]),
                CancellationToken::new(),
            )
            .unwrap();
        let second_response = router
            .route(
                Bytes::from_static(&[0, 0, 0, 1, 13]),
                CancellationToken::new(),
            )
            .unwrap();
        let responses = tokio::spawn(async move { tokio::join!(first_response, second_response) });

        let first = broker_requests.recv().await.unwrap();
        let second = broker_requests.recv().await.unwrap();
        assert_eq!(first.context, Some(context.clone()));
        assert_eq!(second.context, Some(context));
        first.response.send(Ok(Bytes::new())).unwrap();
        second.response.send(Ok(Bytes::new())).unwrap();
        let _ = responses.await.unwrap();
    }

    #[tokio::test]
    async fn isolates_context_between_connections() {
        let (_identities, identity_updates) = watch::channel(None);
        let (broker, mut broker_requests) = mpsc::channel(2);
        let factory = RequestRouter::new(identity_updates, broker).unwrap();
        let mut contextual = factory.connection().unwrap();
        let mut ordinary = factory.connection().unwrap();
        let context = RequestContext {
            group_id: "release-123".into(),
            reason: "Push the release".into(),
            command: vec!["git".into(), "push".into()],
        };

        let _acknowledgement = contextual
            .route(context_packet(&context, 1), CancellationToken::new())
            .unwrap();
        let contextual_response = contextual
            .route(
                Bytes::from_static(&[0, 0, 0, 1, 13]),
                CancellationToken::new(),
            )
            .unwrap();
        let ordinary_response = ordinary
            .route(
                Bytes::from_static(&[0, 0, 0, 1, 13]),
                CancellationToken::new(),
            )
            .unwrap();
        let responses =
            tokio::spawn(async move { tokio::join!(contextual_response, ordinary_response) });

        let first = broker_requests.recv().await.unwrap();
        let second = broker_requests.recv().await.unwrap();
        let contexts = [first.context.clone(), second.context.clone()];
        assert!(contexts.contains(&Some(context)));
        assert!(contexts.contains(&None));
        first.response.send(Ok(Bytes::new())).unwrap();
        second.response.send(Ok(Bytes::new())).unwrap();
        let _ = responses.await.unwrap();
    }

    #[test]
    fn rejects_context_after_the_first_packet() {
        let (_identities, identity_updates) = watch::channel(None);
        let (broker, _broker_requests) = mpsc::channel(1);
        let mut router = RequestRouter::new(identity_updates, broker)
            .unwrap()
            .connection()
            .unwrap();
        let context = RequestContext {
            group_id: "release-123".into(),
            reason: "Push the release".into(),
            command: vec!["git".into(), "push".into()],
        };

        let _response = router
            .route(
                Bytes::from_static(&[0, 0, 0, 1, 11]),
                CancellationToken::new(),
            )
            .unwrap();

        assert!(matches!(
            router.route(context_packet(&context, 1), CancellationToken::new()),
            Err(RouteError::LateContext)
        ));
    }

    fn context_packet(context: &RequestContext, version: u8) -> Bytes {
        let name = b"context@agent-witness";
        let mut payload = vec![27];
        push_string(&mut payload, name);
        payload.push(version);
        push_string(&mut payload, context.group_id.as_bytes());
        push_string(&mut payload, context.reason.as_bytes());
        payload.extend_from_slice(&(context.command.len() as u32).to_be_bytes());
        for argument in &context.command {
            push_string(&mut payload, argument.as_bytes());
        }

        let mut packet = Vec::with_capacity(payload.len() + 4);
        packet.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        packet.extend_from_slice(&payload);
        packet.into()
    }

    fn push_string(packet: &mut Vec<u8>, value: &[u8]) {
        packet.extend_from_slice(&(value.len() as u32).to_be_bytes());
        packet.extend_from_slice(value);
    }
}
