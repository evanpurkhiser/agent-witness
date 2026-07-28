// The ssh-agent protocol (RFC 9987): message framing and the identity-list and
// signing messages an agent must serve. Built on the SSH wire codec; requests
// we do not implement are answered with a failure. The crypto is supplied by an
// `AgentBackend` so this module stays pure protocol.

import type {Bytes} from 'app/utils/bytes';

import {Reader, Writer} from './encoding';

/**
 * ssh-agent message type numbers (RFC 9987 §8.1).
 */
export enum AgentMessage {
  Failure = 5,
  Success = 6,
  RequestIdentities = 11,
  IdentitiesAnswer = 12,
  SignRequest = 13,
  SignResponse = 14,
}

/**
 * Signature-request flags (RFC 9987 §8.3), combined by bitwise OR.
 */
export enum SignFlag {
  RsaSha2_256 = 0x02,
  RsaSha2_512 = 0x04,
}

/**
 * A public identity presented to clients in an identities answer.
 */
export interface AgentIdentity {
  keyBlob: Bytes;
  comment: string;
}

/**
 * A parsed signing request.
 */
export interface SignRequest {
  keyBlob: Bytes;
  data: Bytes;
  flags: number;
}

/**
 * The operations the agent needs from the vault. Kept as an interface so the
 * protocol code has no crypto or vault dependency.
 */
export interface AgentBackend {
  /**
   * The public identities to present to clients.
   */
  listIdentities(): AgentIdentity[] | Promise<AgentIdentity[]>;
  /**
   * Produce the SSH signature blob for a request, or reject if the key is
   * unknown.
   */
  sign(request: SignRequest): Promise<Bytes>;
}

/**
 * Wrap a message payload (type byte + contents) with its uint32 length prefix.
 */
export function frame(payload: Uint8Array): Bytes {
  return new Writer().u32(payload.length).bytes(payload).finish();
}

/**
 * Read one complete framed message off a buffer, returning its payload (without
 * the length prefix) and bytes consumed, or null if the buffer is incomplete.
 */
export function readFrame(buf: Uint8Array): {payload: Bytes; consumed: number} | null {
  if (buf.length < 4) {
    return null;
  }
  const length = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0);
  if (buf.length < 4 + length) {
    return null;
  }
  return {payload: buf.slice(4, 4 + length), consumed: 4 + length};
}

/**
 * Encode a framed IDENTITIES_ANSWER for the given identities.
 */
export function encodeIdentitiesAnswer(identities: AgentIdentity[]): Bytes {
  const writer = identities.reduce(
    (w, identity) => w.string(identity.keyBlob).string(identity.comment),
    new Writer().u8(AgentMessage.IdentitiesAnswer).u32(identities.length),
  );
  return frame(writer.finish());
}

/**
 * Encode a framed SIGN_RESPONSE wrapping a signature blob.
 */
export function encodeSignResponse(signature: Uint8Array): Bytes {
  return frame(new Writer().u8(AgentMessage.SignResponse).string(signature).finish());
}

/**
 * Encode a framed bare FAILURE.
 */
export function encodeFailure(): Bytes {
  return frame(new Uint8Array([AgentMessage.Failure]));
}

/**
 * Parse a SIGN_REQUEST payload into its key blob, data, and flags.
 */
export function parseSignRequest(payload: Uint8Array): SignRequest {
  const reader = new Reader(payload);
  if (reader.u8() !== AgentMessage.SignRequest) {
    throw new Error('not a SIGN_REQUEST');
  }
  return {
    keyBlob: reader.string().slice(),
    data: reader.string().slice(),
    flags: reader.u32(),
  };
}

/**
 * Map SIGN_REQUEST flags to the requested RSA algorithm, defaulting to
 * rsa-sha2-256 (SHA-1 ssh-rsa is not supported).
 */
export function rsaFlavorFromFlags(flags: number): 'rsa-sha2-256' | 'rsa-sha2-512' {
  return (flags & SignFlag.RsaSha2_512) !== 0 ? 'rsa-sha2-512' : 'rsa-sha2-256';
}

/**
 * Sign a request via the backend, returning a SIGN_RESPONSE, or a FAILURE if the
 * backend cannot (unknown key, parse error).
 */
async function signOrFail(payload: Uint8Array, backend: AgentBackend): Promise<Bytes> {
  try {
    return encodeSignResponse(await backend.sign(parseSignRequest(payload)));
  } catch {
    return encodeFailure();
  }
}

/**
 * Serve one agent request payload (type byte + contents), returning the framed
 * response. Only identity listing and signing are implemented; anything else
 * gets a failure.
 */
export async function handleAgentRequest(
  payload: Uint8Array,
  backend: AgentBackend,
): Promise<Bytes> {
  const type = payload[0];

  if (type === AgentMessage.RequestIdentities) {
    return encodeIdentitiesAnswer(await backend.listIdentities());
  }
  if (type === AgentMessage.SignRequest) {
    return signOrFail(payload, backend);
  }
  return encodeFailure();
}
