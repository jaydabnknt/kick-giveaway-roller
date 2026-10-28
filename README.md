# JDBBot

Kick chat bot for Giveaway Tools, on Cloudflare Workers' free plan. The site (gh-pages) posts lines
through it; the worker keeps the Kick tokens.

Deploy: Actions > deploy-bot > Run workflow. Needs repo secrets CLOUDFLARE_API_TOKEN, KICK_CLIENT_ID,
KICK_CLIENT_SECRET. Then open <worker url>/login while logged in to Kick as JDBBot.
