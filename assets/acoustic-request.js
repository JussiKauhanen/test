/*
 * NearChat voice-band helpers. Production sync uses a proven three-beep
 * preamble followed by up to four ordered single-frequency group tones.
 * The older packet codec remains available only for isolated diagnostics.
 */
export const ACOUSTIC_REQUEST_CONFIG = Object.freeze({
  timeoutMs: 10_000,
  repeatCount: 2,
  toneMs: 82,
  gapMs: 18,
  repeatGapMs: 160,
  // Two simultaneous DTMF oscillators sum at the output; 0.42 keeps the pair below clipping.
  oscillatorGain: 0.42,
  pollMs: 18,
  maxPayloadBytes: 8
});

export const ACOUSTIC_REQUEST_FULL = 1;
export const ACOUSTIC_REQUEST_INDEXES = 2;
export const ACOUSTIC_REQUEST_MASK = 3;
export const ACOUSTIC_REQUEST_NONE = 4;
export const ACOUSTIC_REQUEST_DONE = 5;

export const ACOUSTIC_GROUP_CONFIG = Object.freeze({
  timeoutMs: 5000,
  preambleFrequencyHz: 1800,
  preambleCount: 3,
  groupFrequencies: Object.freeze([697, 852, 1209, 1477]),
  toneMs: 150,
  gapMs: 130,
  settleMs: 450,
  thresholdDb: 16,
  absoluteMinDb: -85,
  pollMs: 18
});

export const ACOUSTIC_TEST_CONFIG = Object.freeze({
  frequencyHz: 1800,
  beepMs: 150,
  gapMs: 130,
  beepCount: 3,
  periodMs: 3000,
  absoluteMinDb: -85
});
export const ACOUSTIC_CHANNEL_TEST_CONFIG = Object.freeze({
  frequencies: Object.freeze([697, 852, 1209, 1477])
});
export const ACOUSTIC_CODED_TEST_CONFIG = Object.freeze({
  preambleFrequencyHz: 1800,
  preambleCount: 3,
  dataDigits: Object.freeze([0, 1, 2, 2]),
  toneMs: 100,
  gapMs: 87,
  periodMs: 3000
});

export function codedTestChecksum(digits) {
  if (!Array.isArray(digits) || digits.length !== 4 ||
      !digits.every(digit => Number.isInteger(digit) && digit >= 0 && digit < 4)) return null;
  return (4 - digits.reduce((sum, digit) => sum + digit, 0) % 4) % 4;
}

export function codedTestMask(digits) {
  if (!Array.isArray(digits) || digits.length !== 4 ||
      !digits.every(digit => Number.isInteger(digit) && digit >= 0 && digit < 4)) return null;
  return digits.reduce((mask, digit, index) => mask | digit << (index * 2), 0);
}

export function createCodedTestDecoder() {
  const preambleSymbol = ACOUSTIC_CHANNEL_TEST_CONFIG.frequencies.length;
  let activeSymbol = null;
  let preambleOnsets = 0;
  let digits = [];

  return {
    reset() {
      activeSymbol = null;
      preambleOnsets = 0;
      digits = [];
    },
    sample(symbol) {
      if (symbol == null) {
        activeSymbol = null;
        return null;
      }
      if (!Number.isInteger(symbol) || symbol < 0 || symbol > preambleSymbol ||
          symbol === activeSymbol) return null;
      activeSymbol = symbol;

      if (symbol === preambleSymbol) {
        if (preambleOnsets >= ACOUSTIC_CODED_TEST_CONFIG.preambleCount || digits.length) {
          preambleOnsets = 0;
          digits = [];
        }
        preambleOnsets++;
        return {
          type: 'preamble',
          count: preambleOnsets,
          complete: preambleOnsets === ACOUSTIC_CODED_TEST_CONFIG.preambleCount
        };
      }

      if (preambleOnsets !== ACOUSTIC_CODED_TEST_CONFIG.preambleCount) {
        preambleOnsets = 0;
        digits = [];
        return { type: 'reset' };
      }

      digits.push(symbol);
      if (digits.length <= ACOUSTIC_CODED_TEST_CONFIG.dataDigits.length)
        return { type: 'data', slot: digits.length - 1, digit: symbol };

      const dataDigits = digits.slice(0, ACOUSTIC_CODED_TEST_CONFIG.dataDigits.length);
      const expectedChecksum = codedTestChecksum(dataDigits);
      const frame = {
        type: 'frame',
        dataDigits,
        receivedChecksum: symbol,
        expectedChecksum,
        checksumPassed: symbol === expectedChecksum,
        partMask: codedTestMask(dataDigits)
      };
      preambleOnsets = 0;
      digits = [];
      return frame;
    }
  };
}

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

