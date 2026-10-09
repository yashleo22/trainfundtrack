/* ============================================================
   Train Fund Tracker — Cloudflare Worker (save/login proxy)
   ------------------------------------------------------------
   Holds the GitHub token + passwords as server-side SECRETS so
   they never reach the browser or the public repo.

   Endpoints:
     POST /api/login  {username,password}  -> {token, role, username}
     GET  /api/data                        -> current data.json (fresh)
     POST /api/save   {data}  (Bearer tok) -> commits data.json to GitHub

   Secrets (set with `wrangler secret put <NAME>`):
     GITHUB_TOKEN     fine-grained token, Contents: Read & Write, this repo only
     ADMIN_PASSWORD   password for the "admin" login
     MOHIT_PASSWORD   password for the "mohit" login
     SESSION_SECRET   any long random string (signs session tokens)

   Vars (in wrangler.toml [vars]):
     GH_OWNER, GH_REPO, GH_BRANCH, GH_PATH, ALLOWED_ORIGIN
   ============================================================ */

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/login" && request.method === "POST") {
        const { username, password } = await request.json();
        const role = checkCreds(username, password, env);
        if (!role) return json({ error: "Invalid username or password" }, 401, cors);
        const uname = (username || "").toLowerCase().trim();
        const token = await makeToken(role, uname, env.SESSION_SECRET);
        return json({ token, role, username: uname }, 200, cors);
      }

      if (url.pathname === "/api/data" && request.method === "GET") {
        const { content } = await ghGet(env);
        return new Response(content, {
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }

      if (url.pathname === "/api/save" && request.method === "POST") {
        const auth = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
        const session = await verifyToken(auth, env.SESSION_SECRET);
        if (!session) return json({ error: "Not authenticated" }, 401, cors);
        const body = await request.json();
        if (!body || typeof body.data !== "object") return json({ error: "Missing data" }, 400, cors);
        const dataStr = JSON.stringify(body.data, null, 2) + "\n";
        const res = await ghPut(env, dataStr, `Update data.json via ${session.user} (${new Date().toISOString()})`);
        return json({ ok: true, commit: res.commit && res.commit.sha }, 200, cors);
      }

      return json({ error: "Not found" }, 404, cors);
    } catch (e) {
      return json({ error: e.message || String(e) }, 500, cors);
    }
  },
};

/* ---- credentials ---- */
function checkCreds(u, p, env) {
  u = (u || "").toLowerCase().trim();
  if (u === "admin" && p === env.ADMIN_PASSWORD) return "admin";
  if (u === "mohit" && p === env.MOHIT_PASSWORD) return "guest";
  return null;
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

/* ---- GitHub Contents API ---- */
function ghUrl(env) {
  return `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${env.GH_PATH}`;
}
function ghHeaders(env) {
  return {
    Authorization: "Bearer " + env.GITHUB_TOKEN,
    Accept: "application/vnd.github+json",
    "User-Agent": "trainfundtrack-worker",
  };
}
async function ghGet(env) {
  const r = await fetch(ghUrl(env) + "?ref=" + encodeURIComponent(env.GH_BRANCH), { headers: ghHeaders(env) });
  if (r.status === 404) return { content: "{}", sha: null };
  if (!r.ok) throw new Error("GitHub read failed (" + r.status + "): " + (await r.text()));
  const j = await r.json();
  return { content: decodeB64(j.content), sha: j.sha };
}
async function ghPut(env, contentStr, message) {
  // fetch latest sha right before writing (last-write-wins)
  let sha;
  const cur = await fetch(ghUrl(env) + "?ref=" + encodeURIComponent(env.GH_BRANCH), { headers: ghHeaders(env) });
  if (cur.ok) sha = (await cur.json()).sha;
  const body = { message, content: encodeB64(contentStr), branch: env.GH_BRANCH };
  if (sha) body.sha = sha;
  const r = await fetch(ghUrl(env), { method: "PUT", headers: ghHeaders(env), body: JSON.stringify(body) });
  if (!r.ok) throw new Error("GitHub write failed (" + r.status + "): " + (await r.text()));
  return r.json();
}

/* ---- base64 (UTF-8 safe, chunked) ---- */
function encodeB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
function decodeB64(b64) {
  const bin = atob((b64 || "").replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/* ---- signed session tokens (HMAC-SHA256) ---- */
async function makeToken(role, user, secret) {
  const payload = b64url(JSON.stringify({ role, user, exp: Date.now() + 1000 * 60 * 60 * 12 }));
  const sig = await hmac(payload, secret);
  return payload + "." + sig;
}
async function verifyToken(token, secret) {
  if (!token || token.indexOf(".") < 0) return null;
  const [payload, sig] = token.split(".");
  if (sig !== (await hmac(payload, secret))) return null;
  let data;
  try { data = JSON.parse(ub64url(payload)); } catch { return null; }
  if (!data || Date.now() > data.exp) return null;
  return data;
}
async function hmac(msg, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return b64urlBytes(new Uint8Array(sig));
}
function b64url(str) { return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function ub64url(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); return decodeURIComponent(escape(atob(s))); }
function b64urlBytes(bytes) { let b = ""; for (const x of bytes) b += String.fromCharCode(x); return btoa(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
