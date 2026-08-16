# The Court — X.com-style clone (no login, GitHub Pages + Supabase)

## Files
- `index.html` + `style.css` + `app.js` — main site (feed, posting, reactions, comments, embeds, mentions, follow)
- `profile.html` — user profile pages (stats, follow button, their posts)
- `admin.html` — moderator-only panel (live visitors, posts, banned words, users, bans, titles)
- `schema.sql` — full schema for a **brand-new** Supabase project
- `fix-and-upgrade.sql`, `upgrade-v2.sql`, `upgrade-v3.sql` — patches for an **already-deployed** project, run in order

## ⚠️ Already deployed? Run these patches once, in order

1. `fix-and-upgrade.sql` — fixes likes not saving, turns on realtime updates.
2. `upgrade-v2.sql` — adds pin-post, moderator-managed banned words, and persistent user bans.
3. `upgrade-v3.sql` — adds multiple reactions, follows, and unique usernames (needed for self-chosen names). **If this one errors about a duplicate username**, two existing users already share a name — rename one in `admin.html` first, then re-run just the last line of this file.
4. `upgrade-v4.sql` — adds image posts (creates a Supabase Storage bucket), post editing, and the sub-moderator role.
5. `upgrade-v5.sql` — adds account recovery codes.

Run each once in Supabase SQL Editor (new query tab), in that order.

## Setup (15 minutes)

1. **Create a free Supabase project** → supabase.com → New Project.
2. **Run `schema.sql`**: Dashboard → SQL Editor → paste the whole file → Run.
   This creates the tables, enables the 36-hour auto-delete cron job, and sets up RLS.
3. **Get your keys**: Project Settings → API → copy `Project URL` and `anon public` key.
4. Paste those into the top of `app.js` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) **and** into `admin.html` **and** into `profile.html`.
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
- **Live feed updates**: posts, likes, and comments now appear instantly for everyone via Supabase Realtime — no manual refresh needed.
- **Moderator delete**: you'll see a red "🗑 Delete" action on every post in the main feed (only you see it), and a full post list with delete buttons in `admin.html`.
- **Pin a post**: moderator-only "📌 Pin" action on every post. Pinned posts stay at the top of the feed and are excluded from the 36-hour auto-delete.
- **Vanish countdown**: every non-pinned post shows "Xh Ym me gayab" so users know how long is left before it auto-deletes.
- **Word filter**: `admin.html` has a "Banned Words" section — add/remove words there; any post or comment containing one is blocked with a message, for everyone.
- **Ban a user**: `admin.html` user table has a Ban/Unban button per user (separate from the automatic VPN/incognito flag). A banned user sees a message and can't post, comment, or like — this persists across sessions (unlike the VPN/incognito flag, which is re-checked every visit).
- **Moderator username change**: `admin.html`, gated by your fingerprint, lets you rename anyone.
- **Reactions**: tap the reaction icon on any post to pick ❤ 😂 🔥 💀 (tap the same one again to remove it, or pick a different one to switch). Counts break down per reaction type.
- **@mentions**: typing `@` in the composer shows a live autocomplete of existing usernames; mentioned names are highlighted in posts and comments.
- **Trending badge**: any post with 3+ combined reactions and comments gets an automatic "🔥 Trending" badge.
- **Follow**: tap "+ Follow" next to a username in the feed or on their profile page (`profile.html?u=<id>`, reached by tapping any username/avatar) to follow them. Profile pages show follower/following counts and all of that user's posts.
- **Self-chosen usernames**: tap the ✏️ next to "Posting as X" to rename yourself. Names must be unique (case-insensitive) — the site blocks duplicates.
- **Image posts**: tap the 🖼️ icon in the composer to attach a photo (max 5MB). Images upload to a public Supabase Storage bucket called `post-images`.
- **Edit your own posts**: an "✏️ Edit" action appears only on posts you authored — click it to edit inline, with the same word-limit and banned-word checks as a new post. Edited posts show an "(edited)" tag.
- **Search**: the search bar at the top matches both usernames and post content live as you type.
- **Sub-moderators**: you (the full moderator/"God") can promote any user to sub-moderator from `admin.html` ("Make Sub-Mod" button). Sub-moderators can log into `admin.html` too, and can pin/delete posts, ban/unban users, and manage banned words — but cannot assign titles, rename users, or promote/demote other sub-moderators. Only you can do those.
- **Account recovery**: every new user gets an 8-character recovery code shown once at signup (also viewable anytime via "🔑 Recovery Code"). On a new phone/browser, tapping "🔓 Restore Account" and entering that code moves the account (username, title, post/comment history) to the new device, replacing the fresh guest identity that device had. Existing accounts from before this feature get a code generated automatically the first time they tap "🔑 Recovery Code".

## Important limitations — please read
- **VPN/incognito blocking is best-effort, not airtight.** Incognito detection uses a storage-quota heuristic that mostly works in Chromium browsers but can misfire (false positives/negatives) in Firefox/Safari. VPN detection calls the free `proxycheck.io` API, which catches well-known VPN/datacenter IPs but not all of them (e.g. a home network with a private VPN server won't be flagged). A determined user can still get around this — there is no way to make client-side detection 100% reliable. Treat it as a speed bump, not a lock.
- **No real authentication.** Because there's no login, anyone who inspects network requests could technically call the Supabase API directly and post using a spoofed fingerprint. For a small trusted group of ~10 people this is a reasonable trade-off, but it's not hardened against a motivated bad actor.
- **The 250-word limit is enforced client-side** (with a rough character-length backstop in the database policy). Someone hitting the API directly could bypass the exact word count, though the DB still caps raw length.
- **proxycheck.io free tier** has a daily request cap; if you expect heavier traffic, get a free API key from proxycheck.io and put it in `PROXYCHECK_API_KEY` in `app.js` for a higher limit.

## To customize further
- Change the 10 titles or colors in the `TITLES` array in `app.js` and the `.title-badge` CSS.
- Change the word limit via `WORD_LIMIT` in `app.js`.
- Change the auto-delete window by editing the `interval '36 hours'` values in `schema.sql` (both the cron job and the `loadFeed` cutoff in `app.js`).
