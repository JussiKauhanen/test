import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { RaptorQDecoder, encode_packets } from '@raptorqr/raptorq-wasm';

const wasmUrl = new URL('../node_modules/@raptorqr/raptorq-wasm/src/wasm/raptorqr_raptorq_wasm_bg.wasm', import.meta.url);

test('RaptorQ reconstructs after deterministic packet loss', async () => {
  await init({ module_or_path: await readFile(wasmUrl) });
  const data = new Uint8Array(48 * 1024 + 137);
  let state = 0xabcdef01;
  for (let index = 0; index < data.length; index++) {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    data[index] = state & 0xff;
  }

  const packets = Array.from(encode_packets(data, 800, 100), value => new Uint8Array(value));
  const decoder = new RaptorQDecoder(data.length, 800);
  let decoded = null;
  for (let index = 0; index < packets.length; index++) {
    if (index % 4 === 0) continue;
    decoded = decoder.push(packets[index]);
    if (decoded) break;
  }
  decoder.free();
  assert.ok(decoded, 'decoder should recover with 25% deterministic packet loss');
  assert.deepEqual(new Uint8Array(decoded).subarray(0, data.length), data);
});

