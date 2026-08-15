// ============================================================
// CONFIG — fill these in from your Supabase project settings
// (Project Settings -> API). The anon/public key is safe to
// expose in client code; it only allows what RLS policies permit.
// ============================================================
const SUPABASE_URL = "https://YOUR_PROJECT.supabase.co";
const SUPABASE_ANON_KEY = "YOUR_ANON_PUBLIC_KEY";

// Optional: proxycheck.io API key for VPN/proxy detection.
// Works without a key at a low rate limit; sign up free for more.
const PROXYCHECK_API_KEY = "";

const WORD_LIMIT = 250;
const TITLES = ["King", "Queen", "Joker", "Knight", "Demon Lord", "Demon Knight", "Demon Queen", "Slave", "Angel", "Trump"];
const REACTIONS = [
  { key: "heart", emoji: "❤" },
  { key: "laugh", emoji: "😂" },
  { key: "fire", emoji: "🔥" },
  { key: "skull", emoji: "💀" }
];
const TRENDING_THRESHOLD = 3; // total reactions + comments needed to show the trending badge

// ============================================================
// Supabase client (loaded via CDN script tag in index.html)
// ============================================================
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let CURRENT_USER = null;   // row from `users` table
let IS_BLOCKED = false;
let BANNED_WORDS = [];
let ALL_USERNAMES = [];    // for @mention autocomplete

// ------------------------------------------------------------
// 1. Anonymous identity: fingerprint + localStorage
// ------------------------------------------------------------
async function getFingerprint() {
  let stored = localStorage.getItem("xc_fp");
  if (stored) return stored;

  const parts = [
    navigator.userAgent,
    navigator.language,
    screen.width + "x" + screen.height,
    screen.colorDepth,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    navigator.hardwareConcurrency || "",
    canvasFingerprint()
  ].join("###");

  let hash = 0;
  for (let i = 0; i < parts.length; i++) {
    hash = (hash << 5) - hash + parts.charCodeAt(i);
    hash |= 0;
  }
  const fp = "fp_" + Math.abs(hash).toString(36) + "_" + Date.now().toString(36).slice(-4);
  localStorage.setItem("xc_fp", fp);
  return fp;
}

function canvasFingerprint() {
  try {
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d");
    ctx.textBaseline = "top";
    ctx.font = "14px Arial";
    ctx.fillText("xclone-fp-🔥", 2, 2);
    return c.toDataURL();
  } catch (e) {
    return "no-canvas";
  }
}

// ------------------------------------------------------------
// 2. Incognito heuristic (best-effort, not foolproof)
// Incognito windows typically report a much smaller storage
// quota than normal windows in Chromium browsers.
// ------------------------------------------------------------
async function looksLikeIncognito() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { quota } = await navigator.storage.estimate();
      if (quota && quota < 120 * 1024 * 1024) return true; // <120MB is a strong incognito signal in Chrome
    }
    return false;
  } catch (e) {
    return false;
  }
}

// ------------------------------------------------------------
// 3. VPN / proxy check via proxycheck.io (client IP auto-detected)
// ------------------------------------------------------------
async function looksLikeVPN() {
  try {
    const key = PROXYCHECK_API_KEY ? `&key=${PROXYCHECK_API_KEY}` : "";
    const res = await fetch(`https://proxycheck.io/v2/?vpn=1${key}`);
    const data = await res.json();
    const ipKey = Object.keys(data).find(k => k !== "status");
    if (ipKey && data[ipKey]) {
      return data[ipKey].proxy === "yes" || data[ipKey].vpn === "yes";
    }
    return false;
  } catch (e) {
    return false; // fail open on network error — don't lock out real users if the check itself fails
  }
}

