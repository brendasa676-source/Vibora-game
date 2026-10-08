# VIBORA Online — Full-stack multiplayer starter

This turns the original VIBORA V3 browser prototype into a deployable online game server.

## What is included

- Node.js + Express server
- PostgreSQL persistent player saves
- Account registration/login with bcrypt password hashing
- HTTP-only authentication cookie with JWT
- VIBORA character creation starting at ₦10,000
- Server-authoritative money, fame, followers, day, business and location state
- Save button that writes to the server
- Home / Work District / Market Street / Pulse Club location highlighting
- Visual home scene instead of the old animated emoji-head scene
- Real-time Socket.IO chat scoped to the player's current location
- Online player list / presence in each location
- Chat history stored in PostgreSQL
- `/health` endpoint for hosting health checks
- Mobile-first UI

## Production architecture

One Railway service can serve the frontend and backend. A managed PostgreSQL database (Railway Postgres or Supabase Postgres) stores accounts, game state, events and chat. Socket.IO provides real-time chat/presence.

Railway's Socket.IO deployment guide documents Express + Socket.IO, public domains, reconnection and the Redis adapter for multi-instance scaling. For the first online release, run one app instance; add Redis before horizontal scaling. See the deployment notes below.

## Local setup

1. Install Node.js 20+.
2. Create a PostgreSQL database.
3. Run `schema.sql` against that database.
4. Copy `.env.example` to `.env` and set `DATABASE_URL` and `JWT_SECRET`.
5. Run:

```bash
npm install
npm start
```

6. Open `http://localhost:3000`.

## Railway deployment

1. Put this folder in a GitHub repository.
2. In Railway, create a new project and deploy the GitHub repository.
3. Add a PostgreSQL service, or point `DATABASE_URL` at your managed Postgres provider.
4. In the app service variables set:
   - `DATABASE_URL`
   - `JWT_SECRET`
   - `NODE_ENV=production`
5. Run the SQL in `schema.sql` once in the database.
6. Generate a Railway public domain for the app service.
7. Open the public HTTPS URL on two different phones and create two accounts. They will use the same server/database and can chat in the same location.

Railway detects Node/Express projects and can generate a public domain. The server binds to `0.0.0.0` and reads Railway's `PORT` variable.

## Important multiplayer scaling note

Socket.IO's default adapter keeps room state in the app process. If you later run multiple VIBORA server instances, add Redis and the Socket.IO Redis adapter so players connected to different instances can still communicate. The current project is intentionally single-instance-ready for the first online launch.

## Security notes before a public launch

- Use a strong random `JWT_SECRET`.
- Keep database credentials only in hosting environment variables.
- Add email verification/password reset before a large public launch.
- Add rate limiting, moderation, report/block/mute tools and stronger chat filtering.
- Add database backups and monitoring.
- Do not trust client-side money values; this build performs economy changes on the server.
