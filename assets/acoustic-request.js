/*
 * NearChat voice-band control channel — v3 physical layer.
 *
 * Public API is unchanged; only the modem underneath is new.
 *
 * What changed vs v2 and why the phones could not hear each other:
 *
 *  1. DTMF pairs are gone. v2 required BOTH a 697-941 Hz row tone and a
 *     1209-1633 Hz column tone, then rejected the symbol unless their powers
 *     were within 6.25x of each other. Phone speakers roll the low band off by
 *     20-30 dB, so over the air that balance test essentially never passed.
 *     v3 sends ONE tone per symbol, in 1505-3675 Hz, where handset speakers
 *     and mics are actually efficient, with rising pre-emphasis to offset
 *     the usual top-end rolloff.
 *
 *  2. Capture is now continuous. v2 polled an AnalyserNode from
 *     setInterval(18 ms) on the main thread — the same thread that is painting
 *     QR frames at 60 fps on the listening device. Starved polls dropped
 *     symbols, and one dropped symbol kills the whole CRC'd packet. v3 pulls
 *     samples through an AudioWorklet (ScriptProcessor fallback) into a ring
 *     buffer, so a busy main thread delays demodulation but never loses audio.
 *
 *  3. Detection is relative, not absolute. v2 used fixed magnitude gates
 *     (rms > 0.006, power > 4e-6). v3 compares the winning tone against the
 *     median of all 32 tones — the same noise-floor-relative test that works
 *     reliably in the beep test page — so it adapts to room and mic gain.
 *
 *  4. Airtime fits the timeout. A v2 max-size request took ~9.6 s to play,
 *     but the sender only listened for 10 s counted from when it showed the
 *     inventory QR — the receiver still had to scan that QR first, so the
 *     reply could not physically arrive in time and the sender always fell
 *     back to FULL. v3 carries 4 bits per symbol (32 tones = 16 values x 2
 *     alternating banks), so a typical request is ~2.8 s, and the timeout is
 *     raised to 20 s with the repeat count fitted to the airtime budget.
 *
 *  5. iOS routing. Once getUserMedia has run, iOS puts the page in
 *     play-and-record and sends output to the earpiece at low volume. If a
 *     phone had ever been in send mode, its later request tones came out of
 *     the earpiece and the other phone could not hear them. v3 releases the
 *     mic and switches navigator.audioSession back to 'playback' before
 *     transmitting when nothing is listening.
 *
 *  6. Output level raised (single tone, gain 0.45 instead of two tones at
 *     0.12) with click-free raised-cosine edges.
 *
 * REQUEST_VERSION is bumped to 3: a v2 phone and a v3 phone will cleanly fail
 * to decode rather than exchange garbage. Update both devices.
 */

export const ACOUSTIC_REQUEST_CONFIG = Object.freeze({
  // --- protocol / timing -------------------------------------------------
  timeoutMs: 20_000,      // listener patience (index.html races this value)
  repeatCount: 3,         // max repeats; trimmed to fit airtimeBudgetMs
  airtimeBudgetMs: 8_000,
  toneMs: 110,            // tone on
  gapMs: 30,              // silence between tones
  repeatGapMs: 260,
  oscillatorGain: 0.45,   // level of the lowest tone
  preEmphasisDb: 6,       // extra level at the top of the band (speaker rolloff)
  maxPayloadBytes: 8,

  // --- receiver ----------------------------------------------------------
  windowMs: 60,           // Goertzel window
  hopMs: 15,              // window advance
  minRunHops: 2,          // hops a tone must hold to become a symbol
  peakOverSecond: 3.5,    // winning tone vs runner-up (power)
  peakOverFloor: 12,      // winning tone vs median of all tones (power)
  minRms: 0.001,          // absolute squelch, deliberately very low
  pollMs: 15              // kept for API compatibility
});

export const ACOUSTIC_REQUEST_FULL = 1;
export const ACOUSTIC_REQUEST_INDEXES = 2;
export const ACOUSTIC_REQUEST_MASK = 3;
export const ACOUSTIC_REQUEST_NONE = 4;
export const ACOUSTIC_REQUEST_DONE = 5;

const REQUEST_VERSION = 3;
const REQUEST_HEADER_BYTES = 6;
const REQUEST_CRC_BYTES = 2;

/* Symbol alphabet: 4 data bits x 2 banks. Consecutive symbols always come
 * from opposite banks, so two identical tones can never sit next to each
 * other and a run of equal detections is unambiguously one symbol. */
