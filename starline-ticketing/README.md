# StarLine Field Ops — Standalone FTTH Ticketing System

## What's inside
- `server.js` — the server (Node.js, zero dependencies, data stored in `db.json`)
- `public/index.html` — the app (admin dashboard + technician app)

## How to run
1. Install Node.js 18+ from nodejs.org (if not installed).
2. Open a terminal in this folder and run: `node server.js`
3. Open the printed **Local** address on your computer: `http://localhost:3000`
4. Log in with the default admin account: **admin / admin123** — change it right away (Team → Change My Password).

## Getting around
Both apps use a bottom tab bar.

- **Admin:** Overview · Tickets · New · Materials · Team
- **Technician:** My Jobs · New · Materials · Stats

The Overview is a summary only — every stat, chart bar and "needs attention" row is tappable and takes you to the Tickets tab already filtered, where you can also search and sort.

## Daily use
1. **You (admin):** Team → add each technician (name, username, password). Team → Job Settings holds the subscriber plans and the **repair issue types**.
2. **You:** New → create the job and assign a technician. For a repair you also pick the **reported issue** (modem fault, defective connector, high NAP reading, fiber cut, main NAP problem, or any issue you add yourself) — each one gives the technician a different set of steps.
3. **Technician:** logs in on their phone and sees only their own jobs. They can also raise a ticket themselves from the New tab; it is assigned to them automatically. Technicians cannot delete tickets.
4. **The guided workflow** forces every required step for that job type and issue: arrival photo (auto GPS + time), readings and photos, cable meter photos before and after lining, connectors, issued items used, customer details, speed test, signature.
5. **Job clock:** the timer starts the moment the technician first works on a job and stops on completion. The report carries an automatic remark — "Completed in 3 hours 20 minutes from the time the technician started work" — and the lists show a live "running" chip.
6. **Materials:** technicians request stock; you approve and release it. Everything released is recorded, and everything a completed job consumed (cable metres, connectors, issued items) is deducted from that technician automatically. Materials → Usage shows **released vs used vs unused** per item, a dated usage log per job, and the release log.

Technician phones must reach the server: on the same Wi-Fi/LAN use the **Network** address printed at startup (e.g. `http://192.168.1.10:3000`). For technicians in the field, host it on a VPS or expose it with a domain.

## Camera note (important)
The in-page live camera requires **HTTPS** (browser security rule). Without HTTPS:
- On `localhost` it works.
- On a plain `http://` network address, the app automatically falls back to the phone's native camera app (it still opens the camera directly — not the file gallery).

For full in-page camera over the internet, put the server behind HTTPS (e.g. free via Caddy, or a reverse proxy like Nginx + Let's Encrypt, or Cloudflare Tunnel).

## Backup
All data (accounts, tickets, photos, signatures) lives in `db.json`. Copy that file to back up; restore it by putting it back and restarting.
