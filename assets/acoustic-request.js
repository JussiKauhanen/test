/*
 * NearChat acoustic request controls.
 * The packet uses audible DTMF-style voice-band tones so ordinary phone
 * speakers and microphones can carry it without device-specific APIs.
 */
export const ACOUSTIC_REQUEST_CONFIG = Object.freeze({
  timeoutMs: 10_000,
  repeatCount: 2,
  toneMs: 90,
  gapMs: 85,
  repeatGapMs: 180,
  oscillatorGain: 0.12,
  pollMs: 22
});

export const ACOUSTIC_REQUEST_FULL = 1;

const HANDSHAKE_PROTOCOL = 'NCA1';
const REQUEST_MAGIC = new Uint8Array([0x4e, 0x51]); // NQ
const REQUEST_VERSION = 1;
const REQUEST_BYTES = 10;
const REQUEST_PREAMBLE = [0x0a, 0x0d, 0x0a, 0x0d];
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

function hex(value, width) {
  return (value >>> 0).toString(16).toUpperCase().padStart(width, '0');
}

export function buildAcousticHandshake(session) {
  const body = `${HANDSHAKE_PROTOCOL}|${hex(session, 8)}`;
  const checksum = crc16(new TextEncoder().encode(body));
  return `${body}|${hex(checksum, 4)}`;
}

export function parseAcousticHandshake(raw) {
  const match = typeof raw === 'string'
    ? /^NCA1\|([0-9A-F]{8})\|([0-9A-F]{4})$/i.exec(raw)
    : null;
  if (!match) return null;
  const body = `${HANDSHAKE_PROTOCOL}|${match[1].toUpperCase()}`;
  if (crc16(new TextEncoder().encode(body)) !== Number.parseInt(match[2], 16)) return null;
  return { session: Number.parseInt(match[1], 16) >>> 0 };
}

export function buildAcousticRequestPacket(session, kind = ACOUSTIC_REQUEST_FULL) {
  const output = new Uint8Array(REQUEST_BYTES);
  const view = new DataView(output.buffer);
  output.set(REQUEST_MAGIC, 0);
  output[2] = REQUEST_VERSION;
  output[3] = kind;
  view.setUint32(4, session >>> 0, false);
  view.setUint16(8, crc16(output.subarray(0, 8)), false);
  return output;
}

export function parseAcousticRequestPacket(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== REQUEST_BYTES ||
      bytes[0] !== REQUEST_MAGIC[0] || bytes[1] !== REQUEST_MAGIC[1] ||
      bytes[2] !== REQUEST_VERSION) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (crc16(bytes.subarray(0, 8)) !== view.getUint16(8, false)) return null;
  return {
    kind: bytes[3],
    session: view.getUint32(4, false) >>> 0
  };
}

function requestSymbols(session, kind) {
  const packet = buildAcousticRequestPacket(session, kind);
  const symbols = [...REQUEST_PREAMBLE];
  for (const byte of packet) symbols.push(byte >>> 4, byte & 0x0f);
  return symbols;
}

function symbolsToRequest(symbols) {
  const frameSymbols = REQUEST_PREAMBLE.length + REQUEST_BYTES * 2;
  for (let offset = 0; offset <= symbols.length - frameSymbols; offset++) {
    if (!REQUEST_PREAMBLE.every((symbol, index) => symbols[offset + index] === symbol)) continue;
    const bytes = new Uint8Array(REQUEST_BYTES);
    for (let index = 0; index < REQUEST_BYTES; index++) {
      const high = symbols[offset + REQUEST_PREAMBLE.length + index * 2];
      const low = symbols[offset + REQUEST_PREAMBLE.length + index * 2 + 1];
      bytes[index] = (high << 4) | low;
    }
    const request = parseAcousticRequestPacket(bytes);
    if (request) return request;
  }
  return null;
}

function audioContextConstructor() {
  return window.AudioContext || window.webkitAudioContext;
}

let outputContext = null;

export async function prepareAcousticOutput() {
  const AudioContext = audioContextConstructor();
  if (!AudioContext) throw new Error('Audio output is not supported.');
  if (!outputContext || outputContext.state === 'closed') outputContext = new AudioContext();
  if (outputContext.state === 'suspended') await outputContext.resume();
  return outputContext;
}

function scheduleTone(context, destination, frequency, start, end) {
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
  oscillator.start(start);
  oscillator.stop(end + 0.01);
}

export async function playAcousticRequest(session, kind = ACOUSTIC_REQUEST_FULL) {
  const context = await prepareAcousticOutput();
  const symbols = requestSymbols(session, kind);
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

export async function stopAcousticOutput() {
  const context = outputContext;
  outputContext = null;
  try { await context?.close(); } catch {}
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

export async function listenForAcousticRequest({
  session,
  timeoutMs = ACOUSTIC_REQUEST_CONFIG.timeoutMs,
  signal,
  onListening
}) {
  const AudioContext = audioContextConstructor();
  if (!AudioContext || !navigator.mediaDevices?.getUserMedia)
    return { status: 'unavailable' };

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
  } catch {
    stopTracks(stream);
    try { await context.close(); } catch {}
    return { status: 'unavailable' };
  }

  if (signal?.aborted) {
    stopTracks(stream);
    try { await context.close(); } catch {}
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
      stopTracks(stream);
      context.close().catch(() => {});
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
      if (symbols.length > 80) symbols.splice(0, symbols.length - 80);
      const request = symbolsToRequest(symbols);
      if (request?.session === (session >>> 0)) finish({ status: 'received', request });
    }

    signal?.addEventListener('abort', abort, { once: true });
    onListening?.();
    interval = setInterval(poll, ACOUSTIC_REQUEST_CONFIG.pollMs);
    if (timeoutMs > 0) timeout = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
  });
}