const SYMBOL_BITS = 4;
const SYMBOL_VALUES = 1 << SYMBOL_BITS;      // 16
const SYMBOL_MASK = SYMBOL_VALUES - 1;
const BANK = SYMBOL_VALUES;                  // bank bit
const TONE_COUNT = SYMBOL_VALUES * 2;        // 32

/* 1505 Hz + 70 Hz steps -> 1505..3675 Hz. Kept narrow on purpose: the wider
 * the band, the more a sloped speaker/mic response spreads the per-tone level
 * and starves the weakest tones. The base is chosen so that (base mod step) is
 * half a step, i.e. every tone's second harmonic lands midway between two
 * other tones, so speaker distortion cannot look like a neighbouring symbol. */
const TONE_BASE = 1505;
const TONE_STEP = 70;

/* Banks interleave across the band so neither bank is systematically the
 * quieter one on a speaker with a sloped response. */
function symbolFrequency(symbol) {
  const value = symbol & SYMBOL_MASK;
  const bank = symbol >= BANK ? 1 : 0;
  return TONE_BASE + (value * 2 + bank) * TONE_STEP;
}
const TONE_TABLE = Array.from({ length: TONE_COUNT }, (_, symbol) => symbolFrequency(symbol));

/* Alternates high/low bank and ends low, so data group 0 (high) continues
 * the alternation across the preamble boundary. */
const REQUEST_PREAMBLE = [BANK | 0x0a, 0x01, BANK | 0x0d, 0x04];

let logger = null;
/** Optional diagnostics sink, e.g. setAcousticLogger(m => addSyncHistory('send', m)) */
export function setAcousticLogger(fn) { logger = typeof fn === 'function' ? fn : null; }
function log(message) { try { logger?.(message); } catch {} }

/* ------------------------------------------------------------------ *
 * packet                                                              *
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * request selection (unchanged)                                       *
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * symbol framing                                                      *
 * ------------------------------------------------------------------ */

function packetSymbols(packet) {
  const symbols = [...REQUEST_PREAMBLE];
  let group = 0;
  for (const byte of packet) {
    for (const nibble of [byte >>> 4, byte & 0x0f]) {
      symbols.push(nibble + (group % 2 === 0 ? BANK : 0));
      group++;
    }
  }
  return symbols;
}

function groupsToBytes(groups, byteLength) {
  if (groups.length < byteLength * 2) return null;
  const output = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index++)
    output[index] = (groups[index * 2] << 4) | groups[index * 2 + 1];
  return output;
}

