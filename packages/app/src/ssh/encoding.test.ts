import {describe, expect, it} from 'vitest';

import {Reader, Writer} from 'app/ssh/encoding';

describe('Writer/Reader round-trip', () => {
  it('round-trips bytes, integers, and strings', () => {
    const buf = new Writer()
      .u8(0x2a)
      .u32(0xdeadbeef)
      .string('hello')
      .string(new Uint8Array([1, 2, 3]))
      .finish();

    const r = new Reader(buf);
    expect(r.u8()).toBe(0x2a);
    expect(r.u32()).toBe(0xdeadbeef);
    expect(r.str()).toBe('hello');
    expect(r.string()).toEqual(new Uint8Array([1, 2, 3]));
    expect(r.remaining).toBe(0);
  });
});

describe('mpint', () => {
  it('pads a high-bit-set magnitude and strips it back on read', () => {
    const magnitude = new Uint8Array([0x80, 0x01]);
    const buf = new Writer().mpint(magnitude).finish();

    // 4-byte length prefix + 0x00 sign pad + 2 magnitude bytes
    expect(buf).toHaveLength(7);
    expect(new Reader(buf).mpint()).toEqual(magnitude);
  });

  it('strips leading zero padding from a magnitude', () => {
    const buf = new Writer().mpint(new Uint8Array([0x00, 0x00, 0x05])).finish();
    expect(new Reader(buf).mpint()).toEqual(new Uint8Array([0x05]));
  });

  it('keeps a single zero byte for a zero value', () => {
    const buf = new Writer().mpint(new Uint8Array([0x00])).finish();
    expect(new Reader(buf).mpint()).toEqual(new Uint8Array([0x00]));
  });
});

describe('bounds checking', () => {
  it('throws when a string claims more bytes than remain', () => {
    const r = new Reader(new Uint8Array([0, 0, 0, 5]));
    expect(() => r.string()).toThrow(/end of SSH buffer/);
  });

  it('throws on a truncated uint32', () => {
    const r = new Reader(new Uint8Array([1, 2]));
    expect(() => r.u32()).toThrow(/end of SSH buffer/);
  });
});
