/*
 * NearChat control channel — v4, "just beeps".
 *
 * The modem is gone. This is the detector from the beep test page that
 * actually worked on your phones, unchanged in every parameter that matters:
 * one 1800 Hz tone, 150 ms on / 130 ms off, and a noise-floor-relative
 * detector that scores the 1800 Hz bin against the median of its neighbours.
 *
 * Meaning is carried by HOW MANY beeps are in a burst, not by their content:
 *
 *   3 beeps            send everything          (FULL)
 *   2 beeps + N beeps  send only part N-2       (INDEXES, one part, 0..5)
 *   1 beep             stop / finished          (NONE when the sender is
 *                                                waiting for a request,
 *                                                DONE when it is waiting
 *                                                for the finish signal)
 *
 * The second burst after "2 beeps" is what says WHICH part — a bare 2-beep
 * signal cannot, since there is no payload any more. If that second burst is
 * missed, the request degrades to FULL rather than failing.
 *
 * Whole message is repeated 3 times. Worst case airtime ~9 s, typical ~4 s.
 *
 * What is deliberately given up versus v2/v3:
 *   - No session id on the wire. The listener stamps the request with the
 *     session it was already waiting for, so two pairs of phones syncing in
 *     the same room can confuse each other. Acceptable for now.
 *   - No CRC. Instead, burst counts are matched strictly and the only
 *     dangerous decode (1 beep = "send nothing") has to be heard twice.
 *     Everything else fails towards FULL.
 *   - Only one missing part can be requested. Two or more -> FULL.
 *
 * mountAcousticMeter(element) puts a live tone meter on the listening device
 * so you can see whether the mic hears anything at all.
 */

export const ACOUSTIC_REQUEST_CONFIG = Object.freeze({
  // --- tone (identical to the working beep page) --------------------------
  frequency: 1800,
  beepMs: 150,
  beepGapMs: 130,
  gain: 0.6,

  // --- message shape ------------------------------------------------------
  burstGapMs: 700,        // silence between the two bursts of a message
  messageGapMs: 2200,     // silence between repeats (must exceed linkGapMs)
  repeatCount: 3,         // repeats of a one-burst message (two-burst: 2)
  maxPartIndex: 5,        // highest part number a 2-beep request can name

  // --- detector (identical to the working beep page) ----------------------
  thresholdDb: 16,        // tone must beat the local noise floor by this much
  absoluteFloorDb: -85,   // ignore anything quieter than this
  minOnFrames: 2,         // frames a tone must persist to count as an onset
  pollMs: 20,
  fftSize: 4096,
  guardBins: 4,           // bins around the tone excluded from the floor
  floorBins: 60,          // width of the local floor band

  // --- grouping -----------------------------------------------------------
  onsetGapMs: 500,        // silence after a beep that closes a burst
  linkGapMs: 1600,        // silence after a burst that closes a message
  confirmWindowMs: 9000,  // window in which a repeated message is believed
  timeoutMs: 20_000
});

export const ACOUSTIC_REQUEST_FULL = 1;
export const ACOUSTIC_REQUEST_INDEXES = 2;
export const ACOUSTIC_REQUEST_MASK = 3;
export const ACOUSTIC_REQUEST_NONE = 4;
export const ACOUSTIC_REQUEST_DONE = 5;

const BEEPS_STOP = 1;
const BEEPS_ONE_PART = 2;
const BEEPS_FULL = 3;

let logger = null;
/** Optional diagnostics sink, e.g. setAcousticLogger(m => addSyncHistory('send', m)) */
export function setAcousticLogger(fn) { logger = typeof fn === 'function' ? fn : null; }
function log(message) { try { logger?.(message); } catch {} }

/* ------------------------------------------------------------------ *
 * request selection                                                   *
 * ------------------------------------------------------------------ */

/** Kept for API compatibility; the beep channel has no packet format. */
export function buildAcousticRequestPacket(session, kind = ACOUSTIC_REQUEST_FULL, payload = new Uint8Array()) {
  return { session: session >>> 0, kind, payload: payload instanceof Uint8Array ? payload : new Uint8Array(payload) };
}
export function parseAcousticRequestPacket(value) {
  return value && typeof value === 'object' && 'kind' in value ? value : null;
}

