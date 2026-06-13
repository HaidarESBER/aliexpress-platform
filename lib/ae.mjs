// ----------------------------------------------------------------------------
// AliExpress Dropshipping (DS) API client — standalone.
//
// Two request shapes on the Singapore IOP gateway:
//  - Business calls (aliexpress.ds.*) -> POST {BASE}/sync, "GOP" signature
//    (HMAC-SHA256 over the sorted key+value concat, NO path prefix).
//  - Token refresh -> {BASE}/rest/auth/token/refresh, "system" signature
//    (HMAC-SHA256 over path + sorted key+value).
//
// Tokens are persisted to .tokens.json and auto-refreshed before expiry, so
// the 24h access-token lifetime never breaks a running session.
// ----------------------------------------------------------------------------
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "https://api-sg.aliexpress.com";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, "..", ".tokens.json");

const APP_KEY = process.env.ALIEXPRESS_APP_KEY;
const APP_SECRET = process.env.ALIEXPRESS_APP_SECRET;

const DEFAULTS = {
  country: process.env.AE_SHIP_TO_COUNTRY || "FR",
  currency: process.env.AE_TARGET_CURRENCY || "EUR",
  language: process.env.AE_TARGET_LANGUAGE || "EN",
};

// --- signing ----------------------------------------------------------------
const concatSorted = (p) =>
  Object.keys(p).sort().map((k) => `${k}${p[k]}`).join("");

const signBusiness = (p) =>
  crypto.createHmac("sha256", APP_SECRET).update(concatSorted(p), "utf8").digest("hex").toUpperCase();

const signSystem = (apiPath, p) =>
  crypto.createHmac("sha256", APP_SECRET).update(apiPath + concatSorted(p), "utf8").digest("hex").toUpperCase();

// --- token store ------------------------------------------------------------
function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    // First run: seed from .env. Expiry unknown (0) -> we trust it until a call
    // fails or the caller forces a refresh.
    return {
      access_token: process.env.ALIEXPRESS_ACCESS_TOKEN,
      refresh_token: process.env.ALIEXPRESS_REFRESH_TOKEN,
      access_expires_at: 0,
      refresh_expires_at: 0,
    };
  }
}

function saveTokens(t) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2));
}

export async function refreshTokens() {
  const cur = loadTokens();
  if (!cur.refresh_token) throw new Error("No refresh token available (set ALIEXPRESS_REFRESH_TOKEN in .env).");
  const apiPath = "/auth/token/refresh";
  const params = {
    app_key: APP_KEY,
    refresh_token: cur.refresh_token,
    sign_method: "sha256",
    timestamp: Date.now().toString(),
  };
  params.sign = signSystem(apiPath, params);
  const res = await fetch(`${BASE}/rest${apiPath}?${new URLSearchParams(params)}`, { method: "POST" });
  const j = await res.json();
  const access = j.access_token || j.data?.access_token;
  if (!access) throw new Error(`Token refresh failed: ${JSON.stringify(j).slice(0, 300)}`);
  const now = Date.now();
  const next = {
    access_token: access,
    refresh_token: j.refresh_token || cur.refresh_token, // AE rotates this
    access_expires_at: now + Number(j.expires_in || 86400) * 1000,
    refresh_expires_at: now + Number(j.refresh_expires_in || 172800) * 1000,
  };
  saveTokens(next);
  return next;
}

async function getAccessToken() {
  let t = loadTokens();
  // Refresh if we know it's within 5 min of expiry. (access_expires_at === 0
  // means "unknown / freshly seeded from env" -> use as-is.)
  if (t.access_expires_at && t.access_expires_at - Date.now() < 5 * 60 * 1000) {
    t = await refreshTokens();
  }
  return t.access_token;
}

// --- core call --------------------------------------------------------------
export async function callDS(method, biz = {}) {
  if (!APP_KEY || !APP_SECRET) throw new Error("Missing ALIEXPRESS_APP_KEY / ALIEXPRESS_APP_SECRET.");
  const token = await getAccessToken();
  const params = {
    app_key: APP_KEY,
    method,
    session: token,
    sign_method: "sha256",
    timestamp: Date.now().toString(),
    format: "json",
    v: "2.0",
    simplify: "true",
  };
  for (const [k, v] of Object.entries(biz)) if (v !== undefined && v !== null) params[k] = String(v);
  params.sign = signBusiness(params);

  const res = await fetch(`${BASE}/sync`, { method: "POST", body: new URLSearchParams(params) });
  const j = await res.json();
  if (j.error_response) {
    const e = j.error_response;
    throw new Error(`AliExpress ${e.code || ""}: ${e.msg || e.message || "DS error"}`);
  }
  // Success codes vary by endpoint: "0" (token), "00" (text.search), or no
  // top-level code (product.get/feed). Real errors carry a non-zero string
  // code like "InvalidApiPath". Treat any all-zero code as success.
  if (typeof j.code === "string" && !/^0+$/.test(j.code)) {
    throw new Error(`AliExpress ${j.code}: ${j.message || "DS error"}`);
  }
  return j;
}

