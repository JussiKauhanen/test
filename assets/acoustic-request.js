/*
 * NearChat voice-band control channel.
 * Messages use alternating DTMF tone banks, a session nonce, CRC-16 and
 * repetition. The payload stays deliberately tiny so normal phone speakers
 * and microphones can exchange sync requests without another connection.
 */
export const ACOUSTIC_REQUEST_CONFIG = Object.freeze({
  timeoutMs: 10_000,
  repeatCount: 2,
  toneMs: 82,
  gapMs: 18,
  repeatGapMs: 160,
  oscillatorGain: 0.12,
  pollMs: 18,
  maxPayloadBytes: 8
});

export const ACOUSTIC_REQUEST_FULL = 1;
export const ACOUSTIC_REQUEST_INDEXES = 2;
export const ACOUSTIC_REQUEST_MASK = 3;
export const ACOUSTIC_REQUEST_NONE = 4;
export const ACOUSTIC_REQUEST_DONE = 5;

const REQUEST_VERSION = 2;
const REQUEST_HEADER_BYTES = 6;
const REQUEST_CRC_BYTES = 2;
const REQUEST_PREAMBLE = [0x0a, 0x01, 0x0d, 0x04];
const DTMF_ROWS = [697, 770, 852, 941];
const DTMF_COLUMNS = [1209, 1336, 1477, 1633];

function crc16(bytes) {
  let value = 0xffff;
  for (const byte of bytes) {
    value ^= byte << 8;
    for (let bit = 0; bit < 8; bit++)
      value = value & 0x8000 ? ((value << 1) ^ 0x1021) & 0xffff : (value << 1) & 0xffff;
  }
  return value;
}

function normalizedPayload(payload) {
  if (payload == null) return new Uint8Array();
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (bytes.length > ACOUSTIC_REQUEST_CONFIG.maxPayloadBytes)
    throw new Error('The sound request is too large.');
  return bytes;
}

export function buildAcousticRequestPacket(
  session,
  kind = ACOUSTIC_REQUEST_FULL,
  payload = new Uint8Array()
) {
  const body = normalizedPayload(payload);
  const output = new Uint8Array(REQUEST_HEADER_BYTES + body.length + REQUEST_CRC_BYTES);
  const view = new DataView(output.buffer);
  output[0] = (REQUEST_VERSION << 4) | (kind & 0x0f);
  view.setUint32(1, session >>> 0, false);
  output[5] = body.length;
  output.set(body, REQUEST_HEADER_BYTES);
  view.setUint16(output.length - REQUEST_CRC_BYTES,
    crc16(output.subarray(0, output.length - REQUEST_CRC_BYTES)), false);
  return output;
}

export function parseAcousticRequestPacket(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < REQUEST_HEADER_BYTES + REQUEST_CRC_BYTES ||
      bytes[0] >>> 4 !== REQUEST_VERSION) return null;
  const payloadLength = bytes[5];
  if (payloadLength > ACOUSTIC_REQUEST_CONFIG.maxPayloadBytes ||
      bytes.length !== REQUEST_HEADER_BYTES + payloadLength + REQUEST_CRC_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (crc16(bytes.subarray(0, bytes.length - REQUEST_CRC_BYTES)) !==
      view.getUint16(bytes.length - REQUEST_CRC_BYTES, false)) return null;
  return {
    kind: bytes[0] & 0x0f,
    session: view.getUint32(1, false) >>> 0,
    payload: bytes.slice(REQUEST_HEADER_BYTES, REQUEST_HEADER_BYTES + payloadLength)
  };
}

function encodeVarints(indexes) {
  const output = [];
  let previous = -1;
  for (const index of indexes) {
    let delta = index - previous - 1;
    do {
      let byte = delta & 0x7f;
      delta >>>= 7;
      if (delta) byte |= 0x80;
      output.push(byte);
    } while (delta);
    previous = index;
  }
  return new Uint8Array(output);
}

function decodeVarints(bytes, totalPackages) {
  const output = [];
  let previous = -1;
  let value = 0;
  let shift = 0;
  for (const byte of bytes) {
    value |= (byte & 0x7f) << shift;
    if (byte & 0x80) {
      shift += 7;
      if (shift > 21) return null;
      continue;
    }
    const index = previous + value + 1;
    if (index <= previous || index >= totalPackages) return null;
    output.push(index);
    previous = index;
    value = 0;
    shift = 0;
  }
  return shift ? null : output;
}

function encodeMask(indexes, totalPackages) {
  const output = new Uint8Array(Math.ceil(totalPackages / 8));
  for (const index of indexes) output[index >>> 3] |= 1 << (index & 7);
  return output;
}

