import {encode} from '@msgpack/msgpack';
import {describe, expect, it} from 'vitest';

import type {Bytes} from 'app/utils/bytes';

import {decodeServerMessage, encodeClientMessage} from './protocol';

const SERVER_ID = '11111111-2222-4333-8444-555555555555';
const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SESSION_ID = '12345678-9abc-4def-8123-456789abcdef';
const VAPID_PUBLIC_KEY = bytes(4, ...Array.from({length: 64}, () => 1));
const P256DH =
  'BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU';
const AUTH = 'AAECAwQFBgcICQoLDA0ODw';

// Produced by rmp-serde::to_vec_named from the matching Rust protocol types.
const RUST_CLIENT_AUTHENTICATE = fromHex(`
  82a776657273696f6e01a76d65737361676583a474797065ac61757468656e746963617465
  a9636c69656e745f6964d92431313131313131312d323232322d343333332d383434342d35
  3535353535353535353535aa63726564656e7469616cc404deadbeef
`);
const RUST_CLIENT_AGENT_RESPONSE = fromHex(`
  82a776657273696f6e01a76d65737361676584a474797065ae6167656e745f726573706f6e
  7365aa726571756573745f6964d92461616161616161612d626262622d346363632d386464
  642d656565656565656565656565a7617474656d707404a67061636b6574c4050000000106
`);
const RUST_SERVER_PAIRED = fromHex(`
  82a776657273696f6e01a76d65737361676586a474797065a6706169726564a97365727665725f69
  64d92431313131313131312d323232322d343333332d383434342d353535353535353535353535a9
  636c69656e745f6964d92461616161616161612d626262622d346363632d386464642d6565656565
  65656565656565aa63726564656e7469616cc404deadbeefaa73657373696f6e5f6964d924313233
  34353637382d396162632d346465662d383132332d343536373839616263646566b076617069645f
  7075626c69635f6b6579c44104010101010101010101010101010101010101010101010101010101
  01010101010101010101010101010101010101010101010101010101010101010101010101
`);
const RUST_SERVER_AGENT_REQUEST = fromHex(`
  82a776657273696f6e01a76d65737361676584a474797065ad6167656e745f726571756573
  74aa726571756573745f6964d92461616161616161612d626262622d346363632d38646464
  2d656565656565656565656565a7617474656d707404a67061636b6574c405000000010b
`);

describe('encodeClientMessage', () => {
  it('matches the Rust authentication fixture', () => {
    const encoded = encodeClientMessage({
      type: 'authenticate',
      clientId: SERVER_ID,
      credential: bytes(0xde, 0xad, 0xbe, 0xef),
    });

    expect(encoded).toEqual(RUST_CLIENT_AUTHENTICATE);
  });

  it('matches the Rust agent-response fixture', () => {
    const encoded = encodeClientMessage({
      type: 'agent_response',
      requestId: CLIENT_ID,
      attempt: 4,
      packet: bytes(0, 0, 0, 1, 6),
    });

    expect(encoded).toEqual(RUST_CLIENT_AGENT_RESPONSE);
  });

  it.each([
    {type: 'pair_request', label: 'iPhone'} as const,
    {type: 'agent_ready'} as const,
    {type: 'agent_locked'} as const,
    {type: 'pong'} as const,
  ])('encodes $type as a versioned envelope', message => {
    expect(encodeClientMessage(message)).toEqual(encode({version: 1, message}) as Bytes);
  });

  it('encodes a push subscription using snake-case wire fields', () => {
    const message = {
      type: 'set_push_subscription',
      endpoint: 'https://push.example.test/subscription',
      expirationTime: 1_800_000_000_000,
      p256Dh: P256DH,
      auth: AUTH,
    } as const;

    expect(encodeClientMessage(message)).toEqual(
      encode({
        version: 1,
        message: {
          type: 'set_push_subscription',
          endpoint: message.endpoint,
          expiration_time: message.expirationTime,
          p256_dh: P256DH,
          auth: AUTH,
        },
      }) as Bytes,
    );
  });

  it('rejects invalid push subscription fields', () => {
    expect(() =>
      encodeClientMessage({
        type: 'set_push_subscription',
        endpoint: 'http://push.example.test/subscription',
        expirationTime: null,
        p256Dh: P256DH,
        auth: AUTH,
      }),
    ).toThrow(/endpoint/);
    expect(() =>
      encodeClientMessage({
        type: 'set_push_subscription',
        endpoint: 'https://push.example.test/subscription',
        expirationTime: null,
        p256Dh: 'not-a-key',
        auth: AUTH,
      }),
    ).toThrow(/p256dh/);
  });

  it('measures pairing labels as UTF-8 like Rust', () => {
    expect(() =>
      encodeClientMessage({type: 'pair_request', label: '😀'.repeat(33)}),
    ).toThrow();
  });

  it('rejects invalid authentication fields at runtime', () => {
    expect(() =>
      encodeClientMessage({
        type: 'authenticate',
        clientId: 'not-a-uuid',
        credential: bytes(1),
      }),
    ).toThrow(/clientId/);
    expect(() =>
      encodeClientMessage({
        type: 'authenticate',
        clientId: CLIENT_ID,
        credential: bytes(),
      }),
    ).toThrow(/credential/);
  });

  it('rejects attempts outside the Rust u32 range', () => {
    expect(() =>
      encodeClientMessage({
        type: 'agent_response',
        requestId: CLIENT_ID,
        attempt: 0x1_0000_0000,
        packet: bytes(0),
      }),
    ).toThrow(/attempt/);
  });
});