// --- helpers ----------------------------------------------------------------
export function extractProductId(input) {
  const s = String(input || "").trim();
  if (/^\d{6,}$/.test(s)) return s;
  const m =
    s.match(/\/item\/(?:[^/]*?)(\d{8,})\.html/) ||
    s.match(/[?&]productId=(\d{8,})/i) ||
    s.match(/(\d{10,})/);
  return m ? m[1] : null;
}

function asArray(x) {
  if (Array.isArray(x)) return x;
  if (x == null) return [];
  // simplify=true sometimes wraps lists as { ae_xxx_d_t_o: [...] }
  const inner = x.ae_item_sku_info_d_t_o || x.ae_sku_property_d_t_o || x.ae_item_property || x.string;
  if (Array.isArray(inner)) return inner;
  return [x];
}

/** Normalize the heavy DS payload into a flat, readable object. */
export function normalizeProduct(result, id) {
  const base = result?.ae_item_base_info_dto || {};
  const skus = asArray(result?.ae_item_sku_info_dtos);
  const images = String(result?.ae_multimedia_info_dto?.image_urls || "").split(";").filter(Boolean);
  const props = asArray(result?.ae_item_properties);
  const store = result?.ae_store_info || {};
  const prices = skus.map((s) => Number(s.offer_sale_price ?? s.sku_price)).filter((n) => !Number.isNaN(n));

  return {
    id: String(id),
    title: base.subject ?? null,
    detailUrl: base.detail_url ?? `https://www.aliexpress.com/item/${id}.html`,
    categoryId: base.category_id ?? null,
    rating: base.avg_evaluation_rating ?? null,
    orders: base.sales_count ?? base.evaluation_count ?? null,
    currency: skus[0]?.currency_code || DEFAULTS.currency,
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    totalStock: skus.reduce((a, s) => a + (Number(s.sku_available_stock) || 0), 0),
    images,
    variants: skus.map((s) => ({
      skuId: s.sku_id,
      attr: s.sku_attr,
      price: Number(s.offer_sale_price ?? s.sku_price) || null,
      listPrice: Number(s.sku_price) || null,
      stock: Number(s.sku_available_stock) || 0,
      options: asArray(s.ae_sku_property_dtos).map((p) => ({
        name: p.sku_property_name,
        value: p.property_value_definition_name || p.sku_property_value,
        image: p.sku_image || null,
      })),
    })),
    properties: props.map((p) => ({ name: p.attr_name, value: p.attr_value })),
    store: { name: store.store_name ?? null, id: store.store_id ?? null, url: store.store_url ?? null },
    descriptionUrl: result?.package_info_dto ? undefined : undefined, // description fetched separately if needed
  };
}

/** Fetch one product + return both the normalized view and the raw payload. */
export async function getProduct(productId, opts = {}) {
  const j = await callDS("aliexpress.ds.product.get", {
    product_id: productId,
    ship_to_country: opts.country || DEFAULTS.country,
    target_currency: opts.currency || DEFAULTS.currency,
    target_language: opts.language || DEFAULTS.language,
  });
  const result = j.result || j.resp_result?.result || j;
  return { normalized: normalizeProduct(result, productId), raw: j };
}

/** List the available promotion feeds (discovery). */
export async function getFeeds() {
  const j = await callDS("aliexpress.ds.feedname.get");
  return j?.resp_result?.result?.promos || j?.result?.promos || [];
}

/** Get product IDs inside a feed (discovery). */
export async function getFeedItemIds(feedName, { page = 1, size = 20 } = {}) {
  const j = await callDS("aliexpress.ds.feed.itemids.get", {
    feed_name: feedName,
    page_no: page,
    page_size: size,
  });
  const r = j?.result || j?.resp_result?.result || {};
  return { total: r.total ?? null, products: r.products ?? [] };
}

const LOCALE_BY_LANG = { EN: "en_US", FR: "fr_FR" };

// The API's own sortBy is ignored, so we fetch a batch and sort client-side.
const SORTERS = {
  price_asc: (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity),
  price_desc: (a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity),
  orders_desc: (a, b) => (Number(b.orders) || 0) - (Number(a.orders) || 0),
};

function mapSearchItem(p, currency) {
  return {
    id: String(p.itemId ?? p.productId ?? p.product_id ?? ""),
    title: p.title ?? p.product_title,
    image: p.itemMainPic ?? p.productMainImageUrl ?? p.product_main_image_url,
    price: Number(p.targetSalePrice ?? p.salePrice) || null,
    currency: p.targetSalePriceCurrency || currency,
    origPrice: Number(p.salePrice ?? p.originalPrice) || null,
    origCurrency: p.originalPriceCurrency || "CNY",
    discount: p.discount ?? null,
    orders: p.lastestVolume ?? p.orders ?? null,
    score: p.score || p.evaluateRate || null,
    url: p.productDetailUrl || `https://www.aliexpress.com/item/${p.itemId}.html`,
  };
}

