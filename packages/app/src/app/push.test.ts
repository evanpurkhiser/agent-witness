import {describe, expect, it} from 'vitest';

import {serializePushSubscription} from './push';

describe('serializePushSubscription', () => {
  it('serializes the endpoint, expiration, and encryption material', () => {
    const p256Dh = Uint8Array.from({length: 65}, (_, index) => index).buffer;
    const auth = Uint8Array.from({length: 16}, (_, index) => index).buffer;
    const subscription = {
      endpoint: 'https://push.example.test/subscription',
      expirationTime: 1_800_000_000_000.5,
      getKey(name: PushEncryptionKeyName) {
        return name === 'p256dh' ? p256Dh : auth;
      },
    } as PushSubscription;

    expect(serializePushSubscription(subscription)).toEqual({
      endpoint: 'https://push.example.test/subscription',
      expirationTime: 1_800_000_000_000,
      p256Dh:
        'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A',
      auth: 'AAECAwQFBgcICQoLDA0ODw',
    });
  });

  it('rejects a subscription without both encryption keys', () => {
    const subscription = {
      endpoint: 'https://push.example.test/subscription',
      expirationTime: null,
      getKey() {
        return null;
      },
    } as unknown as PushSubscription;

    expect(() => serializePushSubscription(subscription)).toThrow(/encryption keys/);
  });
});
