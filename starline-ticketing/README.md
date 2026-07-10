# StarLine Field Ops — Standalone FTTH Ticketing System

## What's inside
- `server.js` — the server (Node.js, zero dependencies, data stored in `db.json`)
- `public/index.html` — the app (admin dashboard + technician app)

## How to run
1. Install Node.js 18+ from nodejs.org (if not installed).
2. Open a terminal in this folder and run: `node server.js`
3. Open the printed **Local** address on your computer: `http://localhost:3000`
4. Log in with the default admin account: **admin / admin123** — change it right away (Technicians tab → Change My Password).

## Daily use
1. **You (admin):** Technicians tab → add each technician (name, username, password).
2. **You:** New Ticket tab → create the job and assign a technician.
3. **Technician:** opens the app on their phone, logs in, and sees only their assigned jobs. The guided workflow forces every required step: arrival photo (auto GPS + time), house photo, optical reading + photo, modem photo + serial, NAP/port + photo, coordinates, cable meters, connectors, customer details, speed test photo, customer signature.
4. **You:** Dashboard tab shows live counts (open / in progress / completed, installs vs repairs, completed today) and every ticket's progress. Tap a ticket to view the full report with all photos, reassign, reopen, print, or delete.

Technician phones must reach the server: on the same Wi-Fi/LAN use the **Network** address printed at startup (e.g. `http://192.168.1.10:3000`). For technicians in the field, host it on a VPS or expose it with a domain.

## Camera note (important)
The in-page live camera requires **HTTPS** (browser security rule). Without HTTPS:
- On `localhost` it works.
- On a plain `http://` network address, the app automatically falls back to the phone's native camera app (it still opens the camera directly — not the file gallery).

For full in-page camera over the internet, put the server behind HTTPS (e.g. free via Caddy, or a reverse proxy like Nginx + Let's Encrypt, or Cloudflare Tunnel).

## Backup
All data (accounts, tickets, photos, signatures) lives in `db.json`. Copy that file to back up; restore it by putting it back and restarting.
