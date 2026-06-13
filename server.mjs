// ----------------------------------------------------------------------------
// AliExpress product platform — local web server.
//   npm start   (-> node --env-file=.env server.mjs)   then open http://localhost:4000
// ----------------------------------------------------------------------------
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getProduct,
  getFeeds,
  getFeedItemIds,
  searchProducts,
  getFreight,
  refreshTokens,
  extractProductId,
} from "./lib/ae.mjs";
import {
  listFavorites,
  addFavorite,
  removeFavorite,
  isFavorite,
} from "./lib/favorites.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4000);
const DATA_DIR = path.join(__dirname, "data");

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string";
  res.writeHead(status, {
    "Content-Type": isJson ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;

  try {
    // --- UI ---
    if (req.method === "GET" && pathname === "/") {
      return send(res, 200, fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8"));
    }
    if (req.method === "GET" && pathname === "/favorites") {
      return send(res, 200, fs.readFileSync(path.join(__dirname, "public", "favorites.html"), "utf8"));
    }

    // --- favorites (sourcing shortlist) ---
    if (req.method === "GET" && pathname === "/api/favorites") {
      return send(res, 200, { items: listFavorites() });
    }
    if (req.method === "POST" && pathname === "/api/favorites") {
      const { input } = await readBody(req);
      const id = extractProductId(input || "");
      if (!id) return send(res, 400, { error: "Could not find a product ID." });
      if (isFavorite(id)) return send(res, 200, { items: listFavorites(), already: true });
      const { normalized } = await getProduct(id);
      return send(res, 200, { items: addFavorite(normalized, new Date().toISOString()) });
    }
    if (req.method === "POST" && pathname === "/api/favorites/remove") {
      const { id } = await readBody(req);
      return send(res, 200, { items: removeFavorite(id) });
    }
    if (req.method === "POST" && pathname === "/api/favorites/reskin") {
      const { id } = await readBody(req);
      // Lazy-load: only pull in the heavy model code when actually reskinning.
      const { reskinProduct } = await import("./lib/reskin.mjs");
      const urls = await reskinProduct(id);
      return send(res, 200, { id, reskinned: urls });
    }

    // --- serve reskinned images ---
    if (req.method === "GET" && pathname.startsWith("/reskinned/")) {
      const file = path.join(__dirname, "data", pathname.replace(/^\/reskinned\//, "reskinned/"));
      if (!file.startsWith(path.join(__dirname, "data", "reskinned"))) return send(res, 403, { error: "Forbidden" });
      if (!fs.existsSync(file)) return send(res, 404, { error: "Not found" });
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache" });
      return res.end(fs.readFileSync(file));
    }

    // --- fetch one product ---
    if (req.method === "GET" && pathname === "/api/product") {
      const input = url.searchParams.get("input") || "";
      const id = extractProductId(input);
      if (!id) return send(res, 400, { error: "Could not find a product ID in that input." });
      const data = await getProduct(id, {
        country: url.searchParams.get("country") || undefined,
        currency: url.searchParams.get("currency") || undefined,
        language: url.searchParams.get("language") || undefined,
      });
      return send(res, 200, data);
    }

    // --- keyword search: go fetch relevant products ---
    if (req.method === "GET" && pathname === "/api/search") {
      const q = url.searchParams.get("q");
      if (!q) return send(res, 400, { error: "Missing search keyword (q)." });
      const out = await searchProducts(q, {
        pages: Number(url.searchParams.get("pages") || 10),
        size: Number(url.searchParams.get("size") || 20),
        sort: url.searchParams.get("sort") || undefined,
        country: url.searchParams.get("country") || undefined,
        currency: url.searchParams.get("currency") || undefined,
        language: url.searchParams.get("language") || undefined,
      });
      return send(res, 200, out);
    }

    // --- live shipping simulation ---
    if (req.method === "GET" && pathname === "/api/freight") {
      const productId = url.searchParams.get("productId");
      if (!productId) return send(res, 400, { error: "Missing productId." });
      const out = await getFreight(productId, {
        skuId: url.searchParams.get("skuId") || undefined,
        quantity: Number(url.searchParams.get("qty") || 1),
        country: url.searchParams.get("country") || undefined,
        currency: url.searchParams.get("currency") || undefined,
        language: url.searchParams.get("language") || undefined,
      });
      return send(res, 200, out);
    }

    // --- discovery: feeds ---
    if (req.method === "GET" && pathname === "/api/feeds") {
      return send(res, 200, { feeds: await getFeeds() });
    }
    if (req.method === "GET" && pathname === "/api/feed") {
      const name = url.searchParams.get("name");
      if (!name) return send(res, 400, { error: "Missing feed name." });
      const out = await getFeedItemIds(name, {
        page: Number(url.searchParams.get("page") || 1),
        size: Number(url.searchParams.get("size") || 20),
      });
      return send(res, 200, out);
    }

    // --- save a product to disk ---
    if (req.method === "POST" && pathname === "/api/save") {
      const { input } = await readBody(req);
      const id = extractProductId(input || "");
      if (!id) return send(res, 400, { error: "Could not find a product ID." });
      const data = await getProduct(id);
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const file = path.join(DATA_DIR, `${id}.json`);
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
      return send(res, 200, { saved: file, title: data.normalized.title });
    }

    // --- force a token refresh ---
    if (req.method === "POST" && pathname === "/api/refresh") {
      const t = await refreshTokens();
      return send(res, 200, {
        ok: true,
        accessExpiresAt: new Date(t.access_expires_at).toISOString(),
        refreshExpiresAt: new Date(t.refresh_expires_at).toISOString(),
      });
    }

    return send(res, 404, { error: "Not found" });
  } catch (err) {
    return send(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  AliExpress platform running →  http://localhost:${PORT}\n`);
});
