use std::{
    collections::{HashMap, VecDeque},
    future,
    time::Instant,
};

use bytes::Bytes;
use futures_util::{
    FutureExt, StreamExt,
    future::{AbortHandle, Abortable, BoxFuture},
    stream::FuturesUnordered,
};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
    time::sleep_until,
};
use uuid::Uuid;

use crate::packet::{PacketRequest, RequestError};

use super::{
    BrokerConfig, BrokerError, RemoteCommand, RemoteConnection, RequestId, SessionId,
    model::{BrokerState, Effect, Event, ModelError},
};

/// Cloneable command handle for the single broker actor.
#[derive(Clone)]
pub struct BrokerHandle {
    commands: mpsc::Sender<Command>,
}

impl BrokerHandle {
    /// Start the broker actor and return its handle and task.
    pub fn spawn(
        config: BrokerConfig,
        local_requests: mpsc::Receiver<PacketRequest>,
    ) -> (Self, JoinHandle<()>) {
        let (commands, receiver) = mpsc::channel(128);
        let task = tokio::spawn(run_broker(config, local_requests, receiver));
        (Self { commands }, task)
    }

    /// Bind one remote transport in the connected-but-locked state.
    pub async fn connect_remote(&self, capacity: usize) -> Result<RemoteConnection, BrokerError> {
        if capacity == 0 {
            return Err(BrokerError::InvalidRemoteCapacity);
        }

        let (outbound, commands) = mpsc::unbounded_channel();
        let (response, receiver) = oneshot::channel();
        self.commands
            .send(Command::Connect {
                capacity,
                outbound,
                response,
            })
            .await
            .map_err(|_| BrokerError::Unavailable)?;
        let session_id = receiver.await.map_err(|_| BrokerError::Unavailable)??;

        Ok(RemoteConnection {
            session_id,
            commands,
        })
    }

    /// Record that the active session's vault can process buffered requests.
    pub async fn remote_ready(&self, session_id: SessionId) -> Result<(), BrokerError> {
        self.send_remote_event(Command::Ready { session_id }).await
    }

    /// Record that the active session must buffer requests until it unlocks.
    pub async fn remote_locked(&self, session_id: SessionId) -> Result<(), BrokerError> {
        self.send_remote_event(Command::Locked { session_id }).await
    }

    /// Remove the active session and requeue its unfinished work.
    pub async fn remote_disconnected(&self, session_id: SessionId) -> Result<(), BrokerError> {
        self.send_remote_event(Command::Disconnected { session_id })
            .await
    }

    /// Correlate a remote response with its session, request, and attempt.
    pub async fn remote_response(
        &self,
        session_id: SessionId,
        request_id: RequestId,
        attempt: u32,
        packet: Bytes,
    ) -> Result<(), BrokerError> {
        self.send_remote_event(Command::Response {
            session_id,
            request_id,
            attempt,
            packet,
        })
        .await
    }

    /// Stop the broker and fail all remaining local waiters.
    pub async fn shutdown(&self) {
        let (response, receiver) = oneshot::channel();

        if self
            .commands
            .send(Command::Shutdown { response })
            .await
            .is_ok()
        {
            let _ = receiver.await;
        }
    }

    async fn send_remote_event(&self, command: Command) -> Result<(), BrokerError> {
        self.commands
            .send(command)
            .await
            .map_err(|_| BrokerError::Unavailable)
    }
}

/// Internal messages serialized through the broker actor's mailbox.
enum Command {
    /// Claim the single remote slot and install its outbound channel.
    Connect {
        capacity: usize,
        outbound: mpsc::UnboundedSender<RemoteCommand>,
        response: oneshot::Sender<Result<SessionId, BrokerError>>,
    },

    /// Report that the remote vault can process requests.
    Ready { session_id: SessionId },

    /// Report that the remote vault can no longer process requests.
    Locked { session_id: SessionId },

    /// Remove a remote transport that has closed.
    Disconnected { session_id: SessionId },

    /// Complete one matching in-flight attempt.
    Response {
        session_id: SessionId,
        request_id: RequestId,
        attempt: u32,
        packet: Bytes,
    },

    /// Fail all waiters and acknowledge actor shutdown.
    Shutdown { response: oneshot::Sender<()> },
}

/// I/O-owning wrapper around the deterministic broker model.
struct BrokerActor {
    config: BrokerConfig,
    state: BrokerState,
    waiters: HashMap<RequestId, Waiter>,
    remote: Option<(SessionId, mpsc::UnboundedSender<RemoteCommand>)>,
}

struct Waiter {
    response: oneshot::Sender<Result<Bytes, RequestError>>,
    cancellation: AbortHandle,
}

type CancellationFuture = BoxFuture<'static, Option<RequestId>>;

