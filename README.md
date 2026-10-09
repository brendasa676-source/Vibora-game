# VIBORA — corrected deployment package

## Files
- `server.js` — Express API, Socket.IO and startup database initialization
- `package.json` — Node.js dependencies and start command
- `schema.sql` — PostgreSQL tables and indexes
- `public/index.html` — VIBORA web interface (must stay inside `public/`)

## Deploy on Railway
1. Upload/push the **contents** of this folder to the root of your GitHub repository. Keep `server.js`, `package.json`, and `schema.sql` at the repository root and keep `index.html` inside `public/`.
2. In Railway, add/connect a PostgreSQL database to this same project.
3. In the VIBORA service Variables, set `DATABASE_URL` to the PostgreSQL service's connection URL (use Railway's reference variable if available) and set `JWT_SECRET` to a long random secret. Do not publish either value.
4. Set `NODE_ENV=production`. Railway supplies `PORT` automatically; do not hardcode it.
5. Deploy. On startup, VIBORA runs `schema.sql` and safe additive migrations. It needs a database user with permission to create/alter tables and indexes.
6. Open `https://YOUR-RAILWAY-DOMAIN/health`. A healthy result includes `"ok":true` and `"database":"connected"`.

## Important
- Never commit `.env`, passwords, tokens, or database credentials.
- A deployment cannot be guaranteed crash-proof; if `/health` is unhealthy, inspect Railway Deploy Logs for the first database/startup error.
- Existing database data is not intentionally deleted by the schema/migration setup.
