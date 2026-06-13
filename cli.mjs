// ----------------------------------------------------------------------------
// CLI for the AliExpress platform.
//
//   node --env-file=.env cli.mjs <productId|url>      fetch + print a product
//   node --env-file=.env cli.mjs feed <feedName> [n]  list product ids in a feed
//   node --env-file=.env cli.mjs feeds                 list available feeds
//   node --env-file=.env cli.mjs refresh               rotate the access token
//
// Add --save to write the full product JSON to ./data/<id>.json
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProduct, getFeeds, getFeedItemIds, searchProducts, refreshTokens, extractProductId } from "./lib/ae.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const save = args.includes("--save");
const positional = args.filter((a) => !a.startsWith("--"));
const cmd = positional[0];

try {
  if (cmd === "refresh") {
    const t = await refreshTokens();
    console.log("✓ Token refreshed. Access expires", new Date(t.access_expires_at).toLocaleString());
  } else if (cmd === "search") {
    const keyword = positional.slice(1).join(" ");
    if (!keyword) throw new Error("Usage: cli.mjs search <keyword>");
    const { total, products, currency } = await searchProducts(keyword, { size: 20 });
    console.log(`✓ "${keyword}" — ${total} results. First ${products.length}:`);
    products.forEach((p) =>
      console.log(`  ${String(p.id).padEnd(16)} ${String(p.price ?? "?").padStart(7)} ${currency}  ${(p.title || "").slice(0, 70)}`)
    );
  } else if (cmd === "reskin") {
    const id = positional[1];
    if (!id) throw new Error("Usage: cli.mjs reskin <favoriteId>");
    const { reskinProduct } = await import("./lib/reskin.mjs");
    console.log(`Reskinning images for ${id} (first run downloads the model)…`);
    const urls = await reskinProduct(id, { onProgress: (n, total, err) => console.log(`  ${n}/${total}${err ? " ✗ " + err : " ✓"}`) });
    console.log(`✓ ${urls.length} images reskinned → data/reskinned/${id}/`);
  } else if (cmd === "feeds") {
    const feeds = await getFeeds();
    console.log(`✓ ${feeds.length} feeds:`);
    feeds.slice(0, 50).forEach((f) => console.log(`  ${f.promo_name}  (${f.product_num} products)`));
  } else if (cmd === "feed") {
    const { total, products } = await getFeedItemIds(positional[1], { size: Number(positional[2] || 20) });
    console.log(`✓ ${positional[1]} — ${total} products. First ${products.length} ids:`);
    console.log("  " + products.join("\n  "));
  } else if (cmd) {
    const id = extractProductId(cmd);
    if (!id) throw new Error(`Could not find a product ID in "${cmd}"`);
    const { normalized: p, raw } = await getProduct(id);
    console.log(`\n✓ ${p.title}`);
    console.log(`  id:       ${p.id}`);
    console.log(`  price:    ${p.priceMin}${p.priceMax !== p.priceMin ? `–${p.priceMax}` : ""} ${p.currency}`);
    console.log(`  stock:    ${p.totalStock}`);
    console.log(`  images:   ${p.images.length}`);
    console.log(`  variants: ${p.variants.length}`);
    console.log(`  store:    ${p.store.name ?? "?"}`);
    console.log(`  url:      ${p.detailUrl}`);
    if (save) {
      fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
      const file = path.join(__dirname, "data", `${id}.json`);
      fs.writeFileSync(file, JSON.stringify({ normalized: p, raw }, null, 2));
      console.log(`  saved →   ${file}`);
    }
  } else {
    console.log("Usage: node --env-file=.env cli.mjs <productId|url> [--save] | feed <name> [n] | feeds | refresh");
  }
} catch (err) {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
}
