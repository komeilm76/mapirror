import { describe, expect, it } from 'vitest';

import { hasOsmPbfHeader } from '../src/modules/imports/pbf-header';

const OSM_HEADER = Buffer.from([0x0a, 0x09, ...Buffer.from('OSMHeader')]);

function pbfPrefix(blobHeader: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(blobHeader.byteLength);
  return Buffer.concat([length, blobHeader]);
}

describe('OSM PBF header validation', () => {
  it('accepts a complete length-prefixed BlobHeader whose type is OSMHeader', () => {
    const prefix = pbfPrefix(OSM_HEADER);
    expect(hasOsmPbfHeader(prefix, prefix.byteLength)).toBe(true);
  });

  it('skips supported protobuf fields before the required type', () => {
    const prefix = pbfPrefix(Buffer.concat([Buffer.from([0x10, 0x01]), OSM_HEADER]));
    expect(hasOsmPbfHeader(prefix, prefix.byteLength)).toBe(true);
  });

  it('skips length-delimited, fixed-width, and multi-byte varint fields', () => {
    const prefix = pbfPrefix(
      Buffer.concat([
        Buffer.from([0x12, 0x01, 0x41]),
        Buffer.from([0x09, 1, 2, 3, 4, 5, 6, 7, 8]),
        Buffer.from([0x0d, 1, 2, 3, 4]),
        Buffer.from([0x10, 0x81, 0x00]),
        OSM_HEADER,
      ]),
    );
    expect(hasOsmPbfHeader(prefix, prefix.byteLength)).toBe(true);
  });

  it.each<[string, Buffer, number]>([
    ['empty input', Buffer.alloc(0), 0],
    ['missing PBF length prefix', Buffer.from([1, 2, 3]), 3],
    ['zero-length BlobHeader', Buffer.from([0, 0, 0, 0]), 4],
    ['oversized BlobHeader', Buffer.from([0, 1, 0, 1]), 65_541],
    ['truncated BlobHeader', pbfPrefix(OSM_HEADER).subarray(0, 8), 8],
    ['header extends beyond file size', pbfPrefix(OSM_HEADER), 5],
    ['non-OSM header block', pbfPrefix(Buffer.from([0x0a, 0x04, ...Buffer.from('DATA')])), 10],
    ['type field with the wrong wire type', pbfPrefix(Buffer.from([0x08, 0x01])), 6],
    ['truncated type value', pbfPrefix(Buffer.from([0x0a, 0x08, 0x4f])), 7],
    ['duplicate type fields', pbfPrefix(Buffer.concat([OSM_HEADER, OSM_HEADER])), 26],
    ['zero-numbered protobuf field', pbfPrefix(Buffer.from([0x00])), 5],
    ['missing length varint', pbfPrefix(Buffer.from([0x0a])), 5],
    ['missing integer value', pbfPrefix(Buffer.from([0x10])), 5],
    ['truncated fixed-width 64-bit value', pbfPrefix(Buffer.from([0x09, 0x01])), 6],
    ['truncated fixed-width 32-bit value', pbfPrefix(Buffer.from([0x0d, 0x01])), 6],
    ['invalid protobuf wire type', pbfPrefix(Buffer.from([0x0e])), 5],
    ['invalid UTF-8 type text', pbfPrefix(Buffer.from([0x0a, 0x01, 0xff])), 7],
    ['unterminated varint', pbfPrefix(Buffer.from([0x10, 0x80, 0x80, 0x80, 0x80, 0x80])), 10],
  ])('rejects %s', (_label, prefix, totalBytes) => {
    expect(hasOsmPbfHeader(prefix, totalBytes)).toBe(false);
  });
});
