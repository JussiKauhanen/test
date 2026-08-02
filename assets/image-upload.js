/*
 * NearChat image controls.
 * Change these values to trade image detail for smaller sync payloads.
 */
export const IMAGE_UPLOAD_CONFIG = Object.freeze({
  maxWidth: 320,
  maxHeight: 480,
  preferredQuality: 0.72,
  minimumQuality: 0.52,
  maxOutputBytes: 90 * 1024,
  maxInputBytes: 30 * 1024 * 1024,
  maxStoredBytes: 140 * 1024,
  outputTypes: ['image/avif', 'image/webp', 'image/jpeg', 'image/png']
});

const SAFE_DATA_URL = /^data:(image\/(?:avif|webp|jpeg|png));base64,([a-z0-9+/=]+)$/i;

function canvasToBlob(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('The compressed image could not be read.'));
    reader.readAsDataURL(blob);
  });
}

function loadWithImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url)
    });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This image format cannot be opened on this device.'));
    };
    image.src = url;
  });
}

async function decodeImage(file) {
  if ('createImageBitmap' in window) {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close()
      };
    } catch {}
  }
  return loadWithImageElement(file);
}

function targetSize(width, height, scale = 1) {
  const fit = Math.min(
    1,
    IMAGE_UPLOAD_CONFIG.maxWidth / width,
    IMAGE_UPLOAD_CONFIG.maxHeight / height
  ) * scale;
  return {
    width: Math.max(1, Math.round(width * fit)),
    height: Math.max(1, Math.round(height * fit))
  };
}

function drawImage(source, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('Image resizing is not supported on this device.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, size.width, size.height);
  const pixels = context.getImageData(0, 0, size.width, size.height).data;
  let hasTransparency = false;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] < 255) {
      hasTransparency = true;
      break;
    }
  }
  return { canvas, hasTransparency };
}

async function smallestSupportedEncoding(canvas, quality, hasTransparency) {
  const types = hasTransparency
    ? IMAGE_UPLOAD_CONFIG.outputTypes.filter(type => type !== 'image/jpeg')
    : IMAGE_UPLOAD_CONFIG.outputTypes;
  const candidates = await Promise.all(types.map(async type => {
    try {
      const blob = await canvasToBlob(canvas, type, quality);
      if (!blob || blob.type !== type) return null;
      return blob;
    } catch {
      return null;
    }
  }));
  return candidates.filter(Boolean).sort((a, b) => a.size - b.size)[0] ?? null;
}

export async function compressImage(file) {
  if (!(file instanceof File) || !file.type.startsWith('image/'))
    throw new Error('Choose an image file.');
  if (file.size > IMAGE_UPLOAD_CONFIG.maxInputBytes)
    throw new Error('That image is too large to open. Choose one under 30 MB.');

  const decoded = await decodeImage(file);
  try {
    if (!decoded.width || !decoded.height)
      throw new Error('This image has no visible dimensions.');

    let scale = 1;
    let quality = IMAGE_UPLOAD_CONFIG.preferredQuality;
    let size;
    let blob;

    for (let attempt = 0; attempt < 5; attempt++) {
      size = targetSize(decoded.width, decoded.height, scale);
      const { canvas, hasTransparency } = drawImage(decoded.source, size);
      blob = await smallestSupportedEncoding(canvas, quality, hasTransparency);
      canvas.width = canvas.height = 1;
      if (!blob) throw new Error('This browser could not compress the image.');
      if (blob.size <= IMAGE_UPLOAD_CONFIG.maxOutputBytes) break;
      if (quality > IMAGE_UPLOAD_CONFIG.minimumQuality) {
        quality = Math.max(IMAGE_UPLOAD_CONFIG.minimumQuality, quality - 0.1);
      } else {
        const reduction = Math.sqrt(IMAGE_UPLOAD_CONFIG.maxOutputBytes / blob.size) * 0.92;
        scale *= Math.min(0.86, Math.max(0.55, reduction));
      }
    }

    if (!blob || !size || blob.size > IMAGE_UPLOAD_CONFIG.maxStoredBytes)
      throw new Error('The image could not be made small enough to sync.');

    return {
      dataUrl: await blobToDataUrl(blob),
      mime: blob.type,
      width: size.width,
      height: size.height,
      bytes: blob.size,
      name: file.name.slice(0, 80)
    };
  } finally {
    decoded.close();
  }
}

export function normalizeStoredImage(value) {
  if (!value || typeof value !== 'object' || typeof value.dataUrl !== 'string') return null;
  const match = SAFE_DATA_URL.exec(value.dataUrl);
  if (!match) return null;
  const width = Number(value.width);
  const height = Number(value.height);
  const estimatedBytes = Math.floor(match[2].length * 3 / 4);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 ||
      width > IMAGE_UPLOAD_CONFIG.maxWidth || height > IMAGE_UPLOAD_CONFIG.maxHeight ||
      estimatedBytes > IMAGE_UPLOAD_CONFIG.maxStoredBytes) return null;
  return {
    dataUrl: value.dataUrl,
    mime: match[1].toLowerCase(),
    width: Math.round(width),
    height: Math.round(height),
    bytes: estimatedBytes,
    name: typeof value.name === 'string' ? value.name.slice(0, 80) : 'image'
  };
}

export function bindImageFileInput(input, handlers = {}) {
  let generation = 0;

  async function onChange() {
    const file = input.files?.[0];
    if (!file) return;
    const current = ++generation;
    handlers.onBusy?.(true);
    try {
      const image = await compressImage(file);
      if (current === generation) handlers.onReady?.(image);
    } catch (error) {
      if (current === generation) {
        input.value = '';
        handlers.onError?.(error);
      }
    } finally {
      if (current === generation) handlers.onBusy?.(false);
    }
  }

  input.addEventListener('change', onChange);
  return {
    clear() {
      generation++;
      input.value = '';
      handlers.onBusy?.(false);
    }
  };
}

export function imageFormatLabel(mime) {
  return ({
    'image/avif': 'AVIF',
    'image/webp': 'WebP',
    'image/jpeg': 'JPEG',
    'image/png': 'PNG'
  })[mime] ?? 'image';
}
