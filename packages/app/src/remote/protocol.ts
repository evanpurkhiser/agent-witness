// The named-field MessagePack contract shared with the server. UUIDs remain
// strings on the wire, while credentials and complete ssh-agent packets use
// MessagePack's binary representation.

import {decode as decodeMessagePack, encode as encodeMessagePack} from '@msgpack/msgpack';
import {objectToCamel, objectToSnake} from 'ts-case-convert';
import {z} from 'zod';

import type {Bytes} from 'app/utils/bytes';

export const protocolVersion = 1;

const MAX_LABEL_LENGTH = 128;
const MAX_CREDENTIAL_LENGTH = 128;
const MAX_PUSH_ENDPOINT_LENGTH = 4096;
const MAX_U32 = 0xffffffff;

const bytesSchema = z.custom<Bytes>(
  value => value instanceof Uint8Array && value.buffer instanceof ArrayBuffer,
  'expected MessagePack binary data',
);
const credentialSchema = bytesSchema.refine(
  value => value.length > 0 && value.length <= MAX_CREDENTIAL_LENGTH,
  `credential must contain between 1 and ${MAX_CREDENTIAL_LENGTH} bytes`,
);
const vapidPublicKeySchema = bytesSchema.refine(
  value => value.length === 65 && value[0] === 4,
  'VAPID public key must be a 65-byte uncompressed P-256 point',
);
const labelSchema = z.string().refine(value => {
  const length = new TextEncoder().encode(value).length;
  return length > 0 && length <= MAX_LABEL_LENGTH;
}, `label must contain between 1 and ${MAX_LABEL_LENGTH} UTF-8 bytes`);
const attemptSchema = z.number().int().min(0).max(MAX_U32);
const pushEndpointSchema = z
  .url()
  .refine(
    value => new TextEncoder().encode(value).length <= MAX_PUSH_ENDPOINT_LENGTH,
    `push endpoint cannot exceed ${MAX_PUSH_ENDPOINT_LENGTH} UTF-8 bytes`,
  )
  .refine(value => new URL(value).protocol === 'https:', 'push endpoint must use HTTPS');
const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, 'expected base64url');
const p256dhSchema = base64UrlSchema.length(
  87,
  'p256dh must encode a 65-byte P-256 public key',
);
const authSecretSchema = base64UrlSchema.length(22, 'auth must encode a 16-byte secret');
const expirationTimeSchema = z.number().int().nonnegative().safe().nullable();

const clientWireMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('pair_request'),
    label: labelSchema,
  }),
  z.object({
    type: z.literal('authenticate'),
    client_id: z.uuid(),
    credential: credentialSchema,
  }),
  z.object({
    type: z.literal('agent_ready'),
  }),
  z.object({
    type: z.literal('agent_locked'),
  }),
  z.object({
    type: z.literal('agent_response'),
    request_id: z.uuid(),
    attempt: attemptSchema,
    packet: bytesSchema,
  }),
  z.object({
    type: z.literal('set_push_subscription'),
    endpoint: pushEndpointSchema,
    expiration_time: expirationTimeSchema,
    p256_dh: p256dhSchema,
    auth: authSecretSchema,
  }),
  z.object({
    type: z.literal('pong'),
  }),
]);

const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('pair_request'),
    label: labelSchema,
  }),
  z.object({
    type: z.literal('authenticate'),
    clientId: z.uuid(),
    credential: credentialSchema,
  }),
  z.object({
    type: z.literal('agent_ready'),
  }),
  z.object({
    type: z.literal('agent_locked'),
  }),
  z.object({
    type: z.literal('agent_response'),
    requestId: z.uuid(),
    attempt: attemptSchema,
    packet: bytesSchema,
  }),
  z.object({
    type: z.literal('set_push_subscription'),
    endpoint: pushEndpointSchema,
    expirationTime: expirationTimeSchema,
    p256Dh: p256dhSchema,
    auth: authSecretSchema,
  }),
  z.object({
    type: z.literal('pong'),
  }),
]);

const serverWireMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('paired'),
    server_id: z.uuid(),
    client_id: z.uuid(),
    credential: credentialSchema,
    session_id: z.uuid(),
    vapid_public_key: vapidPublicKeySchema,
  }),
  z.object({
    type: z.literal('authenticated'),
    server_id: z.uuid(),
    session_id: z.uuid(),
    vapid_public_key: vapidPublicKeySchema,
  }),
  z.object({
    type: z.literal('rejected'),
  }),
  z.object({
    type: z.literal('agent_request'),
    request_id: z.uuid(),
    attempt: attemptSchema,
    packet: bytesSchema,
  }),
  z.object({
    type: z.literal('cancel_request'),
    request_id: z.uuid(),
    attempt: attemptSchema,
  }),
  z.object({
    type: z.literal('ping'),
  }),
]);

const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('paired'),
    serverId: z.uuid(),
    clientId: z.uuid(),
    credential: credentialSchema,
    sessionId: z.uuid(),
    vapidPublicKey: vapidPublicKeySchema,
  }),
  z.object({
    type: z.literal('authenticated'),
    serverId: z.uuid(),
    sessionId: z.uuid(),
    vapidPublicKey: vapidPublicKeySchema,
  }),
  z.object({
    type: z.literal('rejected'),
  }),
  z.object({
    type: z.literal('agent_request'),
    requestId: z.uuid(),
    attempt: attemptSchema,
    packet: bytesSchema,
  }),
  z.object({
    type: z.literal('cancel_request'),
    requestId: z.uuid(),
    attempt: attemptSchema,
  }),
  z.object({
    type: z.literal('ping'),
  }),
]);

const clientMessageCodec = z.codec(clientWireMessageSchema, clientMessageSchema, {
  decode: message => objectToCamel(message) as z.output<typeof clientMessageSchema>,
  encode: message => objectToSnake(message) as z.output<typeof clientWireMessageSchema>,
});

const serverMessageCodec = z.codec(serverWireMessageSchema, serverMessageSchema, {
  decode: message => objectToCamel(message) as z.output<typeof serverMessageSchema>,
  encode: message => objectToSnake(message) as z.output<typeof serverWireMessageSchema>,
});

export type ClientMessage = z.output<typeof clientMessageCodec>;
export type ServerMessage = z.output<typeof serverMessageCodec>;

export type ClientHandshake = Extract<
  ClientMessage,
  {type: 'pair_request' | 'authenticate'}
>;

export type ServerHandshake = Extract<
  ServerMessage,
  {type: 'paired' | 'authenticated' | 'rejected'}
>;

function messagePackCodec<Schema extends z.core.$ZodType>(schema: Schema) {
  return z.codec(bytesSchema, schema, {
    decode: frame => decodeMessagePack(frame) as z.input<Schema>,
    encode: encodeMessagePack,
  });
}

const clientCodec = messagePackCodec(
  z.object({
    version: z.literal(protocolVersion),
    message: clientMessageCodec,
  }),
);
const serverCodec = messagePackCodec(
  z.object({
    version: z.literal(protocolVersion),
    message: serverMessageCodec,
  }),
);

/**
 * Encode and validate one client message as a versioned named-field
 * MessagePack envelope.
 */
export function encodeClientMessage(message: ClientMessage): Bytes {
  return clientCodec.encode({version: protocolVersion, message});
}

/**
 * Decode and validate one server MessagePack envelope received from the
 * WebSocket.
 */
export function decodeServerMessage(frame: Bytes): ServerMessage {
  return serverCodec.decode(frame).message;
}
