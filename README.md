# AliExpress Product Platform

A standalone Node.js tool that fetches products from the **AliExpress Dropshipping (DS)
Open Platform API** and all of their info — title, price range, every SKU/variant with
stock and images, specifications, store details, and the full raw payload. It exposes both
a **local web UI** and a **CLI**, and supports a lightweight product-sourcing workflow:
search cheap/relevant products, favorite them, compute live landed cost, and "reskin"
product photos onto a consistent branded backdrop using a local background-removal model.

The access token is auto-refreshed (AliExpress tokens last ~24h) and the rotated pair is
persisted to `.tokens.json`, so a running session never expires mid-use.

## Tech Stack

- **Node.js ≥ 20** (uses built-in `fetch`, `node:http`, and `--env-file`)
- **ES modules** (`.mjs`), zero web framework — a hand-rolled `node:http` server
- **@huggingface/transformers** — runs the `briaai/RMBG-1.4` background-removal model locally (for reskinning)
- **sharp** — image compositing / processing
- AliExpress DS Open Platform API (GOP-signed `POST /sync` gateway)

## Features

- **Fetch a product** by ID or URL → normalized + raw JSON (`/api/product`, CLI `fetch`)
- **Keyword search** with deep multi-page fetch (`/api/search`, CLI `search`)
- **Live freight / landed-cost** simulation per SKU and destination (`/api/freight`)
- **Discovery feeds** — list promotion feeds and their product IDs (`/api/feeds`, `/api/feed`)
- **Favorites** — save a sourcing shortlist to `favorites.json` (web UI + `/api/favorites`)
- **Reskin** — locally remove each photo's background (RMBG-1.4) and composite onto a
  branded backdrop; no API key or quota (`npm run reskin <id>`, `/api/favorites/reskin`)
- **Token refresh** — rotate and persist tokens on demand (`/api/refresh`, CLI `refresh`)
- **Save to disk** — write full product JSON to `./data/<id>.json`

## Project Structure

```
aliexpress-platform/
├── server.mjs            # node:http web server (default port 4000) + JSON API
├── cli.mjs               # CLI: fetch / search / reskin / feeds / feed / refresh
├── lib/
│   ├── ae.mjs            # AliExpress DS API client, signing, token refresh
│   ├── favorites.mjs     # favorites.json read/write helpers
│   └── reskin.mjs        # RMBG-1.4 background removal + sharp compositing
├── public/
│   ├── index.html        # main web UI
│   └── favorites.html    # sourcing review page
├── data/                 # saved product JSON + data/reskinned/<id>/*.png
├── favorites.json        # sourcing shortlist
├── .env.example          # credential + default-query template
└── package.json
```

## Getting Started

Requires **Node.js ≥ 20**.

```bash
cp .env.example .env      # then fill in the four ALIEXPRESS_* values
npm install               # needed for the reskin feature (transformers + sharp)
```

Required `.env` values: `ALIEXPRESS_APP_KEY`, `ALIEXPRESS_APP_SECRET`,
`ALIEXPRESS_ACCESS_TOKEN`, `ALIEXPRESS_REFRESH_TOKEN`. Optional defaults:
`AE_SHIP_TO_COUNTRY` (FR), `AE_TARGET_CURRENCY` (EUR), `AE_TARGET_LANGUAGE` (EN), `PORT` (4000).

### Web UI

```bash
npm start                 # node --env-file=.env server.mjs → http://localhost:4000
```

### CLI

```bash
npm run fetch -- <id|url>            # fetch + print a product
npm run fetch -- <id|url> --save     # also write ./data/<id>.json
npm run search -- <keyword>          # keyword search
npm run reskin -- <favoriteId>       # reskin a favorite's images (first run downloads model)
npm run refresh                      # rotate the access token now
npm run fetch -- feeds               # list discovery feeds
npm run fetch -- feed <name> 20      # product IDs inside a feed
```

## API (server running on port 4000)

| Method | Route | Purpose |
|--------|-------|---------|
| GET  | `/api/product?input=<id\|url>` | Fetch one product (normalized + raw) |
| GET  | `/api/search?q=<kw>` | Keyword search (multi-page) |
| GET  | `/api/freight?productId=<id>` | Live shipping / landed cost |
| GET  | `/api/feeds` / `/api/feed?name=<feed>` | Discovery feeds and their product IDs |
| GET/POST | `/api/favorites` (+ `/remove`, `/reskin`) | Manage the sourcing shortlist |
| POST | `/api/save` | Save full product JSON to `./data` |
| POST | `/api/refresh` | Rotate + persist tokens |

## Notes

- Built on the DS gateway: business calls use a GOP-signed `POST /sync`; token refresh uses
  the path-prefixed `/rest/auth/token/refresh`. See `lib/ae.mjs`.
- `.env`, `.tokens.json`, and `data/` hold secrets/output and are gitignored.
- The reskin model (`briaai/RMBG-1.4`) is downloaded on first use and cached; reskinning is
  the only feature that needs `npm install` — the API/UI/CLI otherwise run on Node built-ins.
- No `LICENSE` file is present.
