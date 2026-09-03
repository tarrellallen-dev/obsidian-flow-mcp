/**
 * Length-prefixed frame splitter.
 *
 * The transport is a byte stream. A single read may deliver half a frame, or four frames plus
 * three bytes of the fifth. This class is the only place that knows that, and it is fuzzed
 * against random chunk boundaries.
 */

import { LENGTH_PREFIX_BYTES, MAX_FRAME_BYTES, WireError } from "../wire/decoder.js";

export class FrameSplitter {
  private buffered: Buffer = Buffer.alloc(0);
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes: number = MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes;
  }

  /** Bytes held back waiting for the rest of a frame. */
  get pending(): number {
    return this.buffered.length;
  }

  reset(): void {
    this.buffered = Buffer.alloc(0);
  }

  /**
   * Feeds one chunk and returns every complete frame it completes, each buffer starting at its
   * own length field. Throws WireError when a declared frame exceeds maxFrameBytes: the stream
   * is unrecoverable at that point and the caller must drop the connection.
   */
  push(chunk: Buffer): Buffer[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);

    const frames: Buffer[] = [];
    let offset = 0;

    for (;;) {
      if (this.buffered.length - offset < LENGTH_PREFIX_BYTES) break;

      const length = this.buffered.readUInt32LE(offset);
      const total = LENGTH_PREFIX_BYTES + length;

      if (total > this.maxFrameBytes) {
        this.reset();
        throw new WireError(`declared frame of ${total} bytes exceeds maxFrameBytes`);
      }
      if (this.buffered.length - offset < total) break;

      frames.push(this.buffered.subarray(offset, offset + total));
      offset += total;
    }

    this.buffered =
      offset === 0
        ? this.buffered
        : Buffer.from(this.buffered.subarray(offset)); // copy: returned frames alias the old buffer

    return frames;
  }
}
