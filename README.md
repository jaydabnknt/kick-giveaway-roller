# JDBBot

Kick chat bot for Giveaway Tools, on Cloudflare Workers' free plan. The site (gh-pages) posts lines
through it; the worker keeps the Kick tokens.

Deploy: runs on every push to this branch (or Actions > deploy-bot > Run workflow once it is on main). Needs repo secrets CLOUDFLARE_API_TOKEN, KICK_CLIENT_ID,
KICK_CLIENT_SECRET. Then open <worker url>/login while logged in to Kick as JDBBot.