function symbolsToRequest(symbols) {
  const headerGroups = REQUEST_HEADER_BYTES * 2;
  for (let offset = 0; offset <= symbols.length - REQUEST_PREAMBLE.length; offset++) {
    if (!REQUEST_PREAMBLE.every((symbol, index) => symbols[offset + index] === symbol)) continue;
    const groups = [];
    for (let cursor = offset + REQUEST_PREAMBLE.length; cursor < symbols.length; cursor++) {
      const symbol = symbols[cursor];
      const expectedHighBank = groups.length % 2 === 0;
      if ((symbol >= BANK) !== expectedHighBank) break;   // bank alternation broken
      groups.push(symbol & SYMBOL_MASK);
      if (groups.length < headerGroups) continue;
      const header = groupsToBytes(groups, REQUEST_HEADER_BYTES);
      if (!header) continue;
      const payloadLength = header[5];
      if (payloadLength > ACOUSTIC_REQUEST_CONFIG.maxPayloadBytes) break;
      const byteLength = REQUEST_HEADER_BYTES + payloadLength + REQUEST_CRC_BYTES;
      if (groups.length < byteLength * 2) continue;
      const request = parseAcousticRequestPacket(groupsToBytes(groups, byteLength));
      if (request) return request;
      break;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * audio session / contexts                                            *
 * ------------------------------------------------------------------ */

function audioContextConstructor() {
  return window.AudioContext || window.webkitAudioContext;
}

/* iOS 17+ exposes navigator.audioSession. Leaving it in play-and-record after
 * a listening session routes playback to the earpiece — the reason a phone
 * that had been the sender could no longer be heard when it later replied. */
function setAudioSession(type) {
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch {}
}

let outputContext = null;
const activeOscillators = new Set();
let inputContext = null;
let inputStream = null;
let activeListeners = 0;

export async function prepareAcousticOutput() {
  const AudioContext = audioContextConstructor();
  if (!AudioContext) throw new Error('Audio output is not supported.');
  if (!outputContext || outputContext.state === 'closed') outputContext = new AudioContext();
  if (outputContext.state === 'suspended') await outputContext.resume();
  return outputContext;
}

/* Handset speakers roll off towards the top of the band, so tones are sent
 * with a rising pre-emphasis instead of a flat level. */
const TONE_SPAN = TONE_TABLE[TONE_COUNT - 1] - TONE_TABLE[0];
function toneGain(frequency) {
  const slope = ACOUSTIC_REQUEST_CONFIG.preEmphasisDb * (frequency - TONE_BASE) / TONE_SPAN;
  return ACOUSTIC_REQUEST_CONFIG.oscillatorGain * Math.pow(10, slope / 20);
}

function scheduleTone(context, destination, frequency, start, end) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const fade = Math.min(0.008, (end - start) / 4);
  const level = toneGain(frequency);
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(level, start + fade);
  gain.gain.setValueAtTime(level, end - fade);
  gain.gain.linearRampToValueAtTime(0, end);
  oscillator.connect(gain).connect(destination);
  activeOscillators.add(oscillator);
  oscillator.addEventListener('ended', () => activeOscillators.delete(oscillator), { once: true });
  oscillator.start(start);
  oscillator.stop(end + 0.01);
}

function repeatsFor(symbolCount) {
  const { toneMs, gapMs, repeatGapMs, repeatCount, airtimeBudgetMs } = ACOUSTIC_REQUEST_CONFIG;
  const perRepeat = symbolCount * (toneMs + gapMs) + repeatGapMs;
  return Math.max(2, Math.min(repeatCount, Math.floor(airtimeBudgetMs / perRepeat) || 2));
}

export async function playAcousticRequest(
  session,
  kind = ACOUSTIC_REQUEST_FULL,
  payload = new Uint8Array()
) {
  // Nothing is listening on this device: hand the audio session back to
  // playback so iOS uses the loudspeaker instead of the earpiece.
  if (!activeListeners && inputStream) await stopAcousticInput();
  setAudioSession(activeListeners ? 'play-and-record' : 'playback');

  const context = await prepareAcousticOutput();
  const symbols = packetSymbols(buildAcousticRequestPacket(session, kind, payload));
  const toneSeconds = ACOUSTIC_REQUEST_CONFIG.toneMs / 1000;
  const gapSeconds = ACOUSTIC_REQUEST_CONFIG.gapMs / 1000;
  const repeats = repeatsFor(symbols.length);
  let cursor = context.currentTime + 0.08;

  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const symbol of symbols) {
      const start = cursor;
      const end = start + toneSeconds;
      scheduleTone(context, context.destination, TONE_TABLE[symbol], start, end);
      cursor = end + gapSeconds;
    }
    cursor += ACOUSTIC_REQUEST_CONFIG.repeatGapMs / 1000;
  }

  const waitMs = Math.max(0, (cursor - context.currentTime) * 1000);
  log(`tx ${symbols.length} symbols x${repeats} (${(waitMs / 1000).toFixed(1)}s)`);
  await new Promise(resolve => setTimeout(resolve, waitMs));
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

/* ------------------------------------------------------------------ *
 * capture: worklet -> ring buffer                                     *
 * ------------------------------------------------------------------ */

const CAPTURE_WORKLET = `
class NearChatCapture extends AudioWorkletProcessor {
  constructor() { super(); this.block = new Float32Array(1024); this.filled = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let index = 0; index < channel.length; index++) {
        this.block[this.filled++] = channel[index];
        if (this.filled === this.block.length) {
          this.port.postMessage(this.block, [this.block.buffer]);
          this.block = new Float32Array(1024);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('nearchat-capture', NearChatCapture);
`;

class SampleRing {
  constructor(capacity) {
    this.data = new Float32Array(capacity);
    this.write = 0;
    this.read = 0;
    this.dropped = 0;
  }
  get available() { return this.write - this.read; }
  push(block) {
    const capacity = this.data.length;
    for (let index = 0; index < block.length; index++)
      this.data[(this.write + index) % capacity] = block[index];
    this.write += block.length;
    if (this.available > capacity) {
      this.dropped += this.available - capacity;
      this.read = this.write - capacity;
    }
  }
  copyInto(target) {
    const capacity = this.data.length;
    const start = this.read % capacity;
    for (let index = 0; index < target.length; index++)
      target[index] = this.data[(start + index) % capacity];
  }
}

function hannWindow(length) {
  const window = new Float32Array(length);
  for (let index = 0; index < length; index++)
    window[index] = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (length - 1));
  return window;
}