async function getPublicIP() {
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    const data = await res.json();
    return data.ip;
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------
// 4. Bootstrap: identify or create the user row, gate posting
// ------------------------------------------------------------
async function initUser() {
  const fp = await getFingerprint();
  console.log("Your fingerprint:", fp); // moderator: copy this into schema.sql seed insert

  const [incognito, vpn, ip] = await Promise.all([looksLikeIncognito(), looksLikeVPN(), getPublicIP()]);
  const autoBlocked = incognito || vpn;

  let { data: existing } = await sb.from("users").select("*").eq("fingerprint", fp).maybeSingle();

  if (existing) {
    CURRENT_USER = existing;
    IS_BLOCKED = autoBlocked || existing.banned_by_mod;
    await sb.from("users").update({ last_seen: new Date().toISOString(), ip, is_blocked: autoBlocked }).eq("id", existing.id);
  } else {
    const randomName = "Guest" + Math.floor(1000 + Math.random() * 9000);
    const { data: created, error } = await sb.from("users").insert({
      fingerprint: fp, ip, username: randomName, is_blocked: autoBlocked
    }).select().single();
    if (error) { console.error(error); return; }
    CURRENT_USER = created;
    IS_BLOCKED = autoBlocked;
  }

  const { data: words } = await sb.from("banned_words").select("word");
  BANNED_WORDS = (words || []).map(w => w.word.toLowerCase());

  const { data: allUsers } = await sb.from("users").select("username");
  ALL_USERNAMES = (allUsers || []).map(u => u.username);

  renderIdentity();
}

function renderIdentity() {
  const el = document.getElementById("blockedBanner");
  if (IS_BLOCKED) {
    el.style.display = "block";
    el.textContent = CURRENT_USER.banned_by_mod
      ? "Moderator ne aapko block kiya hai — aap post/comment/like nahi kar sakte."
      : "VPN ya incognito mode detect hua — is se aap post nahi kar sakte. Normal browsing mode aur bina VPN ke try karein.";
    document.getElementById("postBtn").disabled = true;
  } else {
    el.style.display = "none";
    document.getElementById("postBtn").disabled = false;
  }
  document.getElementById("whoami").textContent = CURRENT_USER.username;
  const fpEl = document.getElementById("fpDisplay");
  if (fpEl) fpEl.textContent = CURRENT_USER.fingerprint;

  const modLink = document.getElementById("modPanelLink");
  if (modLink) modLink.style.display = CURRENT_USER.is_moderator ? "inline-block" : "none";
}

async function renameUsername() {
  const newName = prompt("Naya username choose karo (unique hona chahiye):", CURRENT_USER.username);
  if (!newName || !newName.trim() || newName.trim() === CURRENT_USER.username) return;
  const trimmed = newName.trim();

  const { data: clash } = await sb.from("users").select("id").ilike("username", trimmed).neq("id", CURRENT_USER.id).maybeSingle();
  if (clash) { alert("Ye username already liya hua hai — koi aur try karo."); return; }

  const { error } = await sb.from("users").update({ username: trimmed }).eq("id", CURRENT_USER.id);
  if (error) { alert("Rename fail hua: " + error.message); return; }

  CURRENT_USER.username = trimmed;
  renderIdentity();
  loadFeed();
}

// ------------------------------------------------------------
// 5. Titles are assigned only by the moderator via admin.html —
// no self-serve picker here. Titles just render wherever a user
// row already has one set (see postTemplate / loadComments).
// ------------------------------------------------------------

// ------------------------------------------------------------
// 6. Embed detection
// ------------------------------------------------------------
function detectEmbed(text) {
  const yt = text.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{6,})/);
  if (yt) return { type: "youtube", id: yt[1], url: yt[0] };

  const ig = text.match(/instagram\.com\/(?:p|reel)\/([a-zA-Z0-9_-]+)/);
  if (ig) return { type: "instagram", url: text.match(/https?:\/\/[^\s]*instagram\.com\/[^\s]+/)?.[0] };

  const x = text.match(/(?:x\.com|twitter\.com)\/[^\s/]+\/status\/(\d+)/);
  if (x) return { type: "x", id: x[1], url: text.match(/https?:\/\/[^\s]*(?:x\.com|twitter\.com)\/[^\s]+/)?.[0] };

  const fb = text.match(/facebook\.com\/[^\s]+/);
  if (fb) return { type: "facebook", url: "https://" + fb[0] };

  return null;
}