function symbolsToRequest(symbols, onRejected) {
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
      onRejected?.();
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

function scheduleTone(
  context,
  destination,
  frequency,
  start,
  end,
  oscillators = activeOscillators,
  gainValue = ACOUSTIC_REQUEST_CONFIG.oscillatorGain
) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const fade = Math.min(0.006, (end - start) / 4);
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(gainValue, start + fade);
  gain.gain.setValueAtTime(gainValue, end - fade);
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

export async function playAcousticGroupRequest(groupMask) {
  if (!Number.isInteger(groupMask) || groupMask < 0 || groupMask > 0x0f)
    throw new Error('The sound group request is invalid.');
  const context = await prepareAcousticOutput();
  cancelAcousticPlayback();
  const frequencies = [
    ...Array(ACOUSTIC_GROUP_CONFIG.preambleCount)
      .fill(ACOUSTIC_GROUP_CONFIG.preambleFrequencyHz),
    ...ACOUSTIC_GROUP_CONFIG.groupFrequencies
      .filter((frequency, index) => groupMask & 1 << index)
  ];
  const toneSeconds = ACOUSTIC_GROUP_CONFIG.toneMs / 1000;
  const spacingSeconds = (ACOUSTIC_GROUP_CONFIG.toneMs + ACOUSTIC_GROUP_CONFIG.gapMs) / 1000;
  let cursor = context.currentTime + 0.06;

  for (const frequency of frequencies) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const end = cursor + toneSeconds;
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, cursor);
    gain.gain.exponentialRampToValueAtTime(0.6, cursor + 0.008);
    gain.gain.setValueAtTime(0.6, end - 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain).connect(context.destination);
    activeOscillators.add(oscillator);
    oscillator.addEventListener('ended', () => activeOscillators.delete(oscillator), { once: true });
    oscillator.start(cursor);
    oscillator.stop(end + 0.02);
    cursor += spacingSeconds;
  }

  const waitMs = Math.max(0, (cursor - context.currentTime) * 1000);
  await new Promise(resolve => setTimeout(resolve, waitMs));
  return groupMask;
}

export async function startAcousticTestSequence(onBurst) {
  const AudioContext = audioContextConstructor();
  if (!AudioContext) throw new Error('Audio output is not supported.');
  const context = new AudioContext();
  if (context.state === 'suspended') await context.resume();
  const testOscillators = new Set();
  let stopped = false;
  let burstCount = 0;

  function scheduleTestBeep(start) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const end = start + ACOUSTIC_TEST_CONFIG.beepMs / 1000;
    oscillator.type = 'sine';
    oscillator.frequency.value = ACOUSTIC_TEST_CONFIG.frequencyHz;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.6, start + 0.008);
    gain.gain.setValueAtTime(0.6, end - 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain).connect(context.destination);
    testOscillators.add(oscillator);
    oscillator.addEventListener('ended', () => testOscillators.delete(oscillator), { once: true });
    oscillator.start(start);
    oscillator.stop(end + 0.02);
  }

  function playSequence() {
    if (stopped || context.state === 'closed') return;
    const start = context.currentTime + 0.06;
    const spacing = (ACOUSTIC_TEST_CONFIG.beepMs + ACOUSTIC_TEST_CONFIG.gapMs) / 1000;
    for (let index = 0; index < ACOUSTIC_TEST_CONFIG.beepCount; index++)
      scheduleTestBeep(start + index * spacing);
    burstCount++;
    try { onBurst?.(burstCount); } catch {}
  }

  playSequence();
  const repeatTimer = setInterval(playSequence, ACOUSTIC_TEST_CONFIG.periodMs);
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

