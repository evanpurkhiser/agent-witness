use std::{
    collections::{HashMap, VecDeque},
    time::Instant,
};

use bytes::Bytes;
use thiserror::Error;

use crate::packet::RequestError;

use super::{RequestId, SessionId};

/// Availability facts for the single remote agent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RemoteAgentState {
    Disconnected,
    Locked {
        session_id: SessionId,
        capacity: usize,
    },
    Ready {
        session_id: SessionId,
        capacity: usize,
    },
}

impl RemoteAgentState {
    fn session(self) -> Option<SessionId> {
        match self {
            Self::Disconnected => None,
            Self::Locked { session_id, .. } | Self::Ready { session_id, .. } => Some(session_id),
        }
    }
}

/// Pure request state and reconciliation rules.
pub(super) struct BrokerState {
    agent: RemoteAgentState,

    /// Authoritative set of all queued and in-flight requests.
    pending: HashMap<RequestId, PendingRequest>,

    /// FIFO subset of pending requests that have not been dispatched.
    queue: VecDeque<RequestId>,

    max_pending_requests: usize,
    next_sequence: u64,
    wake_announced: bool,
}

impl BrokerState {
    pub(super) fn new(max_pending_requests: usize) -> Self {
        Self {
            agent: RemoteAgentState::Disconnected,
            pending: HashMap::new(),
            queue: VecDeque::new(),
            max_pending_requests,
            next_sequence: 0,
            wake_announced: false,
        }
    }

    /// Apply one fact change, expire overdue work, then reconcile all gates.
    pub(super) fn apply(&mut self, event: Event, now: Instant) -> Result<Vec<Effect>, ModelError> {
        let mut effects = self.expire(now);

        match event {
            Event::Submit {
                request_id,
                packet,
                deadline,
                deadline_timestamp,
            } => {
                if self.pending.len() >= self.max_pending_requests {
                    effects.push(Effect::Complete {
                        request_id,
                        result: Err(RequestError::QueueFull),
                    });
                } else {
                    let sequence = self.next_sequence;
                    self.next_sequence += 1;
                    self.pending.insert(
                        request_id,
                        PendingRequest {
                            packet,
                            deadline,
                            deadline_timestamp,
                            sequence,
                            attempt: 0,
                            state: PendingState::Queued,
                        },
                    );
                    self.queue.push_back(request_id);
                }
            }
            Event::Connected {
                session_id,
                capacity,
            } => {
                if self.agent != RemoteAgentState::Disconnected {
                    return Err(ModelError::RemoteAlreadyConnected);
                }

                self.agent = RemoteAgentState::Locked {
                    session_id,
                    capacity,
                };
                self.wake_announced = false;
            }
            Event::Ready { session_id } => match self.agent {
                RemoteAgentState::Locked {
                    session_id: active,
                    capacity,
                }
                | RemoteAgentState::Ready {
                    session_id: active,
                    capacity,
                } if active == session_id => {
                    self.agent = RemoteAgentState::Ready {
                        session_id,
                        capacity,
                    };
                }
                _ => {}
            },
            Event::Locked { session_id } => {
                if self.agent.session() == Some(session_id) {
                    let capacity = match self.agent {
                        RemoteAgentState::Locked { capacity, .. }
                        | RemoteAgentState::Ready { capacity, .. } => capacity,
                        RemoteAgentState::Disconnected => unreachable!(),
                    };

                    self.agent = RemoteAgentState::Locked {
                        session_id,
                        capacity,
                    };
                }
            }
            Event::Disconnected { session_id } => {
                if self.agent.session() == Some(session_id) {
                    self.requeue_session(session_id);
                    self.agent = RemoteAgentState::Disconnected;
                    self.wake_announced = false;
                }
            }
            Event::Response {
                session_id,
                request_id,
                attempt,
                packet,
            } => {
                let matches = self.pending.get(&request_id).is_some_and(|pending| {
                    pending.state
                        == PendingState::InFlight {
                            session_id,
                            attempt,
                        }
                });

                if matches {
                    self.pending.remove(&request_id);
                    effects.push(Effect::Complete {
                        request_id,
                        result: Ok(packet),
                    });
                }
            }
            Event::Cancelled { request_id } => {
                if let Some(pending) = self.pending.remove(&request_id) {
                    self.queue.retain(|queued| *queued != request_id);

                    if let PendingState::InFlight {
                        session_id,
                        attempt,
                    } = pending.state
                    {
                        effects.push(Effect::Cancel {
                            session_id,
                            request_id,
                            attempt,
                        });
                    }

                    effects.push(Effect::Complete {
                        request_id,
                        result: Err(RequestError::Cancelled),
                    });
                }
            }
            Event::Tick => {}
        }

        effects.extend(self.reconcile());
        Ok(effects)
    }

    pub(super) fn next_deadline(&self) -> Option<Instant> {
        self.pending.values().map(|pending| pending.deadline).min()
    }