function renderEmbed(embed_type, embed_url) {
  if (!embed_type || !embed_url) return "";
  if (embed_type === "youtube") {
    const idMatch = embed_url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{6,})/);
    const id = idMatch ? idMatch[1] : "";
    return `<div class="embed-wrap"><iframe height="315" src="https://www.youtube.com/embed/${id}" allowfullscreen></iframe></div>`;
  }
  if (embed_type === "instagram") {
    return `<div class="embed-wrap"><blockquote class="instagram-media" data-instgrm-permalink="${embed_url}" style="margin:0;width:100%;"></blockquote></div>`;
  }
  if (embed_type === "x") {
    return `<div class="embed-wrap"><blockquote class="twitter-tweet"><a href="${embed_url}"></a></blockquote></div>`;
  }
  if (embed_type === "facebook") {
    return `<div class="embed-wrap"><iframe height="300" src="https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(embed_url)}&show_text=true" scrolling="no" frameborder="0"></iframe></div>`;
  }
  return "";
}

function reRunSocialEmbedScripts() {
  if (window.instgrm) window.instgrm.Embeds.process();
  if (window.twttr) window.twttr.widgets.load();
}

// ------------------------------------------------------------
// 7. Posting
// ------------------------------------------------------------
const textarea = document.getElementById("postText");
const charCount = document.getElementById("charCount");

textarea.addEventListener("input", () => {
  const words = textarea.value.trim().split(/\s+/).filter(Boolean).length;
  charCount.textContent = `${words} / ${WORD_LIMIT}`;
  charCount.className = "char-count" + (words > WORD_LIMIT ? " over" : words > WORD_LIMIT - 20 ? " warn" : "");
  document.getElementById("postBtn").disabled = IS_BLOCKED || words === 0 || words > WORD_LIMIT;
});

function containsBannedWord(text) {
  const lower = text.toLowerCase();
  return BANNED_WORDS.some(w => lower.includes(w));
}

// ------------------------------------------------------------
// 7b. @mention autocomplete in the composer
// ------------------------------------------------------------
function setupMentionAutocomplete() {
  const box = document.createElement("div");
  box.id = "mentionBox";
  box.style.cssText = "display:none;position:relative;background:var(--panel-2);border:1px solid var(--border);border-radius:10px;margin-top:6px;overflow:hidden;";
  textarea.parentNode.insertBefore(box, textarea.nextSibling);

  textarea.addEventListener("input", () => {
    const caret = textarea.selectionStart;
    const upToCaret = textarea.value.slice(0, caret);
    const match = upToCaret.match(/@(\w*)$/);
    if (!match) { box.style.display = "none"; return; }
    const query = match[1].toLowerCase();
    const matches = ALL_USERNAMES.filter(u => u.toLowerCase().startsWith(query) && query.length > 0).slice(0, 5);
    if (matches.length === 0) { box.style.display = "none"; return; }
    box.innerHTML = matches.map(u => `<div class="mention-opt" style="padding:8px 12px;cursor:pointer;font-size:13px;" data-u="${u}">@${u}</div>`).join("");
    box.style.display = "block";
    box.querySelectorAll(".mention-opt").forEach(el => {
      el.addEventListener("click", () => {
        const before = textarea.value.slice(0, caret).replace(/@(\w*)$/, "@" + el.dataset.u + " ");
        const after = textarea.value.slice(caret);
        textarea.value = before + after;
        box.style.display = "none";
        textarea.focus();
        textarea.dispatchEvent(new Event("input"));
      });
    });
  });

  document.addEventListener("click", (e) => {
    if (e.target !== textarea && !box.contains(e.target)) box.style.display = "none";
  });
}

function highlightMentions(escapedText) {
  return escapedText.replace(/@(\w+)/g, (match, name) => {
    const known = ALL_USERNAMES.some(u => u.toLowerCase() === name.toLowerCase());
    return known ? `<span style="color:var(--accent);font-weight:600;">@${name}</span>` : match;
  });
}