function decodeMask(bytes, totalPackages) {
  if (bytes.length !== Math.ceil(totalPackages / 8)) return null;
  const output = [];
  for (let index = 0; index < totalPackages; index++)
    if (bytes[index >>> 3] & (1 << (index & 7))) output.push(index);
  return output;
}

export function chooseAcousticRequest(missingIndexes, totalPackages) {
  const indexes = [...new Set(missingIndexes)]
    .filter(index => Number.isInteger(index) && index >= 0 && index < totalPackages)
    .sort((a, b) => a - b);
  if (!indexes.length) return { kind: ACOUSTIC_REQUEST_NONE, payload: new Uint8Array() };

  const list = encodeVarints(indexes);
  const mask = totalPackages <= ACOUSTIC_REQUEST_CONFIG.maxPayloadBytes * 8
    ? encodeMask(indexes, totalPackages)
    : null;
  if (mask && mask.length <= list.length)
    return { kind: ACOUSTIC_REQUEST_MASK, payload: mask };
  if (list.length <= ACOUSTIC_REQUEST_CONFIG.maxPayloadBytes)
    return { kind: ACOUSTIC_REQUEST_INDEXES, payload: list };
  return { kind: ACOUSTIC_REQUEST_FULL, payload: new Uint8Array() };
}

export function requestedPackageIndexes(message, totalPackages) {
  if (!message || !Number.isInteger(totalPackages) || totalPackages < 0) return undefined;
  if (message.kind === ACOUSTIC_REQUEST_FULL) return null;
  if (message.kind === ACOUSTIC_REQUEST_NONE) return [];
  if (message.kind === ACOUSTIC_REQUEST_INDEXES)
    return decodeVarints(message.payload, totalPackages);
  if (message.kind === ACOUSTIC_REQUEST_MASK)
    return decodeMask(message.payload, totalPackages);
  return undefined;
}

function packetSymbols(packet) {
  const symbols = [...REQUEST_PREAMBLE];
  let buffer = 0;
  let bits = 0;
  let group = 0;
  for (const byte of packet) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 3) {
      bits -= 3;
      const value = (buffer >>> bits) & 0x07;
      symbols.push(value + (group % 2 === 0 ? 8 : 0));
      group++;
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits) symbols.push((buffer << (3 - bits)) + (group % 2 === 0 ? 8 : 0));
  return symbols;
}

function groupsToBytes(groups, byteLength) {
  const output = new Uint8Array(byteLength);
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const group of groups) {
    if (offset === output.length) break;
    buffer = (buffer << 3) | group;
    bits += 3;
    while (bits >= 8 && offset < output.length) {
      bits -= 8;
      output[offset++] = (buffer >>> bits) & 0xff;
      buffer &= (1 << bits) - 1;
    }
  }
  return offset === output.length ? output : null;
}

function symbolsToRequest(symbols) {
  for (let offset = 0; offset <= symbols.length - REQUEST_PREAMBLE.length; offset++) {
    if (!REQUEST_PREAMBLE.every((symbol, index) => symbols[offset + index] === symbol)) continue;
    const groups = [];
    for (let cursor = offset + REQUEST_PREAMBLE.length; cursor < symbols.length; cursor++) {
      const symbol = symbols[cursor];
      const expectedHighBank = groups.length % 2 === 0;
      if ((symbol >= 8) !== expectedHighBank) break;
      groups.push(symbol & 0x07);
      if (groups.length < Math.ceil(REQUEST_HEADER_BYTES * 8 / 3)) continue;
      const header = groupsToBytes(groups, REQUEST_HEADER_BYTES);
      if (!header) continue;
      const payloadLength = header[5];
      if (payloadLength > ACOUSTIC_REQUEST_CONFIG.maxPayloadBytes) break;
      const byteLength = REQUEST_HEADER_BYTES + payloadLength + REQUEST_CRC_BYTES;
      const groupsNeeded = Math.ceil(byteLength * 8 / 3);
      if (groups.length < groupsNeeded) continue;
      const request = parseAcousticRequestPacket(groupsToBytes(groups, byteLength));
      if (request) return request;
      break;
    }
  }
  return null;
}

function audioContextConstructor() {
  return window.AudioContext || window.webkitAudioContext;
}

let outputContext = null;
const activeOscillators = new Set();
let inputContext = null;
let inputStream = null;

export async function prepareAcousticOutput() {
  const AudioContext = audioContextConstructor();
  if (!AudioContext) throw new Error('Audio output is not supported.');
  if (!outputContext || outputContext.state === 'closed') outputContext = new AudioContext();
  if (outputContext.state === 'suspended') await outputContext.resume();
  return outputContext;
}

