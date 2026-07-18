# HTML Viewer secure backend setup

This folder contains a Cloudflare Worker that keeps the Gemini API key,
Pollinations API key, and Discord webhook URL out of the public HTML file. The
browser calls this Worker, and only the Worker can read the three secrets.

The Worker is deployed at:

```text
https://html-viewer-secure-backend.nickthequick1806.workers.dev
```

The Worker provides these routes:

- `GET /health`
- `GET /api/pollinations/balance`
- `POST /api/ai/image`
- `POST /api/ai/gemini`
- `POST /api/contact`
- `POST /api/community-preset`

## 1. Replace the old credentials first

The old credentials were inside a browser-delivered HTML file. Treat all three
as exposed even if the site was only online briefly. Do not put the old values
back into this project.

1. In Google AI Studio, delete the exposed Gemini key and create a new Gemini
   **Auth** key. Do not reuse an unrestricted legacy **Standard** key; Google is
   retiring Standard keys in 2026. Keep the replacement restricted to the
   Gemini API.
2. In the Pollinations key/account page, revoke the exposed key and create a new
   one. Add a model restriction and Pollen spending cap if those controls are
   available for your account.
3. In Discord, open the server's **Server Settings > Integrations > Webhooks**.
   Delete the exposed webhook, create a replacement, and copy its new URL.

Useful official pages:

- Gemini keys: https://ai.google.dev/gemini-api/docs/api-key
- Pollinations API docs: https://gen.pollinations.ai/docs
- Pollinations account/key site: https://enter.pollinations.ai
- Discord webhooks: https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks

## 2. Check the allowed website addresses

Open `wrangler.jsonc`. The `ALLOWED_ORIGINS` value currently allows:

- `https://htmlviewer.site`
- `https://www.htmlviewer.site`
- `http://localhost:8000` for local testing

If the real site uses a different exact address, replace or add it in the same
comma-separated value. Include `https://` and do not include a path. Do not add
`*` or `null`; that would let untrusted websites use the backend from a browser.

## 3. Install the one prerequisite

Install the current Node.js LTS release from https://nodejs.org if Node is not
already installed. Close and reopen PowerShell after installing it.

Check the installation:

```powershell
node --version
npm --version
```

Both commands should print a version number.

## 4. Create and deploy the free Worker

Open PowerShell and run:

```powershell
cd "C:\Users\Nick\Desktop\htmlviewer\backend"
npx wrangler login
```

Cloudflare will open a browser. Create or sign in to a free Cloudflare account
and approve Wrangler. Then return to PowerShell and run:

```powershell
npx wrangler deploy
```

The first deployment creates the Worker and prints an address similar to:

```text
https://html-viewer-secure-backend.your-subdomain.workers.dev
```

Keep that address. The API routes will return a setup error until the secrets
are added in the next step.

## 5. Add the three secrets safely

Run each command separately:

```powershell
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put POLLINATIONS_API_KEY
npx wrangler secret put DISCORD_WEBHOOK_URL
```

Each command asks for a value. Paste the matching **new** credential only at
that hidden prompt, then press Enter. Do not add quotes. Wrangler sends it to
Cloudflare as an encrypted Worker secret; it does not add the value to the code
or `wrangler.jsonc`.

Deploy once more so the code, origin list, rate limits, and secrets are all on
the current version:

```powershell
npx wrangler deploy
```

## 6. Connect the HTML file to the Worker

`htmlviewer.htm` is already connected to the deployed Worker address. The
Worker address is public and is safe to keep in frontend code; the three
credentials are not.

Upload the updated `htmlviewer.htm` to the website as usual.

## 7. Test everything

First open the health address in a browser, replacing the example host with
yours:

```text
https://html-viewer-secure-backend.your-subdomain.workers.dev/health
```

It should show JSON containing `"ok":true`.

For a local test, serve the project over HTTP instead of double-clicking the
HTML file. From the project folder run either command that is available:

```powershell
cd "C:\Users\Nick\Desktop\htmlviewer"
python -m http.server 8000
```

or:

```powershell
cd "C:\Users\Nick\Desktop\htmlviewer"
npx http-server . -p 8000
```

Then open:

```text
http://localhost:8000/htmlviewer.htm
```

Test a Gemini message, an image, the Pollen balance, the contact form, and a
community preset submission. Stop the local server with **Ctrl+C**.

## Troubleshooting

- **Secure backend URL has not been configured:** the placeholder in
  `htmlviewer.htm` was not replaced with the real `workers.dev` address.
- **Origin is not allowed / CORS error:** add the exact frontend origin to
  `ALLOWED_ORIGINS` in `wrangler.jsonc`, then run `npx wrangler deploy` again.
- **Backend secret ... is not configured:** rerun the matching
  `npx wrangler secret put ...` command.
- **429 / Too many requests:** wait one minute. The included limits allow 30 AI
  requests and 6 form submissions per client address per minute.
- **Discord rejects a request:** confirm that the secret is the complete new
  Discord webhook URL and that the webhook still exists.
- **A Gemini key is reported as leaked:** delete it and create another key. A
  value previously included in frontend code should never be reused.
- **Gemini returns 401 / invalid authentication credentials:** open the key in
  Google AI Studio and verify its **Key Type** is **Auth**. Replace revoked,
  blocked, or legacy Standard keys, then run
  `npx wrangler secret put GEMINI_API_KEY`. The Worker already sends the key in
  Google's required `x-goog-api-key` header.

## Updating a credential later

From this `backend` folder, run the same secret command again and enter the new
value. For example:

```powershell
npx wrangler secret put GEMINI_API_KEY
```

Never place real credentials in `worker.js`, `wrangler.jsonc`,
`.dev.vars.example`, `htmlviewer.htm`, Git, screenshots, or chat messages.

## Security boundary

The credentials are encrypted and hidden from website visitors, but the Worker
routes are intentionally callable by your website. This project restricts
browser origins, validates all inputs, constructs Discord payloads on the
server, and applies rate limits. Origin checks can still be imitated by a
determined non-browser client, so monitor provider usage and keep spending caps
enabled. If the site becomes high traffic, add user sign-in or Cloudflare
Turnstile before raising the included rate limits.
