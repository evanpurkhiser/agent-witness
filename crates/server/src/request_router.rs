//! Routes locally answerable SSH-agent requests before remote brokering.

use bytes::Bytes;
use tokio::sync::{mpsc, watch};

use crate::packet::{
    AgentIdentity, IdentityError, PacketRequest, RequestError, identities_answer,
    is_identity_request, is_openssh_session_bind_request,
};

const AGENT_FAILURE_FRAME: &[u8] = &[0, 0, 0, 1, 5];

/// Routes identity discovery to the local cache and forwards other requests.
pub struct RequestRouter {
    identities: watch::Receiver<Option<Vec<AgentIdentity>>>,
    identity_answer: Option<Bytes>,
}

impl RequestRouter {
    pub fn new(
        identities: watch::Receiver<Option<Vec<AgentIdentity>>>,
    ) -> Result<Self, IdentityError> {
        let identity_answer = derive_answer(&identities.borrow())?;

        Ok(Self {
            identities,
            identity_answer,
        })
    }

    /// Serve requests until the local socket closes all request senders.
    pub async fn serve(
        mut self,
        mut requests: mpsc::Receiver<PacketRequest>,
        broker: mpsc::Sender<PacketRequest>,
    ) -> Result<(), IdentityError> {
        while let Some(request) = requests.recv().await {
            self.refresh_identity_answer()?;

            if is_identity_request(&request.packet)
                && let Some(answer) = self.identity_answer.as_ref()
            {
                let _ = request.response.send(Ok(answer.clone()));
                continue;
            }

            if is_openssh_session_bind_request(&request.packet) {
                let _ = request
                    .response
                    .send(Ok(Bytes::from_static(AGENT_FAILURE_FRAME)));
                continue;
            }

            if let Err(error) = broker.send(request).await {
                let request = error.0;
                let _ = request.response.send(Err(RequestError::Unavailable));
            }
        }

        Ok(())
    }

    fn refresh_identity_answer(&mut self) -> Result<(), IdentityError> {
        if !self.identities.has_changed().unwrap_or(false) {
            return Ok(());
        }

        self.identity_answer = derive_answer(&self.identities.borrow_and_update())?;
        Ok(())
    }
}

fn derive_answer(identities: &Option<Vec<AgentIdentity>>) -> Result<Option<Bytes>, IdentityError> {
    identities.as_deref().map(identities_answer).transpose()
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;
    use tokio::sync::{mpsc, oneshot, watch};
    use tokio_util::sync::CancellationToken;

    use crate::packet::PacketRequest;

    use super::RequestRouter;

    #[tokio::test]
    async fn answers_cached_identity_requests_locally() {
        let answer = crate::packet::identities_answer(&[]).unwrap();
        let (_identities, identity_updates) = watch::channel(Some(Vec::new()));
        let (requests, incoming_requests) = mpsc::channel(1);
        let (broker, mut broker_requests) = mpsc::channel(1);
        let router = RequestRouter::new(identity_updates).unwrap();
        let task = tokio::spawn(router.serve(incoming_requests, broker));
        let (response, receiver) = oneshot::channel();

        requests
            .send(PacketRequest {
                packet: Bytes::from_static(&[0, 0, 0, 1, 11]),
                response,
                cancellation: CancellationToken::new(),
            })
            .await
            .unwrap();

        assert_eq!(receiver.await.unwrap(), Ok(answer));
        assert!(broker_requests.try_recv().is_err());

        drop(requests);
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn forwards_unknown_identity_requests_unchanged() {
        let (_identities, identity_updates) = watch::channel(None);
        let (requests, incoming_requests) = mpsc::channel(1);
        let (broker, mut broker_requests) = mpsc::channel(1);
        let router = RequestRouter::new(identity_updates).unwrap();
        let task = tokio::spawn(router.serve(incoming_requests, broker));
        let cancellation = CancellationToken::new();
        let (response, _receiver) = oneshot::channel();
        let packet = Bytes::from_static(&[0, 0, 0, 1, 11]);

        requests
            .send(PacketRequest {
                packet: packet.clone(),
                response,
                cancellation: cancellation.clone(),
            })
            .await
            .unwrap();

        let forwarded = broker_requests.recv().await.unwrap();
        assert_eq!(forwarded.packet, packet);
        cancellation.cancel();
        assert!(forwarded.cancellation.is_cancelled());

        drop(requests);
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn forwards_signing_requests_when_the_identity_cache_is_known() {
        let (_identities, identity_updates) = watch::channel(Some(Vec::new()));
        let (requests, incoming_requests) = mpsc::channel(1);
        let (broker, mut broker_requests) = mpsc::channel(1);
        let router = RequestRouter::new(identity_updates).unwrap();
        let task = tokio::spawn(router.serve(incoming_requests, broker));
        let (response, _receiver) = oneshot::channel();
        let packet = Bytes::from_static(&[0, 0, 0, 1, 13]);

        requests
            .send(PacketRequest {
                packet: packet.clone(),
                response,
                cancellation: CancellationToken::new(),
            })
            .await
            .unwrap();

        assert_eq!(broker_requests.recv().await.unwrap().packet, packet);

        drop(requests);
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn rejects_openssh_session_binding_without_brokering_it() {
        let (_identities, identity_updates) = watch::channel(None);
        let (requests, incoming_requests) = mpsc::channel(1);
        let (broker, mut broker_requests) = mpsc::channel(1);
        let router = RequestRouter::new(identity_updates).unwrap();
        let task = tokio::spawn(router.serve(incoming_requests, broker));
        let (response, receiver) = oneshot::channel();
        let name = b"session-bind@openssh.com";
        let payload_length = 1 + 4 + name.len();
        let mut packet = Vec::new();
        packet.extend_from_slice(&(payload_length as u32).to_be_bytes());
        packet.push(27);
        packet.extend_from_slice(&(name.len() as u32).to_be_bytes());
        packet.extend_from_slice(name);

        requests
            .send(PacketRequest {
                packet: packet.into(),
                response,
                cancellation: CancellationToken::new(),
            })
            .await
            .unwrap();

        assert_eq!(
            receiver.await.unwrap(),
            Ok(Bytes::from_static(&[0, 0, 0, 1, 5]))
        );
        assert!(broker_requests.try_recv().is_err());

        drop(requests);
        task.await.unwrap().unwrap();
    }
}