document.getElementById("postBtn").addEventListener("click", async () => {
  const text = textarea.value.trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  if (!text || words > WORD_LIMIT || IS_BLOCKED) return;

  if (containsBannedWord(text)) {
    alert("Ye post mein aisa word hai jo yahan allowed nahi hai.");
    return;
  }

  const embed = detectEmbed(text);
  const { error } = await sb.from("posts").insert({
    user_id: CURRENT_USER.id,
    content: text,
    embed_type: embed?.type || null,
    embed_url: embed?.url || null
  });
  if (error) { alert("Post fail hua: " + error.message); return; }

  textarea.value = "";
  charCount.textContent = `0 / ${WORD_LIMIT}`;
  await sb.from("users").update({ post_count: (CURRENT_USER.post_count || 0) + 1 }).eq("id", CURRENT_USER.id);
  loadFeed();
});

// ------------------------------------------------------------
// 8. Feed rendering
// ------------------------------------------------------------
async function loadFeed() {
  const cutoff = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  const { data: posts, error } = await sb
    .from("posts")
    .select("*, users(id, username, title, title_color)")
    .or(`created_at.gt.${cutoff},pinned.eq.true`)
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) { console.error(error); return; }

  const { data: myLikes } = await sb.from("likes").select("post_id, reaction_type").eq("user_id", CURRENT_USER.id);
  const myReactionMap = {};
  (myLikes || []).forEach(l => { myReactionMap[l.post_id] = l.reaction_type; });

  const { data: myFollows } = await sb.from("follows").select("followee_id").eq("follower_id", CURRENT_USER.id);
  const followingSet = new Set((myFollows || []).map(f => f.followee_id));

  // comment counts for all visible posts, in one query
  const commentCounts = {};
  if (posts && posts.length) {
    const { data: allComments } = await sb
      .from("comments")
      .select("post_id")
      .in("post_id", posts.map(p => p.id));
    (allComments || []).forEach(c => {
      commentCounts[c.post_id] = (commentCounts[c.post_id] || 0) + 1;
    });
  }

  const feed = document.getElementById("feed");
  if (!posts || posts.length === 0) {
    feed.innerHTML = `<div class="empty-state">Abhi koi post nahi hai. Sabse pehle post karo!</div>`;
    return;
  }

  feed.innerHTML = posts.map(p => postTemplate(p, myReactionMap[p.id], commentCounts[p.id] || 0, followingSet.has(p.user_id))).join("");
  reRunSocialEmbedScripts();

  posts.forEach(p => attachPostHandlers(p.id));
}

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "abhi";
  if (diff < 3600) return Math.floor(diff / 60) + "m";
  if (diff < 86400) return Math.floor(diff / 3600) + "h";
  return Math.floor(diff / 86400) + "d";
}