async function searchPage(keyword, pageIndex, ctx) {
  try {
    const j = await callDS("aliexpress.ds.text.search", {
      keyWord: keyword,
      local: ctx.locale,
      countryCode: ctx.country,
      currency: ctx.currency,
      pageSize: ctx.size,
      pageIndex,
    });
    const d = j?.data || j?.result || {};
    const items = d.products || d.selection_search_product || [];
    return { total: d.totalCount ?? d.total ?? null, items: items.map((p) => mapSearchItem(p, ctx.currency)) };
  } catch {
    return { total: null, items: [] }; // a failed page shouldn't sink the whole search
  }
}

/**
 * Deep keyword search for sourcing. Fetches up to `pages` pages (the API caps
 * each at ~20 relevance-ranked items), aggregates and de-dupes into one pool,
 * and returns:
 *   - products[]   the whole pool, ordered by `sort` (relevance|price_asc|price_desc|orders_desc)
 *   - mostRelevant the API's #1 relevance hit (rank 0)
 *   - cheapest     the absolute lowest-priced item across the entire pool
 * Each product carries `rank` (0 = most relevant).
 */
export async function searchProducts(keyword, opts = {}) {
  const ctx = {
    country: opts.country || DEFAULTS.country,
    currency: opts.currency || DEFAULTS.currency,
    locale: LOCALE_BY_LANG[opts.language || DEFAULTS.language] || "en_US",
    size: opts.size || 20,
  };
  const maxPages = Math.min(Math.max(opts.pages || 10, 1), 25);

  // Page 1 first to learn the total, then fan the rest out in parallel.
  const first = await searchPage(keyword, 1, ctx);
  const total = first.total;
  const pagesAvailable = total ? Math.ceil(total / ctx.size) : 1;
  const pagesToFetch = Math.min(maxPages, Math.max(pagesAvailable, 1));
  const rest = [];
  for (let pg = 2; pg <= pagesToFetch; pg++) rest.push(searchPage(keyword, pg, ctx));
  const pages = [first, ...(await Promise.all(rest))];

  // Aggregate in relevance order, de-dupe by id, stamp the relevance rank.
  const seen = new Set();
  const pool = [];
  for (const pageRes of pages) {
    for (const item of pageRes.items) {
      if (item.id && !seen.has(item.id)) {
        seen.add(item.id);
        item.rank = pool.length; // 0 = most relevant
        pool.push(item);
      }
    }
  }

  const priced = pool.filter((p) => p.price != null);
  const cheapest = priced.length ? priced.reduce((m, p) => (p.price < m.price ? p : m)) : null;
  const mostRelevant = pool[0] || null;

  const products = [...pool];
  if (SORTERS[opts.sort]) products.sort(SORTERS[opts.sort]);

  return {
    total,
    fetched: pool.length,
    pagesFetched: pages.length,
    currency: ctx.currency,
    sort: opts.sort || "relevance",
    cheapest,
    mostRelevant,
    products,
  };
}

/**
 * Live shipping simulation for a product (optionally a specific SKU) to a
 * destination. Returns delivery options sorted cheapest-first — carrier,
 * fee, ETA, tracking. Confirmed against aliexpress.ds.freight.query.
 */
export async function getFreight(productId, opts = {}) {
  const country = opts.country || DEFAULTS.country;
  const currency = opts.currency || DEFAULTS.currency;
  const locale = LOCALE_BY_LANG[opts.language || DEFAULTS.language] || "en_US";
  const req = {
    productId: String(productId),
    quantity: Number(opts.quantity) || 1,
    shipToCountry: country,
    locale,
    language: locale,
    currency,
  };
  if (opts.skuId) req.selectedSkuId = String(opts.skuId);

  const j = await callDS("aliexpress.ds.freight.query", { queryDeliveryReq: JSON.stringify(req) });
  const r = j.result || j.resp_result?.result || {};
  const options = (r.delivery_options || []).map((o) => ({
    code: o.code,
    company: o.company,
    cost: Number(o.shipping_fee_cent ?? 0),
    costFormat: o.shipping_fee_format,
    currency: o.shipping_fee_currency || currency,
    free: !!o.free_shipping,
    minDays: o.min_delivery_days ?? null,
    maxDays: o.max_delivery_days ?? null,
    eta: o.delivery_date_desc ?? null,
    tracking: !!o.tracking,
    shipFrom: o.ship_from_country ?? null,
  }));
  options.sort((a, b) => a.cost - b.cost);
  return { country, currency, quantity: req.quantity, options };
}

export const defaults = DEFAULTS;