/* Goertzel on an already-windowed buffer. */
function goertzel(samples, coefficient) {
  let previous = 0;
  let beforePrevious = 0;
  for (let index = 0; index < samples.length; index++) {
    const current = samples[index] + coefficient * previous - beforePrevious;
    beforePrevious = previous;
    previous = current;
  }
  const power = previous * previous + beforePrevious * beforePrevious -
    coefficient * previous * beforePrevious;
  return power > 0 ? power / (samples.length * samples.length) : 0;
}

function median(values) {
  const sorted = Float64Array.from(values).sort();
  return sorted[sorted.length >> 1];
}

/** Windowed multi-tone detector. Returns a symbol index or null. */
function detectSymbol(frame, windowed, window, coefficients, powers) {
  let sumSquares = 0;
  for (let index = 0; index < frame.length; index++) {
    const sample = frame[index];
    sumSquares += sample * sample;
    windowed[index] = sample * window[index];
  }
  const rms = Math.sqrt(sumSquares / frame.length);
  if (rms < ACOUSTIC_REQUEST_CONFIG.minRms) return null;

  let best = 0, second = 0, bestIndex = -1;
  for (let tone = 0; tone < TONE_COUNT; tone++) {
    const power = goertzel(windowed, coefficients[tone]);
    powers[tone] = power;
    if (power > best) { second = best; best = power; bestIndex = tone; }
    else if (power > second) { second = power; }
  }
  if (bestIndex < 0 || best <= 0) return null;
  if (best < second * ACOUSTIC_REQUEST_CONFIG.peakOverSecond) return null;
  const floor = median(powers) || Number.MIN_VALUE;
  if (best < floor * ACOUSTIC_REQUEST_CONFIG.peakOverFloor) return null;
  return bestIndex;
}

function stopTracks(stream) {
  stream?.getTracks().forEach(track => track.stop());
}

async function acquireAcousticInput() {
  if (inputContext && inputContext.state !== 'closed' &&
      inputStream?.getAudioTracks().some(track => track.readyState === 'live'))
    return { context: inputContext, stream: inputStream };

  const AudioContext = audioContextConstructor();
  if (!AudioContext || !navigator.mediaDevices?.getUserMedia)
    throw new Error('Audio input is not supported.');
  setAudioSession('play-and-record');
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
    inputContext = context;
    inputStream = stream;
    return { context, stream };
  } catch (error) {
    stopTracks(stream);
    try { await context.close(); } catch {}
    throw error;
  }
}

export async function stopAcousticInput() {
  const context = inputContext;
  const stream = inputStream;
  inputContext = null;
  inputStream = null;
  stopTracks(stream);
  try { await context?.close(); } catch {}
  if (!activeListeners) setAudioSession('playback');
}

function releaseAcousticInput(context, stream) {
  if (inputContext === context) inputContext = null;
  if (inputStream === stream) inputStream = null;
  stopTracks(stream);
  context.close().catch(() => {});
  if (!activeListeners) setAudioSession('playback');
}

/* Continuous capture node. Prefers AudioWorklet (audio thread, immune to the
 * QR animation hogging the main thread); falls back to ScriptProcessor. */
async function createCaptureNode(context, source, onBlock) {
  if (context.audioWorklet) {
    let url = null;
    try {
      url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'text/javascript' }));
      await context.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(context, 'nearchat-capture', {
        numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1
      });
      node.port.onmessage = event => onBlock(event.data);
      source.connect(node);
      return { node, dispose() { try { node.port.onmessage = null; node.disconnect(); } catch {} } };
    } catch {
      /* fall through */
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }

  const node = context.createScriptProcessor(2048, 1, 1);
  const sink = context.createGain();
  sink.gain.value = 0;                       // Safari needs a path to destination
  node.onaudioprocess = event => onBlock(new Float32Array(event.inputBuffer.getChannelData(0)));
  source.connect(node);
  node.connect(sink).connect(context.destination);
  return {
    node,
    dispose() { try { node.onaudioprocess = null; node.disconnect(); sink.disconnect(); } catch {} }
  };
}

/* ------------------------------------------------------------------ *
 * listener                                                            *
 * ------------------------------------------------------------------ */