export function chooseAcousticRequest(missingIndexes, totalPackages) {
  const indexes = [...new Set(missingIndexes)]
    .filter(index => Number.isInteger(index) && index >= 0 && index < totalPackages)
    .sort((a, b) => a - b);
  if (!indexes.length) return { kind: ACOUSTIC_REQUEST_NONE, payload: new Uint8Array() };
  if (indexes.length === 1 && indexes[0] <= ACOUSTIC_REQUEST_CONFIG.maxPartIndex)
    return { kind: ACOUSTIC_REQUEST_INDEXES, payload: new Uint8Array([indexes[0]]) };
  return { kind: ACOUSTIC_REQUEST_FULL, payload: new Uint8Array() };
}

export function requestedPackageIndexes(message, totalPackages) {
  if (!message || !Number.isInteger(totalPackages) || totalPackages < 0) return undefined;
  if (message.kind === ACOUSTIC_REQUEST_FULL) return null;
  if (message.kind === ACOUSTIC_REQUEST_NONE) return [];
  if (message.kind === ACOUSTIC_REQUEST_INDEXES || message.kind === ACOUSTIC_REQUEST_MASK) {
    const index = message.payload?.[0];
    return Number.isInteger(index) && index < totalPackages ? [index] : null;
  }
  return undefined;
}

/* The index burst counts index + 2, never 1. A lone index burst can therefore
 * never be mistaken for the 1-beep stop signal — the worst it can decode as is
 * FULL, which is the safe direction to fail in. */
const INDEX_BURST_OFFSET = 2;

/** kind + payload -> the burst counts to play. */
function messageBursts(kind, payload) {
  if (kind === ACOUSTIC_REQUEST_NONE || kind === ACOUSTIC_REQUEST_DONE) return [BEEPS_STOP];
  if (kind === ACOUSTIC_REQUEST_INDEXES || kind === ACOUSTIC_REQUEST_MASK) {
    const index = payload?.[0];
    if (Number.isInteger(index) && index >= 0 && index <= ACOUSTIC_REQUEST_CONFIG.maxPartIndex)
      return [BEEPS_ONE_PART, index + INDEX_BURST_OFFSET];
  }
  return [BEEPS_FULL];
}

/**
 * burst counts -> a request object, or null if the pattern is not understood.
 * Burst counts are matched strictly: a stop or a full request is exactly one
 * burst, a part request exactly two. A message with a dropped beep therefore
 * decodes as nothing rather than as something else — in particular a mangled
 * 3-beep FULL can never turn into a 1-beep "nothing needed".
 */