export async function startAcousticChannelTestSequence(onSequence) {
  const AudioContext = audioContextConstructor();
  if (!AudioContext) throw new Error('Audio output is not supported.');
  const context = new AudioContext();
  if (context.state === 'suspended') await context.resume();
  const testOscillators = new Set();
  let stopped = false;
  let sequenceCount = 0;

  function scheduleChannel(frequency, start) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const end = start + ACOUSTIC_TEST_CONFIG.beepMs / 1000;
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.6, start + 0.008);
    gain.gain.setValueAtTime(0.6, end - 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain).connect(context.destination);
    testOscillators.add(oscillator);
    oscillator.addEventListener('ended', () => testOscillators.delete(oscillator), { once: true });
    oscillator.start(start);
    oscillator.stop(end + 0.02);
  }

  function playSequence() {
    if (stopped || context.state === 'closed') return;
    const start = context.currentTime + 0.06;
    const spacing = (ACOUSTIC_TEST_CONFIG.beepMs + ACOUSTIC_TEST_CONFIG.gapMs) / 1000;
    ACOUSTIC_CHANNEL_TEST_CONFIG.frequencies.forEach((frequency, index) =>
      scheduleChannel(frequency, start + index * spacing));
    sequenceCount++;
    try { onSequence?.(sequenceCount); } catch {}
  }

  playSequence();
  const repeatTimer = setInterval(playSequence, ACOUSTIC_TEST_CONFIG.periodMs);
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

export async function startAcousticCodedTestSequence(onSequence) {
  const AudioContext = audioContextConstructor();
  if (!AudioContext) throw new Error('Audio output is not supported.');
  const context = new AudioContext();
  if (context.state === 'suspended') await context.resume();
  const testOscillators = new Set();
  const checksumDigit = codedTestChecksum(ACOUSTIC_CODED_TEST_CONFIG.dataDigits);
  const frequencies = [
    ...Array(ACOUSTIC_CODED_TEST_CONFIG.preambleCount)
      .fill(ACOUSTIC_CODED_TEST_CONFIG.preambleFrequencyHz),
    ...ACOUSTIC_CODED_TEST_CONFIG.dataDigits
      .map(digit => ACOUSTIC_CHANNEL_TEST_CONFIG.frequencies[digit]),
    ACOUSTIC_CHANNEL_TEST_CONFIG.frequencies[checksumDigit]
  ];
  const partMask = codedTestMask(ACOUSTIC_CODED_TEST_CONFIG.dataDigits);
  let stopped = false;
  let sequenceCount = 0;

  function scheduleTone(frequency, start) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const end = start + ACOUSTIC_CODED_TEST_CONFIG.toneMs / 1000;
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.6, start + 0.008);
    gain.gain.setValueAtTime(0.6, end - 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain).connect(context.destination);
    testOscillators.add(oscillator);
    oscillator.addEventListener('ended', () => testOscillators.delete(oscillator), { once: true });
    oscillator.start(start);
    oscillator.stop(end + 0.02);
  }

  function playSequence() {
    if (stopped || context.state === 'closed') return;
    const start = context.currentTime + 0.06;
    const spacing = (ACOUSTIC_CODED_TEST_CONFIG.toneMs +
      ACOUSTIC_CODED_TEST_CONFIG.gapMs) / 1000;
    frequencies.forEach((frequency, index) => scheduleTone(frequency, start + index * spacing));
    sequenceCount++;
    try { onSequence?.({ sequenceCount, checksumDigit, partMask }); } catch {}
  }

  playSequence();
  const repeatTimer = setInterval(playSequence, ACOUSTIC_CODED_TEST_CONFIG.periodMs);
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

function measureFrequencyBins(bins, target) {
  let peak = -Infinity;
  for (let index = target - 1; index <= target + 1; index++)
    peak = Math.max(peak, bins[index]);
  const nearby = [];
  for (let index = Math.max(0, target - 60);
      index <= Math.min(bins.length - 1, target + 60); index++)
    if (Math.abs(index - target) > 4 && Number.isFinite(bins[index]))
      nearby.push(bins[index]);
  nearby.sort((a, b) => a - b);
  const floor = nearby.length ? nearby[nearby.length >> 1] : -120;
  return { peak, floor, score: Number.isFinite(peak) ? peak - floor : 0 };
}

export async function startAcousticTestMonitor(onSample) {
  const { context, stream } = await openAcousticInput();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  const bins = new Float32Array(analyser.frequencyBinCount);
  const target = Math.round(ACOUSTIC_TEST_CONFIG.frequencyHz /
    (context.sampleRate / analyser.fftSize));
  let animationFrame = 0;
  let stopped = false;

  function sampleTone() {
    if (stopped) return;
    analyser.getFloatFrequencyData(bins);
    onSample({
      ...measureFrequencyBins(bins, target),
      sampleRate: context.sampleRate,
      targetBin: target
    });
    animationFrame = requestAnimationFrame(sampleTone);
  }

  sampleTone();
  return () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(animationFrame);
    try { source.disconnect(); } catch {}
    releaseAcousticInput(context, stream);
  };
}