function vanishIn(iso) {
  const deleteAt = new Date(iso).getTime() + 36 * 3600 * 1000;
  const remaining = (deleteAt - Date.now()) / 1000;
  if (remaining <= 0) return "abhi delete ho raha hai";
  const h = Math.floor(remaining / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  return h > 0 ? `${h}h ${m}m me gayab` : `${m}m me gayab`;
}

function postTemplate(p, myReaction, commentCount, isFollowing) {
  const u = p.users;
  const titleBadge = u.title
    ? `<span class="title-badge ${u.title === "God" ? "violet" : "grey"}">${u.title}</span>`
    : "";
  const pinBadge = p.pinned ? `<span class="title-badge" style="color:var(--gold);border-color:var(--gold);">📌 Pinned</span>` : "";
  const counts = p.reaction_counts || {};
  const totalReactions = Object.values(counts).reduce((a, b) => a + (b || 0), 0);
  const trendingBadge = (totalReactions + commentCount) >= TRENDING_THRESHOLD
    ? `<span class="title-badge" style="color:#ff7a45;border-color:#ff7a45;">🔥 Trending</span>` : "";
  const vanishNote = p.pinned ? "" : `<span class="timestamp"> · ${vanishIn(p.created_at)}</span>`;
  const deleteBtn = CURRENT_USER.is_moderator
    ? `<div class="action delete-btn" data-id="${p.id}" style="margin-left:auto;color:var(--danger);">🗑 Delete</div>`
    : "";
  const pinBtn = CURRENT_USER.is_moderator
    ? `<div class="action pin-btn" data-id="${p.id}" data-pinned="${p.pinned}">📌 ${p.pinned ? "Unpin" : "Pin"}</div>`
    : "";
  const followBtn = u.id === CURRENT_USER.id ? "" : `
    <span class="follow-btn" data-id="${u.id}" data-following="${isFollowing}" style="font-size:11px;font-weight:700;padding:2px 10px;border-radius:999px;cursor:pointer;margin-left:4px;
      ${isFollowing ? "border:1px solid var(--border);color:var(--text-dim);" : "background:var(--accent-grad);color:#fff;"}">
      ${isFollowing ? "Following" : "+ Follow"}
    </span>`;
  const myEmoji = myReaction ? REACTIONS.find(r => r.key === myReaction)?.emoji : "❤";
  const breakdown = REACTIONS.filter(r => counts[r.key] > 0).map(r => `${r.emoji}${counts[r.key]}`).join(" ");

  return `
  <div class="post" data-id="${p.id}">
    <a href="profile.html?u=${u.id}" style="text-decoration:none;">
      <div class="avatar" style="background:${avatarGradient(u.username)};">${u.username[0].toUpperCase()}</div>
    </a>
    <div class="post-body">
      <div class="post-head">
        <a href="profile.html?u=${u.id}" style="text-decoration:none;color:inherit;"><span class="username">${escapeHtml(u.username)}</span></a>
        ${followBtn}
        ${titleBadge}
        ${pinBadge}
        ${trendingBadge}
        <span class="timestamp">· ${timeAgo(p.created_at)}</span>
        ${vanishNote}
      </div>
      <div class="post-content">${highlightMentions(escapeHtml(p.content))}</div>
      ${renderEmbed(p.embed_type, p.embed_url)}
      <div class="post-actions" style="position:relative;">
        <div class="action reaction-btn ${myReaction ? "liked" : ""}" data-id="${p.id}">
          ${myEmoji} <span class="reaction-total">${totalReactions}</span>
          ${breakdown ? `<span class="timestamp" style="margin-left:4px;">${breakdown}</span>` : ""}
        </div>
        <div class="reaction-picker" id="picker-${p.id}" style="display:none;position:absolute;bottom:32px;left:0;background:var(--panel-2);border:1px solid var(--border);border-radius:999px;padding:6px 10px;gap:10px;box-shadow:0 8px 24px -8px #000a;z-index:5;">
          ${REACTIONS.map(r => `<span class="reaction-opt" data-type="${r.key}" data-id="${p.id}" style="cursor:pointer;font-size:18px;margin:0 4px;">${r.emoji}</span>`).join("")}
        </div>
        <div class="action comment-toggle" data-id="${p.id}">💬 <span class="comment-count-${p.id}">${commentCount}</span></div>
        <div class="action share-btn" data-id="${p.id}">↗ Share</div>
        ${pinBtn}
        ${deleteBtn}
      </div>
      <div class="comments" id="comments-${p.id}" style="display:none;"></div>
    </div>
  </div>`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

const AVATAR_PALETTE = [
  ["#7c5cff", "#ff5cad"], ["#ff8a5c", "#ff5c8a"], ["#5cffb0", "#5c9aff"],
  ["#ffd15c", "#ff5c5c"], ["#5cffe8", "#7c5cff"], ["#c65cff", "#5c8aff"],
  ["#ff5c94", "#ffb15c"], ["#5cff8a", "#5cd1ff"]
];
function avatarGradient(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i++) hash = username.charCodeAt(i) + ((hash << 5) - hash);
  const [c1, c2] = AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
  return `linear-gradient(135deg, ${c1}, ${c2})`;
}

function attachPostHandlers(postId) {
  const postEl = document.querySelector(`.post[data-id="${postId}"]`);
  if (!postEl) return;

  const reactionBtn = postEl.querySelector(".reaction-btn");
  const picker = postEl.querySelector(".reaction-picker");
  if (reactionBtn && picker) {
    reactionBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".reaction-picker").forEach(p => { if (p !== picker) p.style.display = "none"; });
      picker.style.display = picker.style.display === "none" ? "flex" : "none";
    });
    picker.querySelectorAll(".reaction-opt").forEach(opt => {
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        setReaction(postId, opt.dataset.type);
        picker.style.display = "none";
      });
    });
  }

  postEl.querySelector(".comment-toggle").addEventListener("click", () => toggleComments(postId));
  postEl.querySelector(".share-btn").addEventListener("click", () => sharePost(postId));

  const followBtn = postEl.querySelector(".follow-btn");
  if (followBtn) followBtn.addEventListener("click", () => toggleFollow(followBtn.dataset.id, followBtn.dataset.following === "true"));

  const delBtn = postEl.querySelector(".delete-btn");
  if (delBtn) delBtn.addEventListener("click", () => deletePost(postId));

  const pinBtn = postEl.querySelector(".pin-btn");
  if (pinBtn) pinBtn.addEventListener("click", () => togglePin(postId, pinBtn.dataset.pinned === "true"));
}

