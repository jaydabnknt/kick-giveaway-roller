# Setting up JDBBot (phone)

Do these in your phone's browser. Never paste keys in chat; they only go into GitHub secrets.

## 1. Cloudflare (free)
1. Sign up at dash.cloudflare.com and verify your email.
2. Open **Workers & Pages** once. Note your subdomain, shown as `something.workers.dev`. If it asks you to pick one, pick any name.
3. Go to **My Profile > API Tokens > Create Token**. Use the **Edit Cloudflare Workers** template, then Continue and Create Token. Copy the token.

## 2. Kick developer app (on your main account)
1. On kick.com go to **Settings > Developer > Create app**.
2. Name: `JDBBot`. Redirect URL: `https://jdbbot.YOURSUBDOMAIN.workers.dev/callback` (use the subdomain from step 1.2).
3. If the form shows a list of scopes or permissions, tick the ones for reading user info (`user:read`), reading channel info (`channel:read`) and writing to chat (`chat:write`). If there's no such list, skip this step; the bot asks for them when it signs in.
4. Save, then copy the **Client ID** and **Client Secret**.

## 3. GitHub secrets
On github.com/jaydabnknt/kick-giveaway-roller go to **Settings > Secrets and variables > Actions > New repository secret** and add three:
- `CLOUDFLARE_API_TOKEN`: the Cloudflare token
- `KICK_CLIENT_ID`: the Kick Client ID
- `KICK_CLIENT_SECRET`: the Kick Client Secret

Then tell Claude "secrets are in". Claude deploys the bot and sends you the sign-in link.

## 4. Sign the bot in (once)
1. In your phone's browser, log out of Kick and log in as **JDBBot**.
2. Open the sign-in link Claude sends and approve.
3. You land back on your site with the bot connected. Log back in to your main account.
4. In your Kick channel, type `/mod JDBBot` so it isn't caught by slow mode.