    /// Remove every expired request before considering new dispatches.
    fn expire(&mut self, now: Instant) -> Vec<Effect> {
        let mut expired: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, pending)| pending.deadline <= now)
            .map(|(request_id, pending)| (*request_id, pending.sequence))
            .collect();
        expired.sort_by_key(|(_, sequence)| *sequence);

        let expired_ids: Vec<_> = expired.iter().map(|(request_id, _)| *request_id).collect();
        self.queue
            .retain(|request_id| !expired_ids.contains(request_id));

        expired
            .into_iter()
            .flat_map(|(request_id, _)| {
                let pending = self.pending.remove(&request_id).unwrap();
                let mut effects = Vec::new();

                if let PendingState::InFlight {
                    session_id,
                    attempt,
                } = pending.state
                {
                    effects.push(Effect::Cancel {
                        session_id,
                        request_id,
                        attempt,
                    });
                }

                effects.push(Effect::Complete {
                    request_id,
                    result: Err(RequestError::TimedOut),
                });
                effects
            })
            .collect()
    }

    /// Dispatch to any connected worker, or announce that an offline worker is needed.
    fn reconcile(&mut self) -> Vec<Effect> {
        let mut effects = Vec::new();

        if let Some((session_id, capacity)) = self.connected_remote() {
            let mut in_flight = self.in_flight_for(session_id);

            while in_flight < capacity {
                let Some(request_id) = self.queue.pop_front() else {
                    break;
                };
                let Some(pending) = self.pending.get_mut(&request_id) else {
                    continue;
                };

                pending.attempt += 1;
                pending.state = PendingState::InFlight {
                    session_id,
                    attempt: pending.attempt,
                };
                effects.push(Effect::Dispatch {
                    session_id,
                    request_id,
                    attempt: pending.attempt,
                    deadline: pending.deadline_timestamp,
                    packet: pending.packet.clone(),
                });
                in_flight += 1;
            }
        }

        if self.queue.is_empty() || self.agent.session().is_some() {
            self.wake_announced = false;
        } else if !self.wake_announced {
            self.wake_announced = true;
            effects.push(Effect::WakeRequired);
        }

        effects
    }

    fn connected_remote(&self) -> Option<(SessionId, usize)> {
        match self.agent {
            RemoteAgentState::Disconnected => None,
            RemoteAgentState::Locked {
                session_id,
                capacity,
            }
            | RemoteAgentState::Ready {
                session_id,
                capacity,
            } => Some((session_id, capacity)),
        }
    }

    fn in_flight_for(&self, session_id: SessionId) -> usize {
        self.pending
            .values()
            .filter(|pending| {
                matches!(
                    pending.state,
                    PendingState::InFlight {
                        session_id: active,
                        ..
                    } if active == session_id
                )
            })
            .count()
    }

    /// Return one session's unfinished work to the front of the FIFO queue.
    fn requeue_session(&mut self, session_id: SessionId) {
        let mut requeued: Vec<_> = self
            .pending
            .iter_mut()
            .filter_map(|(request_id, pending)| match pending.state {
                PendingState::InFlight {
                    session_id: active, ..
                } if active == session_id => {
                    pending.state = PendingState::Queued;
                    Some((*request_id, pending.sequence))
                }
                _ => None,
            })
            .collect();
        requeued.sort_by_key(|(_, sequence)| *sequence);

        self.queue = requeued
            .into_iter()
            .map(|(request_id, _)| request_id)
            .chain(self.queue.drain(..))
            .collect();
    }
}

struct PendingRequest {
    packet: Bytes,
    deadline: Instant,
    deadline_timestamp: u64,
    sequence: u64,
    attempt: u32,
    state: PendingState,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PendingState {
    Queued,
    InFlight { session_id: SessionId, attempt: u32 },
}

/// Facts that can change broker state.
pub(super) enum Event {
    Submit {
        request_id: RequestId,
        packet: Bytes,
        deadline: Instant,
        deadline_timestamp: u64,
    },
    Connected {
        session_id: SessionId,
        capacity: usize,
    },
    Ready {
        session_id: SessionId,
    },
    Locked {
        session_id: SessionId,
    },
    Disconnected {
        session_id: SessionId,
    },
    Response {
        session_id: SessionId,
        request_id: RequestId,
        attempt: u32,
        packet: Bytes,
    },
    Cancelled {
        request_id: RequestId,
    },
    Tick,
}

/// Side effects produced by reconciliation and executed by the actor.
pub(super) enum Effect {
    Dispatch {
        session_id: SessionId,
        request_id: RequestId,
        attempt: u32,
        deadline: u64,
        packet: Bytes,
    },
    Cancel {
        session_id: SessionId,
        request_id: RequestId,
        attempt: u32,
    },
    WakeRequired,
    Complete {
        request_id: RequestId,
        result: Result<Bytes, RequestError>,
    },
}

#[derive(Debug, Error)]
pub(super) enum ModelError {
    #[error("a remote agent is already connected")]
    RemoteAlreadyConnected,
}
