import {describe, expect, it} from 'vitest';

import {
  type AgentBackend,
  type AgentIdentity,
  AgentMessage,
  frame,
  handleAgentRequest,
  inspectAgentRequest,
  parseSignRequest,
  readFrame,
  rsaFlavorFromFlags,
  SignFlag,
} from './agent';
import {Reader, Writer} from './encoding';

/**
 * Build an ArrayBuffer-backed byte array from literal values.
 */
function bytes(...values: number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values);
}

/**
 * A backend that lists the given identities and "signs" by echoing the request
 * data back — enough to prove the protocol wiring without real crypto.
 */
function echoBackend(identities: AgentIdentity[] = []): AgentBackend {
  return {
    listIdentities: () => identities,
    sign: request => Promise.resolve(request.data),
  };
}

/**
 * Read a framed response's payload into a Reader.
 */
function response(message: Uint8Array): Reader {
  const decoded = readFrame(message);
  if (!decoded) {
    throw new Error('incomplete response');
  }
  return new Reader(decoded.payload);
}

describe('framing', () => {
  it('round-trips a framed message', () => {
    const framed = frame(bytes(11));
    const read = readFrame(framed);

    expect(read?.payload).toEqual(bytes(11));
    expect(read?.consumed).toBe(framed.length);
  });

  it('returns null for an incomplete buffer', () => {
    expect(readFrame(bytes(0, 0, 0, 5, 1, 2))).toBeNull();
  });
});

describe('rsaFlavorFromFlags', () => {
  it('maps flags to the rsa algorithm', () => {
    expect(rsaFlavorFromFlags(0)).toBe('rsa-sha2-256');
    expect(rsaFlavorFromFlags(SignFlag.RsaSha2_256)).toBe('rsa-sha2-256');
    expect(rsaFlavorFromFlags(SignFlag.RsaSha2_512)).toBe('rsa-sha2-512');
  });
});

describe('parseSignRequest', () => {
  it('parses the key blob, data, and flags', () => {
    const payload = new Writer()
      .u8(AgentMessage.SignRequest)
      .string(bytes(1, 2, 3))
      .string(bytes(4, 5))
      .u32(SignFlag.RsaSha2_512)
      .finish();

    const request = parseSignRequest(payload);

    expect(request.keyBlob).toEqual(bytes(1, 2, 3));
    expect(request.data).toEqual(bytes(4, 5));
    expect(request.flags).toBe(SignFlag.RsaSha2_512);
  });
});

describe('inspectAgentRequest', () => {
  it('identifies identity-list requests', () => {
    expect(inspectAgentRequest(frame(bytes(AgentMessage.RequestIdentities)))).toEqual({
      type: 'identities',
    });
  });

  it('describes signing requests without retaining their payload', () => {
    const packet = frame(
      new Writer()
        .u8(AgentMessage.SignRequest)
        .string(bytes(1, 2, 3))
        .string(bytes(4, 5))
        .u32(SignFlag.RsaSha2_512)
        .finish(),
    );

    expect(inspectAgentRequest(packet)).toEqual({
      type: 'sign',
      keyBlob: bytes(1, 2, 3),
      bytes: 2,
      flags: SignFlag.RsaSha2_512,
    });
  });
});

describe('handleAgentRequest', () => {
  it('answers REQUEST_IDENTITIES with the backend identities', async () => {
    const backend = {
      listIdentities: () => [{keyBlob: bytes(9, 9, 9), comment: 'my key'}],
    };

    const reader = response(
      await handleAgentRequest(bytes(AgentMessage.RequestIdentities), backend),
    );

    expect(reader.u8()).toBe(AgentMessage.IdentitiesAnswer);
    expect(reader.u32()).toBe(1);
    expect(reader.string()).toEqual(bytes(9, 9, 9));
    expect(reader.str()).toBe('my key');
  });

  it('passes a SIGN_REQUEST to the backend and wraps the signature', async () => {
    const payload = new Writer()
      .u8(AgentMessage.SignRequest)
      .string(bytes(1))
      .string(bytes(7, 7, 7))
      .u32(0)
      .finish();

    const reader = response(await handleAgentRequest(payload, echoBackend()));

    expect(reader.u8()).toBe(AgentMessage.SignResponse);
    expect(reader.string()).toEqual(bytes(7, 7, 7));
  });

  it('fails an unknown request type', async () => {
    const reader = response(await handleAgentRequest(bytes(99), echoBackend()));

    expect(reader.u8()).toBe(AgentMessage.Failure);
  });

  it('fails when signing is unavailable', async () => {
    const payload = new Writer()
      .u8(AgentMessage.SignRequest)
      .string(bytes(1))
      .string(bytes(2))
      .u32(0)
      .finish();

    const reader = response(
      await handleAgentRequest(payload, {listIdentities: () => []}),
    );

    expect(reader.u8()).toBe(AgentMessage.Failure);
  });

  it('fails when the backend cannot sign', async () => {
    const backend: AgentBackend = {
      listIdentities: () => [],
      sign: () => Promise.reject(new Error('unknown key')),
    };
    const payload = new Writer()
      .u8(AgentMessage.SignRequest)
      .string(bytes(1))
      .string(bytes(2))
      .u32(0)
      .finish();

    const reader = response(await handleAgentRequest(payload, backend));

    expect(reader.u8()).toBe(AgentMessage.Failure);
  });
});
