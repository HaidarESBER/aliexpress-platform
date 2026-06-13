// ----------------------------------------------------------------------------
// Favorites store — the sourcing shortlist.
//
// Each favorite keeps the full fetched product plus slots that later stages
// fill in:
//   - adapted : Nuage-themed copy (written by Claude in the CLI)
//   - images  : { original[], reskinned[] } (reskinned by the image step)
//   - status  : raw | adapted | reskinned | ready
// Persisted to favorites.json (gitignored).
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "favorites.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { items: [] };
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function stamp(item) {
  if (item.adapted && item.images?.reskinned?.length) item.status = "ready";
  else if (item.images?.reskinned?.length) item.status = "reskinned";
  else if (item.adapted) item.status = "adapted";
  else item.status = "raw";
  return item;
}

export function listFavorites() {
  return load().items.map(stamp);
}

export function getFavorite(id) {
  const item = load().items.find((i) => i.id === String(id));
  return item ? stamp(item) : null;
}

export function isFavorite(id) {
  return load().items.some((i) => i.id === String(id));
}

/** Add a product (the normalized object from getProduct) to the shortlist. */
export function addFavorite(product, isoDate) {
  const data = load();
  if (!data.items.find((i) => i.id === product.id)) {
    data.items.push({
      id: product.id,
      savedAt: isoDate || null,
      product,
      adapted: null,
      images: { original: product.images || [], reskinned: [] },
      status: "raw",
    });
    save(data);
  }
  return listFavorites();
}

export function removeFavorite(id) {
  const data = load();
  data.items = data.items.filter((i) => i.id !== String(id));
  save(data);
  return listFavorites();
}

/** Attach Nuage-adapted copy to a favorite (written by Claude). */
export function setAdapted(id, adapted) {
  const data = load();
  const item = data.items.find((i) => i.id === String(id));
  if (!item) return null;
  item.adapted = adapted;
  save(data);
  return stamp(item);
}

/** Record reskinned image paths for a favorite. */
export function setReskinned(id, reskinned) {
  const data = load();
  const item = data.items.find((i) => i.id === String(id));
  if (!item) return null;
  item.images = item.images || { original: [], reskinned: [] };
  item.images.reskinned = reskinned;
  save(data);
  return stamp(item);
}
