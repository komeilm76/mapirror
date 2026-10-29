/** Minimal OSM PBF BlobHeader validation used before an upload enters the import queue. */

const MAX_PBF_BLOB_HEADER_BYTES = 64 * 1024;
/** Maximum bytes needed to inspect the first length-prefixed BlobHeader. */
export const OSM_PBF_HEADER_PREFIX_BYTES = MAX_PBF_BLOB_HEADER_BYTES + 4;

/**
 * Returns whether the first PBF BlobHeader is well-formed and identifies the OSM header block.
 *
 * This intentionally validates the PBF framing and protobuf `type` field only; the import worker performs the full
 * file/checksum validation before installing a map version.
 *
 * @param prefix - At most the first 64 KiB plus the four-byte PBF header length.
 * @param totalBytes - Full streamed file size, used to reject a truncated BlobHeader.
 */
export function hasOsmPbfHeader(prefix: Buffer, totalBytes: number): boolean {
  if (prefix.byteLength < 4 || totalBytes < 5) return false;
  const blobHeaderLength = prefix.readUInt32BE(0);
  if (
    blobHeaderLength < 1 ||
    blobHeaderLength > MAX_PBF_BLOB_HEADER_BYTES ||
    totalBytes < blobHeaderLength + 4 ||
    prefix.byteLength < blobHeaderLength + 4
  ) {
    return false;
  }
  return readBlobHeaderType(prefix.subarray(4, 4 + blobHeaderLength)) === 'OSMHeader';
}

function readBlobHeaderType(header: Buffer): string | null {
  let offset = 0;
  let type: string | null = null;
  while (offset < header.byteLength) {
    const tag = readVarint(header, offset);
    if (tag === null) return null;
    offset = tag.next;
    const field = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    if (field === 0) return null;

    if (wireType === 2) {
      const length = readVarint(header, offset);
      if (length === null) return null;
      offset = length.next;
      const end = offset + length.value;
      if (end > header.byteLength) return null;
      if (field === 1) {
        if (type !== null) return null;
        try {
          type = new TextDecoder('utf-8', { fatal: true }).decode(header.subarray(offset, end));
        } catch {
          return null;
        }
      }
      offset = end;
      continue;
    }

    if (wireType === 0) {
      const value = readVarint(header, offset);
      if (value === null) return null;
      offset = value.next;
      continue;
    }
    if (wireType === 1) {
      offset += 8;
      if (offset > header.byteLength) return null;
      continue;
    }
    if (wireType === 5) {
      offset += 4;
      if (offset > header.byteLength) return null;
      continue;
    }
    return null;
  }
  return type;
}

function readVarint(buffer: Buffer, start: number): { value: number; next: number } | null {
  let value = 0;
  let multiplier = 1;
  for (let offset = start; offset < buffer.byteLength && offset < start + 5; offset += 1) {
    const byte = buffer[offset];
    if (byte === undefined) return null;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) return { value, next: offset + 1 };
    multiplier *= 128;
  }
  return null;
}