describe('decodeServerMessage', () => {
  it('decodes the Rust pairing fixture', () => {
    expect(decodeServerMessage(RUST_SERVER_PAIRED)).toEqual({
      type: 'paired',
      serverId: SERVER_ID,
      clientId: CLIENT_ID,
      credential: bytes(0xde, 0xad, 0xbe, 0xef),
      sessionId: SESSION_ID,
      vapidPublicKey: VAPID_PUBLIC_KEY,
    });
  });

  it('decodes the Rust agent-request fixture', () => {
    expect(decodeServerMessage(RUST_SERVER_AGENT_REQUEST)).toEqual({
      type: 'agent_request',
      requestId: CLIENT_ID,
      attempt: 4,
      packet: bytes(0, 0, 0, 1, 11),
    });
  });

  it.each([
    [
      {
        type: 'authenticated',
        server_id: SERVER_ID,
        session_id: SESSION_ID,
        vapid_public_key: VAPID_PUBLIC_KEY,
      },
      {
        type: 'authenticated',
        serverId: SERVER_ID,
        sessionId: SESSION_ID,
        vapidPublicKey: VAPID_PUBLIC_KEY,
      },
    ],
    [{type: 'rejected'}, {type: 'rejected'}],
    [
      {type: 'cancel_request', request_id: CLIENT_ID, attempt: 3},
      {type: 'cancel_request', requestId: CLIENT_ID, attempt: 3},
    ],
    [{type: 'ping'}, {type: 'ping'}],
  ])('decodes $type', (message, expected) => {
    expect(decodeServerMessage(serverFrame(message))).toEqual(expected);
  });

  it('rejects malformed MessagePack', () => {
    expect(() => decodeServerMessage(bytes(0xc1))).toThrow();
  });

  it('rejects an invalid VAPID public key', () => {
    expect(() =>
      decodeServerMessage(
        serverFrame({
          type: 'authenticated',
          server_id: SERVER_ID,
          session_id: SESSION_ID,
          vapid_public_key: bytes(4, 1),
        }),
      ),
    ).toThrow(/VAPID/);
  });

  it('rejects unsupported protocol versions', () => {
    expect(() =>
      decodeServerMessage(encode({version: 2, message: {type: 'ping'}})),
    ).toThrow(/version/);
  });

  it.each([
    [{version: 1, message: {type: 'unknown'}}, 'type'],
    [
      {
        version: 1,
        message: {
          type: 'authenticated',
          server_id: 'not-a-uuid',
          session_id: SESSION_ID,
        },
      },
      'server_id',
    ],
    [
      {
        version: 1,
        message: {
          type: 'agent_request',
          request_id: CLIENT_ID,
          attempt: -1,
          packet: bytes(0),
        },
      },
      'attempt',
    ],
    [
      {
        version: 1,
        message: {
          type: 'agent_request',
          request_id: CLIENT_ID,
          attempt: 1,
          packet: [0, 1],
        },
      },
      'packet',
    ],
  ])('rejects invalid server messages', (value, field) => {
    expect(() => decodeServerMessage(encode(value))).toThrow(field as string);
  });
});

function serverFrame(message: unknown): Bytes {
  return encode({version: 1, message});
}

function bytes(...values: number[]): Bytes {
  return new Uint8Array(values);
}

function fromHex(value: string): Bytes {
  const compact = value.replaceAll(/\s/g, '');
  return Uint8Array.from(compact.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
}