export async function listenForAcousticRequest({
  session,
  kinds,
  keepInput = false,
  timeoutMs = ACOUSTIC_REQUEST_CONFIG.timeoutMs,
  signal,
  onListening,
  onSignal
}) {
  const acceptedKinds = kinds ? new Set(kinds) : null;
  let context;
  let stream;
  activeListeners++;
  try {
    ({ context, stream } = await acquireAcousticInput());
  } catch (error) {
    activeListeners--;
    log(`rx unavailable: ${error?.message ?? error}`);
    return { status: 'unavailable' };
  }

  if (signal?.aborted) {
    activeListeners--;
    if (!keepInput) releaseAcousticInput(context, stream);
    return { status: 'aborted' };
  }

  const sampleRate = context.sampleRate;
  const windowSamples = Math.max(256, Math.round(sampleRate * ACOUSTIC_REQUEST_CONFIG.windowMs / 1000));
  const hopSamples = Math.max(64, Math.round(sampleRate * ACOUSTIC_REQUEST_CONFIG.hopMs / 1000));
  const window = hannWindow(windowSamples);
  const coefficients = TONE_TABLE.map(frequency =>
    2 * Math.cos(2 * Math.PI * frequency / sampleRate));
  const frame = new Float32Array(windowSamples);
  const windowed = new Float32Array(windowSamples);
  const powers = new Float64Array(TONE_COUNT);
  const ring = new SampleRing(Math.round(sampleRate * 2));

  const source = context.createMediaStreamSource(stream);
  let capture;
  try {
    capture = await createCaptureNode(context, source, block => ring.push(block));
  } catch (error) {
    activeListeners--;
    try { source.disconnect(); } catch {}
    if (!keepInput) releaseAcousticInput(context, stream);
    log(`rx capture failed: ${error?.message ?? error}`);
    return { status: 'unavailable' };
  }

  return new Promise(resolve => {
    let interval = 0;
    let timeout = 0;
    let settled = false;
    let runSymbol = -1;
    let runLength = 0;
    let emitted = -1;
    let quiet = 0;
    const symbols = [];

    function cleanup() {
      clearInterval(interval);
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      capture.dispose();
      try { source.disconnect(); } catch {}
      activeListeners = Math.max(0, activeListeners - 1);
      if (!keepInput) releaseAcousticInput(context, stream);
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    function abort() { finish({ status: 'aborted' }); }

    function drain() {
      // Catch-up guard: if the main thread stalled badly, skip stale audio
      // rather than spending seconds demodulating the past.
      const backlogLimit = sampleRate * 1.2;
      if (ring.available > backlogLimit) {
        ring.read = ring.write - backlogLimit;
        log('rx backlog skipped');
      }

      while (!settled && ring.available >= windowSamples) {
        ring.copyInto(frame);
        ring.read += hopSamples;
        const symbol = detectSymbol(frame, windowed, window, coefficients, powers);

        if (symbol === null) {
          if (++quiet >= 2) { runSymbol = -1; runLength = 0; emitted = -1; }
          continue;
        }
        quiet = 0;

        if (symbol === runSymbol) runLength++;
        else { runSymbol = symbol; runLength = 1; }
        if (runLength !== ACOUSTIC_REQUEST_CONFIG.minRunHops || symbol === emitted) continue;

        emitted = symbol;
        symbols.push(symbol);
        if (symbols.length > 260) symbols.splice(0, symbols.length - 260);
        onSignal?.({ symbol, frequency: TONE_TABLE[symbol], count: symbols.length });

        const request = symbolsToRequest(symbols);
        if (!request) continue;
        if (request.session !== (session >>> 0)) {
          log(`rx packet for another session ${request.session.toString(16)}`);
          symbols.length = 0;
          continue;
        }
        if (acceptedKinds && !acceptedKinds.has(request.kind)) {
          symbols.length = 0;
          continue;
        }
        log(`rx decoded kind ${request.kind} (${request.payload.length} B)`);
        finish({ status: 'received', request });
        return;
      }
    }

    signal?.addEventListener('abort', abort, { once: true });
    onListening?.();
    log(`rx listening @${Math.round(sampleRate)} Hz, ${TONE_COUNT} tones ` +
        `${TONE_TABLE[0]}-${TONE_TABLE[TONE_COUNT - 1]} Hz`);
    interval = setInterval(drain, ACOUSTIC_REQUEST_CONFIG.hopMs);
    if (timeoutMs > 0) timeout = setTimeout(() => {
      log('rx timeout');
      finish({ status: 'timeout' });
    }, timeoutMs);
  });
}
