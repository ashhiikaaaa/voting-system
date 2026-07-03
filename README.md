# Sanskriti Sangam — People's Choice Award Voting Platform

Two separate pieces, as requested:

```
backend/     Node.js + Express API — stores votes, pushes live updates
frontend/    index.html — the 2-screen kiosk UI, talks to the backend over HTTP
```

## 1. Run the backend

```
cd backend
npm install
npm start
```

This starts the API on **http://localhost:4000** (change with `PORT=5000 npm start` if needed).
Votes are stored in `backend/votes.json`, created automatically on first run — all zeros for
the 8 stalls (Delhi, Haryana, Punjab, Rajasthan, Gujarat, Maharashtra, Tamil Nadu, Kerala).

To change the stall list, edit the `DEFAULT_STALLS` array at the top of `backend/server.js`.
(Editing names from the frontend was removed on purpose, per your request.)

### API endpoints
| Method | Path              | Purpose                                   |
|--------|-------------------|--------------------------------------------|
| GET    | `/api/stalls`     | Current stalls + vote counts               |
| POST   | `/api/vote`       | Body `{ "stall": "Kerala" }` — casts a vote |
| POST   | `/api/reset`      | Resets all votes to 0 (admin)               |
| GET    | `/api/export.csv` | Downloads results as CSV (admin)            |
| GET    | `/api/stream`     | Server-Sent Events — live vote updates      |
| GET    | `/api/health`     | Health check                                |

## 2. Connect the frontend to it

Open `frontend/index.html` in a text editor and set the `API_BASE` constant near the top of
the `<script>` block to wherever your backend is running:

```js
const API_BASE = "http://localhost:4000";
```

If you deploy the backend somewhere (a small VPS, Render, Railway, etc.), point `API_BASE` at
that public URL instead, e.g. `https://sanskriti-votes.yourdomain.com`.

Then just open `frontend/index.html` in a browser on each kiosk/tablet — no build step needed.

## 3. How the live sync works

- The backend keeps votes in one shared JSON file and broadcasts every change over
  **Server-Sent Events** (`/api/stream`) to all connected kiosks instantly.
- Every frontend also does a light poll of `/api/stalls` every 3 seconds as a backup, in case
  a network hiccup drops the live connection.
- Because every device reads and writes the same backend, **two kiosks voting at the same time
  will always show the same, consistent counts** — there's a "LIVE VOTING" / "RECONNECTING…"
  indicator at the top of the screen so staff can see connection status at a glance.

## 4. Admin dashboard

Tap the small footer text at the bottom of the voting screen **5 times quickly** to open the
admin panel: total votes, a live bar chart per stall, **Export CSV**, and **Reset Votes**.

## 5. Deploying for the event

- The backend needs to run somewhere reachable by every kiosk (a laptop on the same venue Wi-Fi
  works fine for a single-venue event — just use that laptop's local IP, e.g.
  `http://192.168.1.50:4000`, as `API_BASE` on every kiosk).
- For anything more permanent, deploy `backend/` to any Node.js host and update `API_BASE` once.
