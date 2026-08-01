import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTransportFrame } from '../src/protocol.js';
import { decodeQrPixels, makeQrPixels } from '../src/qr.js';

test('a maximum-size binary transport frame survives QR encode/decode', () => {
  const packet = new Uint8Array(800);
  let state = 0x12345678;
  for (let index = 0; index < packet.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    packet[index] = state >>> 24;
  }
  const frame = buildTransportFrame({ session: 42, encodedLength: 65536, transportSize: 800, packet });
  const { pixels, dimension } = makeQrPixels(frame, 5);
  const decoded = decodeQrPixels(pixels, dimension, dimension);
  assert.deepEqual(decoded, frame);
});

