export type VaultLockReason = 'manual' | 'backgrounded' | 'disconnected';

interface EventBase {
  id: string;
  at: number;
}

export type AgentEvent =
  | (EventBase & {type: 'vault_unlocked'})
  | (EventBase & {type: 'vault_locked'; reason: VaultLockReason})
  | (EventBase & {
      type: 'request_pending';
      requestId: string;
      bytes: number;
    })
  | (EventBase & {
      type: 'request_signing';
      requestId: string;
      bytes: number;
      fingerprint: string;
    })
  | (EventBase & {type: 'request_closed'; requestId: string});

export type NewAgentEvent = AgentEvent extends infer Event
  ? Event extends AgentEvent
    ? Omit<Event, keyof EventBase>
    : never
  : never;
