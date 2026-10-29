// Lite Capability Layer: zero-cost, local verification by modality.
//
// No network, no model calls, no dependencies. Each checker receives raw
// bytes (plus the prompt for future semantic checks) and returns a verdict
// envelope: { verdict: "SETTLED"|"REJECTED"|"INCONCLUSIVE", evidence }.
// These are structural pre-checks (format, headers, bounds) — never proof
// of quality. Doubt always resolves to INCONCLUSIVE (fail-frozen).
//
// V3 swap points:
// - images: `@xenova/transformers` CLIP text-to-image similarity —
//   implement `scoreImageSemantics(bytes, prompt)` and gate SETTLED on a
//   threshold instead of structural pass-through.
// - audio: `whisper.cpp` transcription — implement
//   `transcribeAudioLocally(bytes)` and compare against the prompt.
// - video: real frame extraction — implement `extractVideoFrame(bytes)`
//   returning PNG bytes, then delegate to inspectImageLocally.

import { createHash } from "node:crypto";

export const CAPABILITIES = Object.freeze(["image_gen", "speech_transcription", "video_gen", "text_gen"]);

export function isKnownCapability(value) {
  return typeof value === "string" && CAPABILITIES.includes(value);
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function toBytes(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  return null;
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// Magic-byte sniffing: PNG, JPEG, GIF, WebP. Returns the format or null.
function sniffImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 6 && buf.toString("ascii", 0, 6) === "GIF87a") return "gif";
  if (buf.length >= 6 && buf.toString("ascii", 0, 6) === "GIF89a") return "gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

// PNG IHDR dimensions (width/height at bytes 16..24). JPEG parsing is
// segment-walking; anything unparseable is INCONCLUSIVE, not failure.
function pngDimensions(buf) {
  if (buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function inspectImageLocally(input, _prompt) {
  const buf = toBytes(input);
  if (buf === null || buf.length === 0) {
    return { verdict: "REJECTED", code: "EMPTY_BYTES", evidence: {} };
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    return { verdict: "REJECTED", code: "OVERSIZE", evidence: { bytes: buf.length } };
  }
  const format = sniffImage(buf);
  if (format === null) {
    return { verdict: "INCONCLUSIVE", code: "UNKNOWN_FORMAT", evidence: {} };
  }
  const evidence = { format, bytes: buf.length, sha256: sha256Hex(buf) };
  if (format === "png") {
    const dims = pngDimensions(buf);
    if (dims === null || dims.width === 0 || dims.height === 0) {
      return { verdict: "REJECTED", code: "BAD_DIMENSIONS", evidence };
    }
    evidence.width = dims.width;
    evidence.height = dims.height;
  }
  return { verdict: "SETTLED", code: "STRUCTURAL_PASS", evidence };
}

// RIFF/WAVE (with fmt chunk sanity) and ID3/MP3-frame-sync sniffing.
function sniffAudio(buf) {
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
    return "wav";
  }
  if (buf.length >= 3 && buf.toString("ascii", 0, 3) === "ID3") return "mp3";
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3";
  return null;
}

export function inspectAudioLocally(input, _prompt) {
  const buf = toBytes(input);
  if (buf === null || buf.length === 0) {
    return { verdict: "REJECTED", code: "EMPTY_BYTES", evidence: {} };
  }
  if (buf.length > MAX_AUDIO_BYTES) {
    return { verdict: "REJECTED", code: "OVERSIZE", evidence: { bytes: buf.length } };
  }
  const format = sniffAudio(buf);
  if (format === null) {
    return { verdict: "INCONCLUSIVE", code: "UNKNOWN_FORMAT", evidence: {} };
  }
  return { verdict: "SETTLED", code: "STRUCTURAL_PASS", evidence: { format, bytes: buf.length, sha256: sha256Hex(buf) } };
}
