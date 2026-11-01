/**
 * Minimal MD5 (RFC 1321) over bytes. WebCrypto has no MD5, and KOReader's
 * sync protocol (kosync) needs it for the document digest and the user key.
 * Not used for anything security-relevant.
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = new Int32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;
}

/** Incremental MD5 hasher: update() any number of chunks, then digestHex(). */
export class Md5 {
  private a = 0x67452301;
  private b = 0xefcdab89 | 0;
  private c = 0x98badcfe | 0;
  private d = 0x10325476;
  private buffer = new Uint8Array(64);
  private bufferLength = 0;
  private totalLength = 0;
  private words = new Int32Array(16);

  update(data: Uint8Array): this {
    let i = 0;
    this.totalLength += data.length;
    if (this.bufferLength > 0) {
      const take = Math.min(64 - this.bufferLength, data.length);
      this.buffer.set(data.subarray(0, take), this.bufferLength);
      this.bufferLength += take;
      i = take;
      if (this.bufferLength === 64) {
        this.block(this.buffer, 0);
        this.bufferLength = 0;
      }
    }
    for (; i + 64 <= data.length; i += 64) {
      this.block(data, i);
    }
    if (i < data.length) {
      this.buffer.set(data.subarray(i), 0);
      this.bufferLength = data.length - i;
    }
    return this;
  }

  digestHex(): string {
    const bitLength = this.totalLength * 8;
    const padLength = this.bufferLength < 56 ? 56 - this.bufferLength : 120 - this.bufferLength;
    const pad = new Uint8Array(padLength + 8);
    pad[0] = 0x80;
    // Length in bits, little-endian 64-bit (split to stay exact past 2^32).
    const low = bitLength >>> 0;
    const high = Math.floor(bitLength / 0x100000000) >>> 0;
    for (let i = 0; i < 4; i++) {
      pad[padLength + i] = (low >>> (8 * i)) & 0xff;
      pad[padLength + 4 + i] = (high >>> (8 * i)) & 0xff;
    }
    this.update(pad);
    let hex = '';
    for (const v of [this.a, this.b, this.c, this.d]) {
      for (let i = 0; i < 4; i++) {
        hex += ((v >>> (8 * i)) & 0xff).toString(16).padStart(2, '0');
      }
    }
    return hex;
  }

  private block(bytes: Uint8Array, offset: number): void {
    const w = this.words;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = bytes[j] | (bytes[j + 1] << 8) | (bytes[j + 2] << 16) | (bytes[j + 3] << 24);
    }
    let a = this.a;
    let b = this.b;
    let c = this.c;
    let d = this.d;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      const sum = (a + f + K[i] + w[g]) | 0;
      b = (b + ((sum << S[i]) | (sum >>> (32 - S[i])))) | 0;
      a = tmp;
    }
    this.a = (this.a + a) | 0;
    this.b = (this.b + b) | 0;
    this.c = (this.c + c) | 0;
    this.d = (this.d + d) | 0;
  }
}

export function md5Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return new Md5().update(bytes).digestHex();
}
