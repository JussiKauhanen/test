import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSPORT_PAYLOAD_SIZE,
  buildContainer,
  buildTransportFrame,
  crc32,
  packetKey,
  parseContainer,
  parseTransportFrame,
  sourceSymbolEstimate,
} from '../src/protocol.js';

test('container preserves text metadata and bytes', () => {
  const bytes = new TextEncoder().encode('RaptorQ survives missing frames 🦖');
  const packed = buildContainer({ kind: 'text', name: 'note.txt', mime: 'text/plain', bytes });
  const unpacked = parseContainer(packed);
  assert.equal(unpacked.kind, 'text');
  assert.equal(unpacked.name, 'note.txt');
  assert.equal(unpacked.mime, 'text/plain');
  assert.deepEqual(unpacked.bytes, bytes);
});

test('container checksum detects corruption', () => {
  const packed = buildContainer({ kind: 'file', name: 'x.bin', mime: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) });
  packed[packed.length - 5] ^= 0xff;
  assert.throws(() => parseContainer(packed), /checksum/);
});

test('transport frame round-trips and rejects corruption', () => {
  const packet = new Uint8Array([0, 0, 0, 7, 5, 4, 3, 2, 1]);
  const bytes = buildTransportFrame({ session: 0x12345678, encodedLength: 4096, transportSize: TRANSPORT_PAYLOAD_SIZE, packet });
  const frame = parseTransportFrame(bytes);
  assert.equal(frame.session, 0x12345678);
  assert.equal(frame.encodedLength, 4096);
  assert.equal(frame.transportSize, TRANSPORT_PAYLOAD_SIZE);
  assert.deepEqual(frame.packet, packet);
  assert.equal(packetKey(frame.packet), '00000007');

  bytes[16] ^= 0x01;
  assert.equal(parseTransportFrame(bytes), null);
});

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('source symbol estimate accounts for the four-byte Raptor payload id', () => {
  assert.equal(sourceSymbolEstimate(796, 800), 1);
  assert.equal(sourceSymbolEstimate(797, 800), 2);
});