function scheduleTone(context, destination, frequency, start, end, oscillators = activeOscillators) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const fade = Math.min(0.006, (end - start) / 4);
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(ACOUSTIC_REQUEST_CONFIG.oscillatorGain, start + fade);
  gain.gain.setValueAtTime(ACOUSTIC_REQUEST_CONFIG.oscillatorGain, end - fade);
  gain.gain.linearRampToValueAtTime(0, end);
  oscillator.connect(gain).connect(destination);
  oscillators.add(oscillator);
  oscillator.addEventListener('ended', () => oscillators.delete(oscillator), { once: true });
  oscillator.start(start);
  oscillator.stop(end + 0.01);
}

export async function playAcousticRequest(
  session,
  kind = ACOUSTIC_REQUEST_FULL,
  payload = new Uint8Array()
) {
  const context = await prepareAcousticOutput();
  const symbols = packetSymbols(buildAcousticRequestPacket(session, kind, payload));
  const toneSeconds = ACOUSTIC_REQUEST_CONFIG.toneMs / 1000;
  const gapSeconds = ACOUSTIC_REQUEST_CONFIG.gapMs / 1000;
  let cursor = context.currentTime + 0.08;

  for (let repeat = 0; repeat < ACOUSTIC_REQUEST_CONFIG.repeatCount; repeat++) {
    for (const symbol of symbols) {
      const start = cursor;
      const end = start + toneSeconds;
      scheduleTone(context, context.destination, DTMF_ROWS[Math.floor(symbol / 4)], start, end);
      scheduleTone(context, context.destination, DTMF_COLUMNS[symbol % 4], start, end);
      cursor = end + gapSeconds;
    }
    cursor += ACOUSTIC_REQUEST_CONFIG.repeatGapMs / 1000;
  }

  const waitMs = Math.max(0, (cursor - context.currentTime) * 1000);
  await new Promise(resolve => setTimeout(resolve, waitMs));
}

export async function startAcousticTestSequence() {
  const AudioContext = audioContextConstructor();
  if (!AudioContext) throw new Error('Audio output is not supported.');
  const context = new AudioContext();
  if (context.state === 'suspended') await context.resume();
  const testOscillators = new Set();
  const tones = [
    [DTMF_ROWS[0], DTMF_COLUMNS[0]],
    [DTMF_ROWS[1], DTMF_COLUMNS[1]],
    [DTMF_ROWS[2], DTMF_COLUMNS[2]]
  ];
  let stopped = false;

  function playSequence() {
    if (stopped || context.state === 'closed') return;
    let cursor = context.currentTime + 0.05;
    for (const [row, column] of tones) {
      const end = cursor + 0.18;
      scheduleTone(context, context.destination, row, cursor, end, testOscillators);
      scheduleTone(context, context.destination, column, cursor, end, testOscillators);
      cursor = end + 0.12;
    }
  }

  playSequence();
  const repeatTimer = setInterval(playSequence, 1800);
  return () => {
    stopped = true;
    clearInterval(repeatTimer);
    for (const oscillator of testOscillators) {
      try { oscillator.stop(); } catch {}
    }
    testOscillators.clear();
    context.close().catch(() => {});
  };
}

export async function stopAcousticOutput() {
  const context = outputContext;
  outputContext = null;
  cancelAcousticPlayback();
  try { await context?.close(); } catch {}
}

export function cancelAcousticPlayback() {
  for (const oscillator of activeOscillators) {
    try { oscillator.stop(); } catch {}
  }
  activeOscillators.clear();
}

function goertzel(samples, sampleRate, frequency) {
  const coefficient = 2 * Math.cos(2 * Math.PI * frequency / sampleRate);
  let previous = 0;
  let beforePrevious = 0;
  for (const sample of samples) {
    const current = sample + coefficient * previous - beforePrevious;
    beforePrevious = previous;
    previous = current;
  }
  return Math.max(0,
    previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious) /
    (samples.length * samples.length);
}

function strongestIndex(values) {
  let best = 0;
  let second = 0;
  let index = 0;
  values.forEach((value, candidate) => {
    if (value > best) {
      second = best;
      best = value;
      index = candidate;
    } else if (value > second) {
      second = value;
    }
  });
  return { index, best, second };
}