document.addEventListener("click", () => {
  document.querySelectorAll(".reaction-picker").forEach(p => p.style.display = "none");
});

async function toggleFollow(targetUserId, currentlyFollowing) {
  let error;
  if (currentlyFollowing) {
    ({ error } = await sb.from("follows").delete().eq("follower_id", CURRENT_USER.id).eq("followee_id", targetUserId));
  } else {
    ({ error } = await sb.from("follows").insert({ follower_id: CURRENT_USER.id, followee_id: targetUserId }));
  }
  if (error) { alert("Follow fail hua: " + error.message); return; }
  loadFeed();
}

async function togglePin(postId, currentlyPinned) {
  if (!CURRENT_USER.is_moderator) return;
  const { error } = await sb.from("posts").update({ pinned: !currentlyPinned }).eq("id", postId);
  if (error) { alert("Pin update fail hua: " + error.message); return; }
  loadFeed();
}

async function deletePost(postId) {
  if (!CURRENT_USER.is_moderator) return;
  if (!confirm("Ye post permanently delete karni hai?")) return;
  const { error } = await sb.from("posts").delete().eq("id", postId);
  if (error) { alert("Delete fail hua: " + error.message); return; }
  loadFeed();
}

async function setReaction(postId, type) {
  if (IS_BLOCKED) { alert("Aap block hain, react nahi kar sakte."); return; }

  const { data: existing } = await sb.from("likes").select("*").eq("post_id", postId).eq("user_id", CURRENT_USER.id).maybeSingle();

  let error;
  if (existing && existing.reaction_type === type) {
    // same reaction tapped again -> remove it
    ({ error } = await sb.from("likes").delete().eq("id", existing.id));
  } else if (existing) {
    // switch to a different reaction
    ({ error } = await sb.from("likes").update({ reaction_type: type }).eq("id", existing.id));
  } else {
    ({ error } = await sb.from("likes").insert({ post_id: postId, user_id: CURRENT_USER.id, reaction_type: type }));
  }
  if (error) { alert("Reaction save nahi hui: " + error.message); return; }
  loadFeed();
}

async function sharePost(postId) {
  const url = `${location.origin}${location.pathname}?post=${postId}`;
  if (navigator.share) {
    navigator.share({ url }).catch(() => {});
  } else {
    await navigator.clipboard.writeText(url);
    alert("Link copy ho gaya!");
  }
}

// ------------------------------------------------------------
// 9. Comments + replies
// ------------------------------------------------------------
async function toggleComments(postId) {
  const box = document.getElementById(`comments-${postId}`);
  const open = box.style.display !== "none";
  box.style.display = open ? "none" : "block";
  if (!open) await loadComments(postId);
}