async function startFrequencyTestMonitor(frequencies, onSample, fftSize = 4096) {
  const { context, stream } = await openAcousticInput();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = fftSize;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  const bins = new Float32Array(analyser.frequencyBinCount);
  const binHz = context.sampleRate / analyser.fftSize;
  const channels = frequencies.map(frequency => ({
    frequency,
    target: Math.round(frequency / binHz)
  }));
  let animationFrame = 0;
  let stopped = false;

  function sampleChannels() {
    if (stopped) return;
    analyser.getFloatFrequencyData(bins);
    onSample({
      channels: channels.map(channel => ({
        frequency: channel.frequency,
        ...measureFrequencyBins(bins, channel.target)
      })),
      sampleRate: context.sampleRate,
      fftSize
    });
    animationFrame = requestAnimationFrame(sampleChannels);
  }

  sampleChannels();
  return () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(animationFrame);
    try { source.disconnect(); } catch {}
    releaseAcousticInput(context, stream);
  };
}

export function startAcousticChannelTestMonitor(onSample) {
  return startFrequencyTestMonitor(ACOUSTIC_CHANNEL_TEST_CONFIG.frequencies, onSample);
}

export function startAcousticCodedTestMonitor(onSample) {
  return startFrequencyTestMonitor([
    ...ACOUSTIC_CHANNEL_TEST_CONFIG.frequencies,
    ACOUSTIC_CODED_TEST_CONFIG.preambleFrequencyHz
  ], onSample, 2048);
}

export async function listenForAcousticGroupRequest({
  keepInput = false,
  timeoutMs = ACOUSTIC_GROUP_CONFIG.timeoutMs,
  signal,
  onListening,
  onPreamble
} = {}) {
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
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  const bins = new Float32Array(analyser.frequencyBinCount);
  const binHz = context.sampleRate / analyser.fftSize;
  const frequencies = [
    ...ACOUSTIC_GROUP_CONFIG.groupFrequencies,
    ACOUSTIC_GROUP_CONFIG.preambleFrequencyHz
  ];
  const targets = frequencies.map(frequency => Math.round(frequency / binHz));

  return new Promise(resolve => {
    let interval = 0;
    let timeout = 0;
    let settled = false;
    let activeSymbol = null;
    let preambleOnsets = 0;
    let collecting = false;
    let groupMask = 0;
    let lastGroup = -1;
    let lastAcceptedAt = 0;

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

    function resetFrame() {
      preambleOnsets = 0;
      collecting = false;
      groupMask = 0;
      lastGroup = -1;
      lastAcceptedAt = 0;
    }

    function acceptSymbol(symbol, now) {
      const preambleSymbol = ACOUSTIC_GROUP_CONFIG.groupFrequencies.length;
      if (symbol === preambleSymbol) {
        if (collecting || preambleOnsets >= ACOUSTIC_GROUP_CONFIG.preambleCount)
          resetFrame();
        preambleOnsets++;
        if (preambleOnsets === ACOUSTIC_GROUP_CONFIG.preambleCount) {
          collecting = true;
          lastAcceptedAt = now;
          try { onPreamble?.(); } catch {}
        }
        return;
      }
      if (!collecting) {
        resetFrame();
        return;
      }
      if (symbol <= lastGroup) {
        resetFrame();
        return;
      }
      groupMask |= 1 << symbol;
      lastGroup = symbol;
      lastAcceptedAt = now;
    }

    function poll() {
      const now = performance.now();
      analyser.getFloatFrequencyData(bins);
      const candidates = targets
        .map((target, index) => ({ index, ...measureFrequencyBins(bins, target) }))
        .filter(candidate => candidate.score > ACOUSTIC_GROUP_CONFIG.thresholdDb &&
          candidate.peak > ACOUSTIC_GROUP_CONFIG.absoluteMinDb)
        .sort((a, b) => b.score - a.score);
      const strongest = candidates[0] ?? null;
      if (!strongest) {
        activeSymbol = null;
        if (collecting && now - lastAcceptedAt >= ACOUSTIC_GROUP_CONFIG.settleMs)
          finish({ status: 'received', groupMask });
        return;
      }
      if (strongest.index === activeSymbol) return;
      activeSymbol = strongest.index;
      acceptSymbol(strongest.index, now);
    }

    signal?.addEventListener('abort', abort, { once: true });
    try { onListening?.(); } catch {}
    interval = setInterval(poll, ACOUSTIC_GROUP_CONFIG.pollMs);
    if (timeoutMs > 0) timeout = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
  });
}