function detectDtmfSymbol(samples, sampleRate) {
  let sumSquares = 0;
  for (const sample of samples) sumSquares += sample * sample;
  const rms = Math.sqrt(sumSquares / samples.length);
  if (rms < 0.006) return null;

  const row = strongestIndex(DTMF_ROWS.map(frequency => goertzel(samples, sampleRate, frequency)));
  const column = strongestIndex(DTMF_COLUMNS.map(frequency => goertzel(samples, sampleRate, frequency)));
  if (row.best < 0.000004 || column.best < 0.000004 ||
      row.best < row.second * 2.2 || column.best < column.second * 2.2) return null;
  const balance = row.best / column.best;
  if (balance < 0.16 || balance > 6.25) return null;
  return row.index * 4 + column.index;
}

function stopTracks(stream) {
  stream?.getTracks().forEach(track => track.stop());
}

async function openAcousticInput() {
  const AudioContext = audioContextConstructor();
  if (!AudioContext || !navigator.mediaDevices?.getUserMedia)
    throw new Error('Audio input is not supported.');
  const context = new AudioContext();
  let stream = null;
  try {
    const resume = context.state === 'suspended'
      ? context.resume().catch(() => {})
      : Promise.resolve();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1
        },
        video: false
      });
    } catch (error) {
      if (error?.name === 'NotAllowedError') throw error;
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
    await resume;
    if (context.state === 'suspended') await context.resume();
    return { context, stream };
  } catch (error) {
    stopTracks(stream);
    try { await context.close(); } catch {}
    throw error;
  }
}

async function acquireAcousticInput() {
  if (inputContext && inputContext.state !== 'closed' &&
      inputStream?.getAudioTracks().some(track => track.readyState === 'live'))
    return { context: inputContext, stream: inputStream };

  const { context, stream } = await openAcousticInput();
  inputContext = context;
  inputStream = stream;
  return { context, stream };
}

export async function stopAcousticInput() {
  const context = inputContext;
  const stream = inputStream;
  inputContext = null;
  inputStream = null;
  stopTracks(stream);
  try { await context?.close(); } catch {}
}

function releaseAcousticInput(context, stream) {
  if (inputContext === context) inputContext = null;
  if (inputStream === stream) inputStream = null;
  stopTracks(stream);
  context.close().catch(() => {});
}

export async function startAcousticLevelMonitor(onLevel) {
  const { context, stream } = await openAcousticInput();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.15;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let animationFrame = 0;
  let stopped = false;

  function sampleLevel() {
    if (stopped) return;
    analyser.getFloatTimeDomainData(samples);
    let sumSquares = 0;
    for (const sample of samples) sumSquares += sample * sample;
    onLevel(Math.sqrt(sumSquares / samples.length));
    animationFrame = requestAnimationFrame(sampleLevel);
  }

  sampleLevel();
  return () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(animationFrame);
    try { source.disconnect(); } catch {}
    releaseAcousticInput(context, stream);
  };
}

export async function listenForAcousticRequest({
  session,
  kinds,
  keepInput = false,
  timeoutMs = ACOUSTIC_REQUEST_CONFIG.timeoutMs,
  signal,
  onListening
}) {
  const acceptedKinds = kinds ? new Set(kinds) : null;
  let context;
  let stream;
  try {
    ({ context, stream } = await acquireAcousticInput());
  } catch {
    return { status: 'unavailable' };
  }

  if (signal?.aborted) {
    releaseAcousticInput(context, stream);
    return { status: 'aborted' };
  }

  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  return new Promise(resolve => {
    let interval = 0;
    let timeout = 0;
    let settled = false;
    let candidate = null;
    let candidateHits = 0;
    let latched = null;
    const symbols = [];

    function cleanup() {
      clearInterval(interval);
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      try { source.disconnect(); } catch {}
      if (!keepInput) releaseAcousticInput(context, stream);
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    function abort() {
      finish({ status: 'aborted' });
    }

    function poll() {
      analyser.getFloatTimeDomainData(samples);
      const symbol = detectDtmfSymbol(samples, context.sampleRate);
      if (symbol === null) {
        candidate = null;
        candidateHits = 0;
        latched = null;
        return;
      }

      if (symbol === candidate) candidateHits++;
      else {
        candidate = symbol;
        candidateHits = 1;
      }
      if (candidateHits < 2 || symbol === latched) return;

      latched = symbol;
      symbols.push(symbol);
      if (symbols.length > 180) symbols.splice(0, symbols.length - 180);
      const request = symbolsToRequest(symbols);
      if (request?.session === (session >>> 0) &&
          (!acceptedKinds || acceptedKinds.has(request.kind)))
        finish({ status: 'received', request });
    }

    signal?.addEventListener('abort', abort, { once: true });
    onListening?.();
    interval = setInterval(poll, ACOUSTIC_REQUEST_CONFIG.pollMs);
    if (timeoutMs > 0) timeout = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
  });
}