async function loadComments(postId) {
  const box = document.getElementById(`comments-${postId}`);
  const { data: comments } = await sb
    .from("comments")
    .select("*, users(id, username, title, title_color)")
    .eq("post_id", postId)
    .order("created_at", { ascending: true });

  document.querySelector(`.comment-count-${postId}`).textContent = comments?.length || 0;

  box.innerHTML = (comments || []).map(c => `
    <div class="comment">
      <div class="avatar" style="background:${avatarGradient(c.users.username)};">${c.users.username[0].toUpperCase()}</div>
      <div>
        <span class="username">${escapeHtml(c.users.username)}</span>
        <span class="timestamp">· ${timeAgo(c.created_at)}</span>
        <div>${highlightMentions(escapeHtml(c.content))}</div>
        <span class="reply-link" data-parent="${c.id}">Reply</span>
      </div>
    </div>
  `).join("") + `
    <div class="comment-input-row">
      <input type="text" placeholder="Comment likho..." id="input-${postId}" />
      <button class="btn small" id="send-${postId}">Send</button>
    </div>
  `;

  document.getElementById(`send-${postId}`).addEventListener("click", () => submitComment(postId, null));
  box.querySelectorAll(".reply-link").forEach(el => {
    el.addEventListener("click", () => {
      const input = document.getElementById(`input-${postId}`);
      input.focus();
      input.dataset.replyTo = el.dataset.parent;
      input.placeholder = "Reply likho...";
    });
  });
}

async function submitComment(postId) {
  const input = document.getElementById(`input-${postId}`);
  const text = input.value.trim();
  if (!text) return;
  if (IS_BLOCKED) { alert("Aap block hain, comment nahi kar sakte."); return; }
  if (containsBannedWord(text)) { alert("Ye comment mein aisa word hai jo yahan allowed nahi hai."); return; }
  const parentId = input.dataset.replyTo || null;

  const { error } = await sb.from("comments").insert({
    post_id: postId, user_id: CURRENT_USER.id, content: text, parent_comment_id: parentId
  });
  if (error) { alert("Comment fail hua: " + error.message); return; }
  input.value = "";
  delete input.dataset.replyTo;
  input.placeholder = "Comment likho...";
  await loadComments(postId);
}

// ------------------------------------------------------------
// 10. Live visitor presence (visible count for everyone;
// the detailed list is moderator-only, see admin.html)
// ------------------------------------------------------------
function setupPresence() {
  const channel = sb.channel("live-visitors", {
    config: { presence: { key: CURRENT_USER.fingerprint } }
  });

  channel
    .on("presence", { event: "sync" }, () => {
      const count = Object.keys(channel.presenceState()).length;
      document.getElementById("visitorCount").textContent = count;
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ username: CURRENT_USER.username, ip: CURRENT_USER.ip, online_at: new Date().toISOString() });
      }
    });
}

// ------------------------------------------------------------
// 10b. Realtime — auto-refresh feed the moment anything changes,
// no manual reload needed
// ------------------------------------------------------------
function setupRealtime() {
  sb.channel("db-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "posts" }, loadFeed)
    .on("postgres_changes", { event: "*", schema: "public", table: "likes" }, loadFeed)
    .on("postgres_changes", { event: "*", schema: "public", table: "follows" }, loadFeed)
    .on("postgres_changes", { event: "*", schema: "public", table: "comments" }, () => {
      loadFeed();
      // if a comment box is currently open, refresh it too
      document.querySelectorAll(".comments").forEach(box => {
        if (box.style.display !== "none") {
          const postId = box.id.replace("comments-", "");
          loadComments(postId);
        }
      });
    })
    .subscribe();
}

// ------------------------------------------------------------
// Boot
// ------------------------------------------------------------
(async function boot() {
  await initUser();
  document.getElementById("editUsernameBtn").addEventListener("click", renameUsername);
  setupMentionAutocomplete();
  await loadFeed();
  setupPresence();
  setupRealtime();
})();