async fn run_broker(
    config: BrokerConfig,
    mut local_requests: mpsc::Receiver<PacketRequest>,
    mut commands: mpsc::Receiver<Command>,
) {
    let mut actor = BrokerActor {
        config,
        state: BrokerState::new(config.max_pending_requests),
        waiters: HashMap::new(),
        remote: None,
    };
    let mut local_requests_open = true;
    let mut cancellations = FuturesUnordered::<CancellationFuture>::new();

    loop {
        let deadline = actor.state.next_deadline();

        tokio::select! {
            request = local_requests.recv(), if local_requests_open => {
                match request {
                    Some(request) => cancellations.push(actor.handle_local(request)),
                    None => local_requests_open = false,
                }
            }
            cancelled = cancellations.next(), if !cancellations.is_empty() => {
                if let Some(Some(request_id)) = cancelled {
                    actor.apply(Event::Cancelled { request_id }, Instant::now());
                }
            }
            command = commands.recv() => {
                let Some(command) = command else {
                    actor.stop();
                    return;
                };

                if actor.handle(command) {
                    return;
                }
            }
            () = wait_for_deadline(deadline) => {
                actor.apply(Event::Tick, Instant::now());
            }
        }
    }
}

async fn wait_for_deadline(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => sleep_until(deadline.into()).await,
        None => future::pending().await,
    }
}

impl BrokerActor {
    /// Admit one request received from a local transport.
    fn handle_local(&mut self, request: PacketRequest) -> CancellationFuture {
        let request_id = Uuid::new_v4();
        let now = Instant::now();
        let (abort, registration) = AbortHandle::new_pair();
        let PacketRequest {
            packet,
            response,
            cancellation,
        } = request;

        self.waiters.insert(
            request_id,
            Waiter {
                response,
                cancellation: abort,
            },
        );
        self.apply(
            Event::Submit {
                request_id,
                packet,
                deadline: now + self.config.request_timeout,
            },
            now,
        );

        Abortable::new(
            async move {
                cancellation.cancelled().await;
                request_id
            },
            registration,
        )
        .map(Result::ok)
        .boxed()
    }

    /// Translate one mailbox command into a model event or lifecycle action.
    fn handle(&mut self, command: Command) -> bool {
        let now = Instant::now();

        match command {
            Command::Connect {
                capacity,
                outbound,
                response,
            } => {
                let session_id = Uuid::new_v4();

                match self.state.apply(
                    Event::Connected {
                        session_id,
                        capacity,
                    },
                    now,
                ) {
                    Ok(effects) => {
                        self.remote = Some((session_id, outbound));
                        let _ = response.send(Ok(session_id));
                        self.execute(effects, now);
                    }
                    Err(ModelError::RemoteAlreadyConnected) => {
                        let _ = response.send(Err(BrokerError::RemoteAlreadyConnected));
                    }
                }
            }
            Command::Ready { session_id } => self.apply(Event::Ready { session_id }, now),
            Command::Locked { session_id } => self.apply(Event::Locked { session_id }, now),
            Command::Disconnected { session_id } => {
                if self
                    .remote
                    .as_ref()
                    .is_some_and(|remote| remote.0 == session_id)
                {
                    self.remote = None;
                }

                self.apply(Event::Disconnected { session_id }, now);
            }
            Command::Response {
                session_id,
                request_id,
                attempt,
                packet,
            } => self.apply(
                Event::Response {
                    session_id,
                    request_id,
                    attempt,
                    packet,
                },
                now,
            ),
            Command::Shutdown { response } => {
                self.stop();
                let _ = response.send(());
                return true;
            }
        }

        false
    }

    fn apply(&mut self, event: Event, now: Instant) {
        if let Ok(effects) = self.state.apply(event, now) {
            self.execute(effects, now);
        }
    }

    /// Execute model effects and feed transport failure back into reconciliation.
    fn execute(&mut self, initial: Vec<Effect>, now: Instant) {
        let mut effects = VecDeque::from(initial);

        while let Some(effect) = effects.pop_front() {
            match effect {
                Effect::Dispatch {
                    session_id,
                    request_id,
                    attempt,
                    packet,
                } => {
                    let sent = self
                        .remote
                        .as_ref()
                        .filter(|remote| remote.0 == session_id)
                        .is_some_and(|remote| {
                            remote
                                .1
                                .send(RemoteCommand::Request {
                                    request_id,
                                    attempt,
                                    packet,
                                })
                                .is_ok()
                        });

                    if !sent {
                        self.remote = None;

                        if let Ok(reconciled) =
                            self.state.apply(Event::Disconnected { session_id }, now)
                        {
                            effects.extend(reconciled);
                        }
                    }
                }
                Effect::Cancel {
                    session_id,
                    request_id,
                    attempt,
                } => {
                    if let Some((active, outbound)) = &self.remote
                        && *active == session_id
                    {
                        let _ = outbound.send(RemoteCommand::Cancel {
                            request_id,
                            attempt,
                        });
                    }
                }
                Effect::WakeRequired => {
                    // A later phase will forward this coalesced edge to Web Push.
                }
                Effect::Complete { request_id, result } => {
                    if let Some(waiter) = self.waiters.remove(&request_id) {
                        waiter.cancellation.abort();
                        let _ = waiter.response.send(result);
                    }
                }
            }
        }
    }

    fn stop(&mut self) {
        for (_, waiter) in self.waiters.drain() {
            waiter.cancellation.abort();
            let _ = waiter.response.send(Err(RequestError::Unavailable));
        }
    }
}
