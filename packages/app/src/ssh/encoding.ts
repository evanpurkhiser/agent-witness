// SSH wire-format primitives (RFC 4251 §5). Browser-safe: Uint8Array only, no
// Node Buffer. A "string" is a uint32 length prefix followed by that many raw
// bytes. An "mpint" is a big-endian two's-complement signed integer, itself
// encoded as a string.

import {concatBytes} from 'app/utils/bytes';

const te = new TextEncoder();
const td = new TextDecoder();

/**
 * Drop leading zero bytes from an mpint magnitude, always keeping at least one
 * byte so a zero value survives as a single `0x00`.
 */
function stripLeadingZeros(b: Uint8Array): Uint8Array {
  const firstNonZero = b.findIndex(x => x !== 0x00);
  return firstNonZero === -1 ? b.subarray(b.length - 1) : b.subarray(firstNonZero);
}

/**
 * Sequential reader over an SSH-encoded buffer. The cursor advances as fields
 * are read; every accessor throws if it would read past the end of the buffer.
 */
export class Reader {
  readonly #buf: Uint8Array;
  readonly #view: DataView;
  #off = 0;

  constructor(buf: Uint8Array) {
    this.#buf = buf;
    this.#view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /**
   * Number of unread bytes left in the buffer.
   */
  get remaining(): number {
    return this.#buf.length - this.#off;
  }

  /**
   * Advance the cursor by `n` bytes, returning the pre-advance offset.
   */
  #take(n: number): number {
    if (n < 0 || this.#off + n > this.#buf.length) {
      throw new Error('unexpected end of SSH buffer');
    }
    const start = this.#off;
    this.#off += n;
    return start;
  }

  /**
   * Read a single byte.
   */
  u8(): number {
    return this.#view.getUint8(this.#take(1));
  }

  /**
   * Read a big-endian uint32.
   */
  u32(): number {
    return this.#view.getUint32(this.#take(4));
  }

  /**
   * Read `n` raw bytes as a copy-free subarray of the underlying buffer.
   */
  bytes(n: number): Uint8Array {
    const start = this.#take(n);
    return this.#buf.subarray(start, start + n);
  }

  /**
   * Read an SSH "string": a uint32 length prefix followed by that many bytes.
   */
  string(): Uint8Array {
    return this.bytes(this.u32());
  }

  /**
   * Read an SSH "string" and decode it as UTF-8.
   */
  str(): string {
    return td.decode(this.string());
  }

  /**
   * Read an SSH "mpint" and return the raw magnitude with sign-padding removed.
   */
  mpint(): Uint8Array {
    return stripLeadingZeros(this.string());
  }
}

/**
 * Builder for an SSH-encoded buffer. Each method appends a field and returns
 * `this` for chaining; `finish` flattens the accumulated chunks.
 */
export class Writer {
  readonly #chunks: Uint8Array[] = [];

  /**
   * Append a single byte.
   */
  u8(v: number): this {
    this.#chunks.push(new Uint8Array([v]));
    return this;
  }

  /**
   * Append a big-endian uint32.
   */
  u32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0);
    this.#chunks.push(b);
    return this;
  }

  /**
   * Append raw bytes with no length prefix.
   */
  bytes(v: Uint8Array): this {
    this.#chunks.push(v);
    return this;
  }

  /**
   * Append an SSH "string" (uint32 length prefix + bytes).
   */
  string(v: Uint8Array | string): this {
    const b = typeof v === 'string' ? te.encode(v) : v;
    this.u32(b.length);
    this.#chunks.push(b);
    return this;
  }

  /**
   * Append an SSH "mpint", prepending a `0x00` when the high bit is set so the
   * value reads as positive.
   */
  mpint(magnitude: Uint8Array): this {
    const m = stripLeadingZeros(magnitude);
    const needsPad = m.length > 0 && (m[0] & 0x80) !== 0;
    return this.string(needsPad ? concatBytes(new Uint8Array([0x00]), m) : m);
  }

  /**
   * Flatten all appended chunks into a single buffer.
   */
  finish(): Uint8Array {
    return concatBytes(...this.#chunks);
  }
}
