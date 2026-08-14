# The Court — X.com-style clone (no login, GitHub Pages + Supabase)

## Files
- `index.html` + `style.css` + `app.js` — main site (feed, posting, likes, comments, embeds, title picker)
- `admin.html` — moderator-only panel (live visitors, change any username)
- `schema.sql` — run once in Supabase SQL Editor to create everything

## Setup (15 minutes)

1. **Create a free Supabase project** → supabase.com → New Project.
2. **Run `schema.sql`**: Dashboard → SQL Editor → paste the whole file → Run.
   This creates the tables, enables the 36-hour auto-delete cron job, and sets up RLS.
3. **Get your keys**: Project Settings → API → copy `Project URL` and `anon public` key.
4. Paste those into the top of `app.js` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) **and** into `admin.html`.
5. **Register yourself as moderator**:
   - Push the site to GitHub Pages and open it once.
   - Open browser DevTools console → you'll see `Your fingerprint: fp_xxxxx`.
   - Copy that value into the seed insert at the bottom of `schema.sql` and run just that one `insert` statement in the SQL Editor (set `username` to your name, `title` to `'God'`, `title_color` to `'#8b5cf6'`, `is_moderator` to `true`).
   - Open `admin.html`, paste that same fingerprint into the gate box.
6. **Push to GitHub Pages**: commit all files to a repo, enable Pages on the `main` branch, done.

## How each feature works
- **No login**: identity = a fingerprint (canvas + device signals) saved in `localStorage`, tied to a random `Guest1234` username. Deterministic per browser, no signup.
- **Titles**: users cannot pick their own — only you can assign one, from the "All Users" table in `admin.html` (dropdown with the 10 titles + "none"). It saves to their row and shows as a grey badge on their posts/comments. Your own "God" title is seeded manually in `schema.sql` and shown fixed (not editable from the dropdown).
- **Auto-delete after 36h**: a `pg_cron` job runs every 15 minutes and deletes any post older than 36 hours. Comments/likes on it cascade-delete automatically.
- **Embeds**: post text is scanned for YouTube/Instagram/X/Facebook links; matching posts render an inline embed (YouTube via iframe, Instagram/X via their official widget scripts, Facebook via their public plugin iframe).
- **Live visitors**: uses Supabase Realtime "presence" — every open tab counts. Everyone sees the count; only `admin.html` shows the detailed list (username + IP).
- **Moderator username change**: `admin.html`, gated by your fingerprint, lets you rename anyone.

## Important limitations — please read
- **VPN/incognito blocking is best-effort, not airtight.** Incognito detection uses a storage-quota heuristic that mostly works in Chromium browsers but can misfire (false positives/negatives) in Firefox/Safari. VPN detection calls the free `proxycheck.io` API, which catches well-known VPN/datacenter IPs but not all of them (e.g. a home network with a private VPN server won't be flagged). A determined user can still get around this — there is no way to make client-side detection 100% reliable. Treat it as a speed bump, not a lock.
- **No real authentication.** Because there's no login, anyone who inspects network requests could technically call the Supabase API directly and post using a spoofed fingerprint. For a small trusted group of ~10 people this is a reasonable trade-off, but it's not hardened against a motivated bad actor.
- **The 250-word limit is enforced client-side** (with a rough character-length backstop in the database policy). Someone hitting the API directly could bypass the exact word count, though the DB still caps raw length.
- **proxycheck.io free tier** has a daily request cap; if you expect heavier traffic, get a free API key from proxycheck.io and put it in `PROXYCHECK_API_KEY` in `app.js` for a higher limit.

## To customize further
- Change the 10 titles or colors in the `TITLES` array in `app.js` and the `.title-badge` CSS.
- Change the word limit via `WORD_LIMIT` in `app.js`.
- Change the auto-delete window by editing the `interval '36 hours'` values in `schema.sql` (both the cron job and the `loadFeed` cutoff in `app.js`).