export async function listenForAcousticRequest({
  session,
  kinds,
  keepInput = false,
  privateInput = false,
  timeoutMs = ACOUSTIC_REQUEST_CONFIG.timeoutMs,
  signal,
  onListening,
  onDiagnostic
}) {
  const acceptedKinds = kinds ? new Set(kinds) : null;
  const reportDiagnostic = detail => {
    try { onDiagnostic?.(detail); } catch {}
  };
  let context;
  let stream;
  try {
    ({ context, stream } = await (privateInput ? openAcousticInput() : acquireAcousticInput()));
  } catch {
    return { status: 'unavailable' };
  }

  if (signal?.aborted) {
    releaseAcousticInput(context, stream);
    return { status: 'aborted' };
  }

  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  return new Promise(resolve => {
    let interval = 0;
    let timeout = 0;
    let settled = false;
    let activeBank = null;
    let silencePolls = 0;
    let packetRejectedReported = false;
    let diagnosticPolls = 0;
    const votes = new Uint8Array(16);
    const symbols = [];

    function cleanup() {
      clearInterval(interval);
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      try { source.disconnect(); } catch {}
      if (privateInput || !keepInput) releaseAcousticInput(context, stream);
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

    function acceptSymbol(symbol) {
      symbols.push(symbol);
      reportDiagnostic({ type: 'symbol', symbol, count: symbols.length });
      if (symbols.length > 180) symbols.splice(0, symbols.length - 180);
      if (symbols.length >= REQUEST_PREAMBLE.length && REQUEST_PREAMBLE.every(
        (expected, index) => symbols[symbols.length - REQUEST_PREAMBLE.length + index] === expected
      )) {
        packetRejectedReported = false;
        reportDiagnostic({ type: 'preamble' });
      }
      const request = symbolsToRequest(symbols, () => {
        if (packetRejectedReported) return;
        packetRejectedReported = true;
        reportDiagnostic({ type: 'rejected' });
      });
      if (!request) return;
      const sessionMatches = request.session === (session >>> 0);
      const kindMatches = !acceptedKinds || acceptedKinds.has(request.kind);
      reportDiagnostic({ type: 'packet', request, sessionMatches, kindMatches });
      if (sessionMatches && kindMatches) finish({ status: 'received', request });
    }

    function flushBank() {
      if (activeBank === null) return;
      const start = activeBank ? 8 : 0;
      let symbol = start;
      for (let candidate = start + 1; candidate < start + 8; candidate++)
        if (votes[candidate] > votes[symbol]) symbol = candidate;
      const count = votes[symbol];
      votes.fill(0);
      activeBank = null;
      if (count) acceptSymbol(symbol);
    }

    function poll() {
      analyser.getFloatTimeDomainData(samples);
      if (onDiagnostic && ++diagnosticPolls % 5 === 0) {
        let sumSquares = 0;
        for (const sample of samples) sumSquares += sample * sample;
        const rms = Math.sqrt(sumSquares / samples.length);
        reportDiagnostic({
          type: 'level',
          rms,
          db: 20 * Math.log10(Math.max(rms, 0.000001))
        });
      }
      const symbol = detectDtmfSymbol(samples, context.sampleRate);
      if (symbol === null) {
        silencePolls++;
        if (silencePolls >= 3) flushBank();
        return;
      }
      silencePolls = 0;
      const bank = symbol >= 8 ? 1 : 0;
      if (activeBank === null) activeBank = bank;
      else if (bank !== activeBank) {
        flushBank();
        activeBank = bank;
      }
      if (votes[symbol] < 255) votes[symbol]++;
    }

    signal?.addEventListener('abort', abort, { once: true });
    onListening?.();
    interval = setInterval(poll, ACOUSTIC_REQUEST_CONFIG.pollMs);
    if (timeoutMs > 0) timeout = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
  });
}
