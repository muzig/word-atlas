#!/usr/bin/env node
/*
 * Self-hosted server: serves dist/ and syncs progress across devices through SQLite.
 *
 *   node scripts/serve.mjs --port 4182 --db ~/Library/Application\ Support/word-atlas/progress.db
 *
 * Requires Node 22.13+ (node:sqlite). Binds to 127.0.0.1; put it behind `tailscale serve`
 * or another reverse proxy. Each user is keyed by the Tailscale-User-Login header that
 * tailscale serve adds; requests without it (direct localhost) share the "local" user.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";

const { values: opt } = parseArgs({
  options: {
    port: { type: "string", default: "4182" },
    host: { type: "string", default: "127.0.0.1" },
    root: { type: "string", default: "dist" },
    db: { type: "string", default: path.join(os.homedir(), ".local/share/word-atlas/progress.db") },
    // Also accept requests that still carry the build's sub-path (when no proxy strips it).
    base: { type: "string", default: process.env.ATLAS_BASE || "/" },
  },
});

const ROOT = path.resolve(opt.root);
const BASE = opt.base.replace(/\/?$/, "/");
const MAX_BODY = 32 * 1024 * 1024;

fs.mkdirSync(path.dirname(path.resolve(opt.db)), { recursive: true });
const db = new DatabaseSync(path.resolve(opt.db));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS docs (
    user TEXT NOT NULL,
    dataset TEXT NOT NULL,
    rev INTEGER NOT NULL,
    doc TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user, dataset)
  );
`);
const getDoc = db.prepare("SELECT rev, doc FROM docs WHERE user = ? AND dataset = ?");
const putDoc = db.prepare(`
  INSERT INTO docs (user, dataset, rev, doc, updated_at) VALUES (?, ?, 1, ?, ?)
  ON CONFLICT (user, dataset) DO UPDATE SET rev = rev + 1, doc = excluded.doc, updated_at = excluded.updated_at
  RETURNING rev
`);
const deleteDoc = db.prepare("DELETE FROM docs WHERE user = ? AND dataset = ?");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
};

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function sync(req, res, dataset) {
  const user = String(req.headers["tailscale-user-login"] || "local");
  const row = getDoc.get(user, dataset);
  const rev = row ? Number(row.rev) : 0;
  if (req.method === "GET") {
    const known = Number(new URL(req.url, "http://x").searchParams.get("rev"));
    return json(res, 200, known === rev ? { rev } : { rev, doc: row ? JSON.parse(row.doc) : undefined });
  }
  if (req.method === "DELETE") {
    if (dataset === "profiles") return json(res, 400, { error: "doc" });
    deleteDoc.run(user, dataset);
    return json(res, 200, { rev: 0 });
  }
  if (req.method !== "PUT") return json(res, 405, { error: "method" });
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "body" });
  }
  const doc = body?.doc;
  // "profiles" holds the learner's profile list; every other key is one profile's progress in one dataset.
  const valid = dataset === "profiles" ? Array.isArray(doc?.profiles) : doc && typeof doc.progress === "object" && typeof doc.settings === "object";
  if (!valid) return json(res, 400, { error: "doc" });
  // Optimistic concurrency: the client must have merged the latest revision first.
  if (body.baseRev !== rev) return json(res, 409, { rev, doc: row ? JSON.parse(row.doc) : undefined });
  const next = putDoc.get(user, dataset, JSON.stringify(doc), Date.now());
  return json(res, 200, { rev: Number(next.rev) });
}

function serveFile(req, res, route) {
  let rel;
  try {
    rel = decodeURIComponent(route);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = path.join(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return res.writeHead(403).end();
  if (rel.endsWith("/")) file = path.join(file, "index.html");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    const headers = {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Last-Modified": st.mtime.toUTCString(),
      // Hashed build assets never change; everything else revalidates.
      "Cache-Control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    };
    if (req.headers["if-modified-since"] === headers["Last-Modified"]) return res.writeHead(304, headers).end();
    const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) return res.writeHead(416, { "Content-Range": `bytes */${st.size}` }).end();
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": st.size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

http
  .createServer((req, res) => {
    let route = (req.url || "/").split("?")[0];
    if (BASE !== "/" && route.startsWith(BASE)) route = route.slice(BASE.length - 1);
    else if (BASE !== "/" && route === BASE.slice(0, -1)) route = "/";
    const api = route.match(/^\/api\/sync\/([\w.-]{1,64})$/);
    if (api) {
      sync(req, res, api[1]).catch((e) => {
        console.error(e);
        if (!res.headersSent) json(res, 500, { error: "server" });
      });
      return;
    }
    if (route.startsWith("/api/")) return json(res, 404, { error: "not found" });
    if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();
    serveFile(req, res, route);
  })
  .listen(Number(opt.port), opt.host, () => {
    console.log(`word-atlas serving ${ROOT} on http://${opt.host}:${opt.port}${BASE} (db ${path.resolve(opt.db)})`);
  });
