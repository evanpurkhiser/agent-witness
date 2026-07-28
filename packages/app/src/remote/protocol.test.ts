import {encode} from '@msgpack/msgpack';
import {describe, expect, it} from 'vitest';

import type {Bytes} from 'app/utils/bytes';

import {decodeServerMessage, encodeClientMessage, type ServerMessage} from './protocol';

const SERVER_ID = '11111111-2222-4333-8444-555555555555';
const CLIENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SESSION_ID = '12345678-9abc-4def-8123-456789abcdef';

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
  82a776657273696f6e01a76d65737361676585a474797065a6706169726564a97365727665725f6964d92431313131313131312d323232322d343333332d383434342d353535353535353535353535a9636c69656e745f6964d92461616161616161612d626262622d346363632d386464642d656565656565656565656565aa63726564656e7469616cc404deadbeefaa73657373696f6e5f6964d92431323334353637382d396162632d346465662d383132332d343536373839616263646566
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
      client_id: SERVER_ID,
      credential: bytes(0xde, 0xad, 0xbe, 0xef),
    });

    expect(encoded).toEqual(RUST_CLIENT_AUTHENTICATE);
  });

  it('matches the Rust agent-response fixture', () => {
    const encoded = encodeClientMessage({
      type: 'agent_response',
      request_id: CLIENT_ID,
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

  it('measures pairing labels as UTF-8 like Rust', () => {
    expect(() =>
      encodeClientMessage({type: 'pair_request', label: '😀'.repeat(33)}),
    ).toThrow();
  });

  it('rejects invalid authentication fields at runtime', () => {
    expect(() =>
      encodeClientMessage({
        type: 'authenticate',
        client_id: 'not-a-uuid',
        credential: bytes(1),
      }),
    ).toThrow(/client_id/);
    expect(() =>
      encodeClientMessage({
        type: 'authenticate',
        client_id: CLIENT_ID,
        credential: bytes(),
      }),
    ).toThrow(/credential/);
  });

  it('rejects attempts outside the Rust u32 range', () => {
    expect(() =>
      encodeClientMessage({
        type: 'agent_response',
        request_id: CLIENT_ID,
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
      server_id: SERVER_ID,
      client_id: CLIENT_ID,
      credential: bytes(0xde, 0xad, 0xbe, 0xef),
      session_id: SESSION_ID,
    });
  });

  it('decodes the Rust agent-request fixture', () => {
    expect(decodeServerMessage(RUST_SERVER_AGENT_REQUEST)).toEqual({
      type: 'agent_request',
      request_id: CLIENT_ID,
      attempt: 4,
      packet: bytes(0, 0, 0, 1, 11),
    });
  });

  it.each<ServerMessage>([
    {type: 'authenticated', server_id: SERVER_ID, session_id: SESSION_ID},
    {type: 'rejected'},
    {type: 'cancel_request', request_id: CLIENT_ID, attempt: 3},
    {type: 'ping'},
  ])('decodes $type', message => {
    expect(decodeServerMessage(serverFrame(message))).toEqual(message);
  });

  it('rejects malformed MessagePack', () => {
    expect(() => decodeServerMessage(bytes(0xc1))).toThrow();
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

function serverFrame(message: ServerMessage): Bytes {
  return encode({version: 1, message});
}

function bytes(...values: number[]): Bytes {
  return new Uint8Array(values);
}

function fromHex(value: string): Bytes {
  const compact = value.replaceAll(/\s/g, '');
  return Uint8Array.from(compact.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
}
