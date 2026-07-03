// server.js
// Backend for the Sanskriti Sangam People's Choice Award voting platform.
//
// - Real embedded SQL database (SQLite, via Node's built-in `node:sqlite`) — not a flat
//   JSON file. Every vote is its own row with a timestamp, so we get accurate counts,
//   a recent-activity feed, and a votes-over-time chart for free.
// - Public endpoints power the voting kiosk (frontend/index.html).
// - Admin endpoints (protected with HTTP Basic Auth) power the separate admin dashboard
//   (frontend/admin.html) — summary stats, recent votes, CSV export, reset.
// - Live updates pushed to every connected screen via Server-Sent Events (SSE), so the
//   kiosk and the admin dashboard both update instantly and stay in sync.
//
// Requires Node.js 22.5+ (for the built-in node:sqlite module).
//
// Run:
//   npm install
//   npm start

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const PORT = process.env.PORT || 4000;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "sanskriti2026";

// Each stall's official display name (as it appears on the voting card).
// "frontend/index.html" maps each of these to the state it represents for
// the smaller caption on the card — see STATE_LABELS there.
const DEFAULT_STALLS = [
  "Rangeelo Rajasthan",
  "Himadri",
  "Jannat-e-Jammu & Kashmir",
  "Soul of Bengal",
  "Rangrez Gujarat",
  "Andaz-e-Haryana",
  "Devbhoomi Uttarakhand",
  "Viraasat-e-Uttar Pradesh",
];

// ---------- database ----------

const DB_FILE = path.join(__dirname, "votes.db");
const db = new DatabaseSync(DB_FILE);

