// ============================================================
// CONFIG — fill these in from your Supabase project settings
// (Project Settings -> API). The anon/public key is safe to
// expose in client code; it only allows what RLS policies permit.
// ============================================================
const SUPABASE_URL = "https://bfzigmdfgvoedqmfzmub.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_s-aORJHy624eU2s1qzuAqA_3s1xK51R";

// Optional: proxycheck.io API key for VPN/proxy detection.
// Works without a key at a low rate limit; sign up free for more.
const PROXYCHECK_API_KEY = "";

const WORD_LIMIT = 250;
const TITLES = ["King", "Queen", "Joker", "Knight", "Demon Lord", "Demon Knight", "Demon Queen", "Slave", "Angel", "Trump"];

// ============================================================
// Supabase client (loaded via CDN script tag in index.html)
// ============================================================
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let CURRENT_USER = null;   // row from `users` table
let IS_BLOCKED = false;

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
  IS_BLOCKED = incognito || vpn;

  let { data: existing } = await sb.from("users").select("*").eq("fingerprint", fp).maybeSingle();

  if (existing) {
    CURRENT_USER = existing;
    await sb.from("users").update({ last_seen: new Date().toISOString(), ip, is_blocked: IS_BLOCKED }).eq("id", existing.id);
  } else {
    const randomName = "Guest" + Math.floor(1000 + Math.random() * 9000);
    const { data: created, error } = await sb.from("users").insert({
      fingerprint: fp, ip, username: randomName, is_blocked: IS_BLOCKED
    }).select().single();
    if (error) { console.error(error); return; }
    CURRENT_USER = created;
  }

  renderIdentity();
}

function renderIdentity() {
  const el = document.getElementById("blockedBanner");
  if (IS_BLOCKED) {
    el.style.display = "block";
    el.textContent = "VPN ya incognito mode detect hua — is se aap post nahi kar sakte. Normal browsing mode aur bina VPN ke try karein.";
    document.getElementById("postBtn").disabled = true;
  } else {
    el.style.display = "none";
    document.getElementById("postBtn").disabled = false;
  }
  document.getElementById("whoami").textContent = CURRENT_USER.username;
  const fpEl = document.getElementById("fpDisplay");
  if (fpEl) fpEl.textContent = CURRENT_USER.fingerprint;
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

document.getElementById("postBtn").addEventListener("click", async () => {
  const text = textarea.value.trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  if (!text || words > WORD_LIMIT || IS_BLOCKED) return;

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
    .select("*, users(username, title, title_color)")
    .gt("created_at", cutoff)
    .order("created_at", { ascending: false });

  if (error) { console.error(error); return; }

  const { data: myLikes } = await sb.from("likes").select("post_id").eq("user_id", CURRENT_USER.id);
  const likedSet = new Set((myLikes || []).map(l => l.post_id));

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

  feed.innerHTML = posts.map(p => postTemplate(p, likedSet.has(p.id), commentCounts[p.id] || 0)).join("");
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

function postTemplate(p, liked, commentCount) {
  const u = p.users;
  const titleBadge = u.title
    ? `<span class="title-badge ${u.title === "God" ? "violet" : "grey"}">${u.title}</span>`
    : "";
  const deleteBtn = CURRENT_USER.is_moderator
    ? `<div class="action delete-btn" data-id="${p.id}" style="margin-left:auto;color:var(--danger);">🗑 Delete</div>`
    : "";
  return `
  <div class="post" data-id="${p.id}">
    <div class="avatar">${u.username[0].toUpperCase()}</div>
    <div class="post-body">
      <div class="post-head">
        <span class="username">${escapeHtml(u.username)}</span>
        ${titleBadge}
        <span class="timestamp">· ${timeAgo(p.created_at)}</span>
      </div>
      <div class="post-content">${escapeHtml(p.content)}</div>
      ${renderEmbed(p.embed_type, p.embed_url)}
      <div class="post-actions">
        <div class="action like-btn ${liked ? "liked" : ""}" data-id="${p.id}">
          ❤ <span class="like-count">${p.like_count || 0}</span>
        </div>
        <div class="action comment-toggle" data-id="${p.id}">💬 <span class="comment-count-${p.id}">${commentCount}</span></div>
        <div class="action share-btn" data-id="${p.id}">↗ Share</div>
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

function attachPostHandlers(postId) {
  const postEl = document.querySelector(`.post[data-id="${postId}"]`);
  if (!postEl) return;

  postEl.querySelector(".like-btn").addEventListener("click", () => toggleLike(postId));
  postEl.querySelector(".comment-toggle").addEventListener("click", () => toggleComments(postId));
  postEl.querySelector(".share-btn").addEventListener("click", () => sharePost(postId));

  const delBtn = postEl.querySelector(".delete-btn");
  if (delBtn) delBtn.addEventListener("click", () => deletePost(postId));
}

async function deletePost(postId) {
  if (!CURRENT_USER.is_moderator) return;
  if (!confirm("Ye post permanently delete karni hai?")) return;
  const { error } = await sb.from("posts").delete().eq("id", postId);
  if (error) { alert("Delete fail hua: " + error.message); return; }
  loadFeed();
}

async function toggleLike(postId) {
  const btn = document.querySelector(`.post[data-id="${postId}"] .like-btn`);
  const isLiked = btn.classList.contains("liked");
  if (isLiked) {
    const { error } = await sb.from("likes").delete().eq("post_id", postId).eq("user_id", CURRENT_USER.id);
    if (error) { alert("Unlike fail hua: " + error.message); return; }
    btn.classList.remove("liked");
    btn.querySelector(".like-count").textContent = Math.max(0, parseInt(btn.querySelector(".like-count").textContent) - 1);
  } else {
    const { error } = await sb.from("likes").insert({ post_id: postId, user_id: CURRENT_USER.id });
    if (error) { alert("Like save nahi hua: " + error.message); return; }
    btn.classList.add("liked");
    btn.querySelector(".like-count").textContent = parseInt(btn.querySelector(".like-count").textContent) + 1;
  }
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
    .select("*, users(username, title, title_color)")
    .eq("post_id", postId)
    .order("created_at", { ascending: true });

  document.querySelector(`.comment-count-${postId}`).textContent = comments?.length || 0;

  box.innerHTML = (comments || []).map(c => `
    <div class="comment">
      <div class="avatar">${c.users.username[0].toUpperCase()}</div>
      <div>
        <span class="username">${escapeHtml(c.users.username)}</span>
        <span class="timestamp">· ${timeAgo(c.created_at)}</span>
        <div>${escapeHtml(c.content)}</div>
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
  const parentId = input.dataset.replyTo || null;

  await sb.from("comments").insert({
    post_id: postId, user_id: CURRENT_USER.id, content: text, parent_comment_id: parentId
  });
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
  await loadFeed();
  setupPresence();
  setupRealtime();
})();
