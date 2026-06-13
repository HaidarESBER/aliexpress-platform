// ----------------------------------------------------------------------------
// Image reskinning — local, free, no API key.
//
// Removes each product photo's background with RMBG-1.4 (runs in Node via
// @huggingface/transformers, quantized) and composites the cut-out product
// onto a consistent Nuage backdrop (warm radial gradient + faint gold glow +
// soft drop shadow). Output is a uniform, on-brand catalog image.
// ----------------------------------------------------------------------------
import { AutoModel, AutoProcessor, RawImage } from "@huggingface/transformers";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFavorite, setReskinned } from "./favorites.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "data", "reskinned");

let _model, _processor;
async function ensureModel() {
  if (_model) return;
  _model = await AutoModel.from_pretrained("briaai/RMBG-1.4", {
    config: { model_type: "custom" },
    dtype: "fp32", // full precision — q8 under-segments product shots
  });
  _processor = await AutoProcessor.from_pretrained("briaai/RMBG-1.4", {
    config: {
      do_normalize: true, do_pad: false, do_rescale: true, do_resize: true,
      image_mean: [0.5, 0.5, 0.5], feature_extractor_type: "ImageFeatureExtractor",
      image_std: [1, 1, 1], resample: 2, rescale_factor: 1 / 255,
      size: { width: 1024, height: 1024 },
    },
  });
}

/** Load an image robustly: local path as-is, or download URL with retries
 *  (alicdn intermittently times out, which would otherwise abort a batch). */
async function loadImage(src) {
  if (!/^https?:/i.test(src)) return RawImage.read(src);
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await RawImage.fromBlob(new Blob([Buffer.from(await res.arrayBuffer())]));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** RMBG → transparent-background PNG of the product, at original resolution. */
async function cutoutPng(url) {
  await ensureModel();
  const image = await loadImage(url);
  const { pixel_values } = await _processor(image);
  const { output } = await _model({ input: pixel_values });
  const mask = await RawImage.fromTensor(output[0].mul(255).to("uint8")).resize(image.width, image.height);
  const { width, height, channels } = image;
  // Clean the alpha: median() kills isolated speckles the model leaves on busy
  // backgrounds; linear() boosts contrast so faint halos drop to fully transparent.
  const cleanMask = await sharp(Buffer.from(mask.data), { raw: { width, height, channels: 1 } })
    .median(3)
    .linear(1.3, -40)
    .toColourspace("b-w") // keep it single-channel; sharp otherwise promotes to 3
    .raw()
    .toBuffer();
  const rgb = await sharp(Buffer.from(image.data), { raw: { width, height, channels } }).removeAlpha().raw().toBuffer();
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .joinChannel(cleanMask, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
}

/** The reusable Nuage backdrop: dark warm taupe with a soft gold center glow. */
function backdrop(size) {
  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="bg" cx="50%" cy="42%" r="78%">
        <stop offset="0%" stop-color="#3a2f22"/>
        <stop offset="55%" stop-color="#241d15"/>
        <stop offset="100%" stop-color="#15110c"/>
      </radialGradient>
      <radialGradient id="glow" cx="50%" cy="40%" r="38%">
        <stop offset="0%" stop-color="#d4af37" stop-opacity="0.14"/>
        <stop offset="100%" stop-color="#d4af37" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#bg)"/>
    <rect width="100%" height="100%" fill="url(#glow)"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Cut out one image and place it, with a soft shadow, on the Nuage backdrop. */
export async function reskinImage(url, size = 1200) {
  const cut = await cutoutPng(url);
  const trimmed = await sharp(cut).trim().toBuffer(); // drop transparent margins
  const target = Math.round(size * 0.72);
  const product = await sharp(trimmed).resize(target, target, { fit: "inside" }).png().toBuffer();
  const pm = await sharp(product).metadata();

  const left = Math.round((size - pm.width) / 2);
  const top = Math.round((size - pm.height) / 2) - Math.round(size * 0.02);

  // Soft drop shadow from the product's alpha.
  const alpha = await sharp(product).extractChannel(3).raw().toBuffer();
  const shadowAlpha = await sharp(alpha, { raw: { width: pm.width, height: pm.height, channels: 1 } })
    .blur(18).linear(0.5, 0).raw().toBuffer();
  const shadow = await sharp({ create: { width: pm.width, height: pm.height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .joinChannel(shadowAlpha, { raw: { width: pm.width, height: pm.height, channels: 1 } })
    .png().toBuffer();

  const base = await backdrop(size);
  return sharp(base)
    .composite([
      { input: shadow, left: left + 12, top: top + 34 },
      { input: product, left, top },
    ])
    .png()
    .toBuffer();
}

/**
 * Reskin every image of a favorited product. Writes data/reskinned/<id>/N.png
 * and records public URLs (/reskinned/<id>/N.png) on the favorite.
 */
export async function reskinProduct(id, { onProgress } = {}) {
  const fav = getFavorite(id);
  if (!fav) throw new Error(`Favorite ${id} not found`);
  const images = fav.images?.original || fav.product?.images || [];
  const dir = path.join(OUT_DIR, String(id));
  fs.mkdirSync(dir, { recursive: true });

  const urls = [];
  for (let i = 0; i < images.length; i++) {
    try {
      const buf = await reskinImage(images[i]);
      const file = path.join(dir, `${i}.png`);
      fs.writeFileSync(file, buf);
      urls.push(`/reskinned/${id}/${i}.png`);
      onProgress?.(i + 1, images.length);
    } catch (e) {
      onProgress?.(i + 1, images.length, e.message);
    }
  }
  setReskinned(id, urls);
  return urls;
}