db.exec(`
  CREATE TABLE IF NOT EXISTS stalls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    sort_order INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stall_id INTEGER NOT NULL REFERENCES stalls(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

const stallCount = db.prepare("SELECT COUNT(*) AS c FROM stalls").get().c;
if (stallCount === 0) {
  const insert = db.prepare("INSERT INTO stalls (name, sort_order) VALUES (?, ?)");
  DEFAULT_STALLS.forEach((name, i) => insert.run(name, i));
}

function getStallsWithCounts() {
  return db
    .prepare(
      `SELECT s.name AS name, COUNT(v.id) AS votes
       FROM stalls s
       LEFT JOIN votes v ON v.stall_id = s.id
       GROUP BY s.id
       ORDER BY s.sort_order`
    )
    .all();
}

function totalVotes() {
  return db.prepare("SELECT COUNT(*) AS c FROM votes").get().c;
}

function castVote(name) {
  const stall = db.prepare("SELECT id FROM stalls WHERE name = ?").get(name);
  if (!stall) return false;
  db.prepare("INSERT INTO votes (stall_id) VALUES (?)").run(stall.id);
  return true;
}

function resetVotes() {
  db.exec("DELETE FROM votes");
}

function recentVotes(limit = 20) {
  return db
    .prepare(
      `SELECT s.name AS stall, v.created_at AS time
       FROM votes v JOIN stalls s ON s.id = v.stall_id
       ORDER BY v.id DESC LIMIT ?`
    )
    .all(limit);
}

// Votes bucketed by minute, for a simple "activity over time" chart on the dashboard.
function votesTimeline() {
  return db
    .prepare(
      `SELECT strftime('%Y-%m-%dT%H:%M:00Z', created_at) AS bucket, COUNT(*) AS count
       FROM votes
       GROUP BY bucket
       ORDER BY bucket DESC
       LIMIT 30`
    )
    .all()
    .reverse();
}

function summary() {
  const stalls = getStallsWithCounts();
  const total = totalVotes();
  const leading = stalls.reduce(
    (best, s) => (!best || s.votes > best.votes ? s : best),
    null
  );
  return {
    stalls,
    total,
    leading: leading && leading.votes > 0 ? leading : null,
    recent: recentVotes(20),
    timeline: votesTimeline(),
  };
}

// ---------- SSE (live update) hub ----------

const sseClients = new Set();

function broadcast() {
  const payload = JSON.stringify({ stalls: getStallsWithCounts(), total: totalVotes() });
  for (const res of sseClients) {
    res.write(`event: update\ndata: ${payload}\n\n`);
  }
}

// ---------- admin auth ----------

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Basic ")) {
    const [user, pass] = Buffer.from(auth.slice(6), "base64").toString().split(":");
    if (user === ADMIN_USER && pass === ADMIN_PASSWORD) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Sanskriti Sangam Admin"');
  return res.status(401).json({ error: "Admin authentication required." });
}

// ---------- app ----------

const app = express();
app.use(cors());
app.use(express.json());

// Serve the frontend (index.html / admin.html). Works whether your repo keeps them in
// the same folder as server.js (flat layout) or in a sibling "frontend" folder.
const candidateDirs = [
  __dirname,                          // flat layout: index.html next to server.js
  path.join(__dirname, "frontend"),   // repo/backend/frontend (if backend has its own copy)
  path.join(__dirname, "../frontend"),// repo/backend/server.js + repo/frontend
  path.join(__dirname, ".."),         // repo root, one level above backend/
];
const staticRoot = candidateDirs.find((dir) => fs.existsSync(path.join(dir, "index.html"))) || __dirname;
console.log(`Serving frontend from: ${staticRoot}`);
app.use(express.static(staticRoot));

app.get("/", (req, res, next) => {
  const indexPath = path.join(staticRoot, "index.html");
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  next();
});

app.get("/admin.html", (req, res, next) => {
  const adminPath = path.join(staticRoot, "admin.html");
  if (fs.existsSync(adminPath)) return res.sendFile(adminPath);
  next();
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Public — used by the voting kiosk
app.get("/api/stalls", (req, res) => {
  res.json({ stalls: getStallsWithCounts(), total: totalVotes() });
});

app.post("/api/vote", (req, res) => {
  const { stall } = req.body || {};
  if (!stall || !castVote(stall)) {
    return res.status(400).json({ error: "Unknown or missing stall name." });
  }
  broadcast();
  res.json({ stalls: getStallsWithCounts(), total: totalVotes() });
});

app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");
  res.write(`event: update\ndata: ${JSON.stringify({ stalls: getStallsWithCounts(), total: totalVotes() })}\n\n`);
  sseClients.add(res);
  const keepAlive = setInterval(() => res.write(":ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

// Protected — used by the separate admin dashboard (frontend/admin.html)
app.get("/api/admin/summary", requireAdmin, (req, res) => {
  res.json(summary());
});

app.post("/api/admin/reset", requireAdmin, (req, res) => {
  resetVotes();
  broadcast();
  res.json(summary());
});

app.get("/api/admin/export.csv", requireAdmin, (req, res) => {
  let csv = "Stall,Votes\n";
  getStallsWithCounts().forEach((s) => {
    csv += `${s.name},${s.votes}\n`;
  });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="sanskriti-sangam-votes.csv"');
  res.send(csv);
});

app.get("/api/admin/export-log.csv", requireAdmin, (req, res) => {
  let csv = "Stall,Timestamp (UTC)\n";
  db.prepare(
    `SELECT s.name AS stall, v.created_at AS time
     FROM votes v JOIN stalls s ON s.id = v.stall_id
     ORDER BY v.id ASC`
  )
    .all()
    .forEach((row) => {
      csv += `${row.stall},${row.time}\n`;
    });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="sanskriti-sangam-vote-log.csv"');
  res.send(csv);
});

// Lets the admin dashboard verify a login attempt without fetching full data.
app.get("/api/admin/whoami", requireAdmin, (req, res) => {
  res.json({ ok: true, user: ADMIN_USER });
});

app.listen(PORT, () => {
  console.log(`Sanskriti Sangam voting backend running on http://localhost:${PORT}`);
  console.log(`Admin credentials: ${ADMIN_USER} / ${ADMIN_PASSWORD} (change via ADMIN_USER / ADMIN_PASSWORD env vars)`);
});