function burstsToRequest(counts, acceptedKinds) {
  const wantsDone = !acceptedKinds || acceptedKinds.has(ACOUSTIC_REQUEST_DONE);
  const wantsRequest = !acceptedKinds || acceptedKinds.has(ACOUSTIC_REQUEST_FULL);

  if (counts.length === 1 && counts[0] === BEEPS_STOP) {
    // One beep means "stop". Which flavour of stop depends on what the
    // caller is listening for; DONE wins when both are acceptable.
    const kind = wantsDone && !wantsRequest ? ACOUSTIC_REQUEST_DONE
      : wantsDone && acceptedKinds?.size === 1 ? ACOUSTIC_REQUEST_DONE
      : wantsRequest ? ACOUSTIC_REQUEST_NONE
      : ACOUSTIC_REQUEST_DONE;
    return { kind, payload: new Uint8Array() };
  }
  if (counts.length === 1 && counts[0] === BEEPS_FULL)
    return { kind: ACOUSTIC_REQUEST_FULL, payload: new Uint8Array() };
  if (counts.length === 2 && counts[0] === BEEPS_ONE_PART) {
    const index = counts[1] - INDEX_BURST_OFFSET;
    if (index < 0 || index > ACOUSTIC_REQUEST_CONFIG.maxPartIndex)
      return { kind: ACOUSTIC_REQUEST_FULL, payload: new Uint8Array() };
    return { kind: ACOUSTIC_REQUEST_INDEXES, payload: new Uint8Array([index]) };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * output                                                              *
 * ------------------------------------------------------------------ */

function audioContextConstructor() {
  return window.AudioContext || window.webkitAudioContext;
}

/* Once getUserMedia has run, iOS keeps the page in play-and-record and sends
 * output to the earpiece. Hand the session back before transmitting. */
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

function scheduleBeep(context, start) {
  const { frequency, beepMs, gain: level } = ACOUSTIC_REQUEST_CONFIG;
  const end = start + beepMs / 1000;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(level, start + 0.01);
  gain.gain.setValueAtTime(level, end - 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  oscillator.connect(gain).connect(context.destination);
  activeOscillators.add(oscillator);
  oscillator.addEventListener('ended', () => activeOscillators.delete(oscillator), { once: true });
  oscillator.start(start);
  oscillator.stop(end + 0.02);
  return end;
}

export async function playAcousticRequest(
  session,
  kind = ACOUSTIC_REQUEST_FULL,
  payload = new Uint8Array()
) {
  // Nothing is listening here: release the mic so iOS uses the loudspeaker.
  if (!activeListeners && inputStream) await stopAcousticInput();
  setAudioSession(activeListeners ? 'play-and-record' : 'playback');

  const context = await prepareAcousticOutput();
  const { beepGapMs, burstGapMs, messageGapMs, repeatCount } = ACOUSTIC_REQUEST_CONFIG;
  const bursts = messageBursts(kind, payload);
  const repeats = bursts.length > 1 ? 2 : repeatCount;   // keep airtime under the timeout
  let cursor = context.currentTime + 0.08;

  for (let repeat = 0; repeat < repeats; repeat++) {
    bursts.forEach((count, burstIndex) => {
      for (let beep = 0; beep < count; beep++) {
        cursor = scheduleBeep(context, cursor) + beepGapMs / 1000;
      }
      if (burstIndex < bursts.length - 1) cursor += (burstGapMs - beepGapMs) / 1000;
    });
    cursor += (messageGapMs - beepGapMs) / 1000;
  }

  const waitMs = Math.max(0, (cursor - context.currentTime) * 1000);
  log(`tx ${bursts.join('+')} beeps x${repeats} (${(waitMs / 1000).toFixed(1)}s)`);
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
 * live tone meter                                                     *
 * ------------------------------------------------------------------ */

const meters = new Set();

/**
 * Drop a live tone meter into the page. It shows, continuously:
 *   - the 1800 Hz level above the local noise floor, in dB, as a number,
 *     a bar and a scrolling trace
 *   - the detection threshold as a dashed line
 *   - onsets counted and the last bursts heard
 * If the bar never moves while the other phone beeps, the problem is volume,
 * distance, or mic permission — not the decoder.
 */
export function mountAcousticMeter(target) {
  const parent = typeof target === 'string' ? document.querySelector(target) : target;
  if (!parent) return null;

  const root = document.createElement('div');
  root.className = 'acoustic-meter';
  root.style.cssText =
    'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;display:flex;' +
    'flex-direction:column;gap:6px;margin:8px 0';
  root.innerHTML =
    '<canvas style="width:100%;height:70px;background:#8881;border-radius:8px;display:block"></canvas>' +
    '<div class="acoustic-meter-text" style="opacity:.75">mic idle</div>';
  parent.appendChild(root);

  const canvas = root.querySelector('canvas');
  const text = root.querySelector('.acoustic-meter-text');
  const context = canvas.getContext('2d');
  const history = [];
  const meter = { root, canvas, context, text, history, state: null };

  function size() {
    const ratio = devicePixelRatio || 1;
    canvas.width = Math.max(1, canvas.clientWidth * ratio);
    canvas.height = Math.max(1, canvas.clientHeight * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  size();
  meter.resize = size;
  addEventListener('resize', size);
  meters.add(meter);

  meter.destroy = () => {
    removeEventListener('resize', size);
    meters.delete(meter);
    root.remove();
  };
  return meter;
}

function paintMeter(meter, state) {
  const { canvas, context, history } = meter;
  const width = canvas.clientWidth, height = canvas.clientHeight, MAX = 45;
  if (!width || !height) return;
  const slots = Math.max(1, Math.floor(width / 2));
  history.push(state);
  while (history.length > slots) history.shift();

  const y = value => height - Math.max(0, Math.min(MAX, value)) / MAX * (height - 4) - 2;
  context.clearRect(0, 0, width, height);

  context.strokeStyle = '#e6394688';
  context.lineWidth = 1;
  context.setLineDash([4, 4]);
  context.beginPath();
  context.moveTo(0, y(ACOUSTIC_REQUEST_CONFIG.thresholdDb));
  context.lineTo(width, y(ACOUSTIC_REQUEST_CONFIG.thresholdDb));
  context.stroke();
  context.setLineDash([]);

  context.fillStyle = '#2e7d3233';
  history.forEach((point, index) => { if (point.on) context.fillRect(index * 2, 0, 2, height); });

  context.strokeStyle = '#2e7d32';
  context.lineWidth = 1.5;
  context.beginPath();
  history.forEach((point, index) =>
    index ? context.lineTo(index * 2, y(point.score)) : context.moveTo(0, y(point.score)));
  context.stroke();

  meter.text.textContent =
    `${ACOUSTIC_REQUEST_CONFIG.frequency}Hz ${state.score.toFixed(0)}dB over floor ` +
    `(need ${ACOUSTIC_REQUEST_CONFIG.thresholdDb}) · peak ${state.peak.toFixed(0)}dBFS · ` +
    `beeps ${state.onsets}` + (state.bursts.length ? ` · heard ${state.bursts.join('+')}` : '');
}

function updateMeters(state) {
  for (const meter of meters) paintMeter(meter, state);
}

function idleMeters() {
  for (const meter of meters) {
    meter.history.length = 0;
    meter.text.textContent = 'mic idle';
    const { canvas, context } = meter;
    context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  }
}

/* ------------------------------------------------------------------ *
 * input                                                               *
 * ------------------------------------------------------------------ */

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
  if (!activeListeners) { setAudioSession('playback'); idleMeters(); }
}

function releaseAcousticInput(context, stream) {
  if (inputContext === context) inputContext = null;
  if (inputStream === stream) inputStream = null;
  stopTracks(stream);
  context.close().catch(() => {});
  if (!activeListeners) { setAudioSession('playback'); idleMeters(); }
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

  const C = ACOUSTIC_REQUEST_CONFIG;
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = C.fftSize;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);

  const bins = new Float32Array(analyser.frequencyBinCount);
  const binHz = context.sampleRate / analyser.fftSize;
  const target = Math.round(C.frequency / binHz);
  const neighbourhood = [];

  return new Promise(resolve => {
    let interval = 0;
    let timeout = 0;
    let settled = false;
    let onFrames = 0;
    let beepCount = 0;          // beeps in the burst being heard
    let lastOnset = 0;
    let bursts = [];            // closed bursts of the message being heard
    let heard = [];             // for the meter
    let pendingKey = '';        // pattern awaiting corroborating repeats
    let pendingAt = 0;
    let pendingHits = 0;
    let longBurstAt = 0;        // last time a burst of 2+ beeps was heard

    function cleanup() {
      clearInterval(interval);
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      try { source.disconnect(); } catch {}
      activeListeners = Math.max(0, activeListeners - 1);
      if (!keepInput) releaseAcousticInput(context, stream);
      else if (!activeListeners) idleMeters();
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    function abort() { finish({ status: 'aborted' }); }

    function tryDecode() {
      const request = burstsToRequest(bursts, acceptedKinds);
      if (!request) return false;
      if (acceptedKinds && !acceptedKinds.has(request.kind)) {
        log(`rx ${bursts.join('+')} beeps -> kind ${request.kind}, not accepted here`);
        bursts = [];
        return false;
      }
      /* FULL is the safe answer, so it is believed the first time. The two
       * decodes that can lose or misdirect data — "send nothing" and "send
       * this one part" — have to be heard identically twice. When they are
       * not, nothing is returned, the sender times out, and it sends
       * everything. Wrong-but-safe beats wrong-and-quiet. */
      if (request.kind !== ACOUSTIC_REQUEST_FULL) {
        const now = performance.now();
        // A real stop transmission only ever produces bursts of one beep. If
        // anything longer was heard recently, this lone beep is much more
        // likely to be a FULL or part request with beeps missing.
        if (bursts.length === 1 && bursts[0] === BEEPS_STOP &&
            longBurstAt && now - longBurstAt < C.confirmWindowMs) {
          log('rx 1 beep ignored: longer bursts heard recently');
          bursts = [];
          return false;
        }
        /* "Send nothing" is the only decode that can be manufactured by
         * dropping beeps out of a 3-beep FULL, so it needs all three repeats
         * to agree. A part request only needs two. */
        const needed = bursts.length === 1 && bursts[0] === BEEPS_STOP ? 3 : 2;
        const key = bursts.join('+');
        if (pendingKey !== key || now - pendingAt > C.confirmWindowMs) {
          pendingKey = key;
          pendingHits = 1;
        } else {
          pendingHits++;
        }
        pendingAt = now;
        if (pendingHits < needed) {
          log(`rx ${key} beeps (${pendingHits}/${needed}), waiting for a repeat`);
          bursts = [];
          return false;
        }
      }
      log(`rx ${bursts.join('+')} beeps -> kind ${request.kind}` +
          (request.payload.length ? ` part ${request.payload[0]}` : ''));
      // No session travels over the beep channel: stamp the one we awaited.
      finish({ status: 'received', request: { ...request, session: session >>> 0 } });
      return true;
    }

    function closeBurst() {
      if (!beepCount) return;
      if (beepCount > 1) longBurstAt = performance.now();
      bursts.push(beepCount);
      heard = [...bursts];
      log(`rx burst of ${beepCount}`);
      beepCount = 0;
    }

    /* A message ends after linkGapMs of silence. Waiting for the whole
     * message instead of decoding each burst is what keeps the two-burst
     * "one part" request from being read as two separate messages. */
    function closeMessage() {
      if (!bursts.length) return;
      if (!tryDecode()) log(`rx ${bursts.join('+')} beeps not understood`);
      bursts = [];
    }

    function poll() {
      if (settled) return;
      analyser.getFloatFrequencyData(bins);

      let peak = -Infinity;
      for (let index = target - 1; index <= target + 1; index++)
        if (bins[index] > peak) peak = bins[index];

      neighbourhood.length = 0;
      const low = Math.max(0, target - C.floorBins);
      const high = Math.min(bins.length - 1, target + C.floorBins);
      for (let index = low; index <= high; index++)
        if (Math.abs(index - target) > C.guardBins && isFinite(bins[index]))
          neighbourhood.push(bins[index]);
      neighbourhood.sort((a, b) => a - b);
      const floor = neighbourhood.length ? neighbourhood[neighbourhood.length >> 1] : -120;

      const score = isFinite(peak) ? peak - floor : 0;
      const on = score > C.thresholdDb && peak > C.absoluteFloorDb;
      const now = performance.now();

      if (on) {
        onFrames++;
        if (onFrames === C.minOnFrames) {           // debounced rising edge
          beepCount++;
          lastOnset = now;
        }
      } else {
        onFrames = 0;
        if (beepCount && now - lastOnset > C.onsetGapMs) closeBurst();
        if (bursts.length && now - lastOnset > C.linkGapMs) closeMessage();
      }

      const state = { score, peak, floor, on, onsets: beepCount, bursts: heard };
      updateMeters(state);
      onSignal?.(state);
    }

    signal?.addEventListener('abort', abort, { once: true });
    onListening?.();
    log(`rx listening for ${C.frequency} Hz @${Math.round(context.sampleRate)} Hz, bin ${target}`);
    interval = setInterval(poll, C.pollMs);
    if (timeoutMs > 0) timeout = setTimeout(() => {
      log('rx timeout');
      finish({ status: 'timeout' });
    }, timeoutMs);
  });
}
