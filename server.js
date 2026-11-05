require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.set("trust proxy", 1); // Railway sits behind a proxy; without this every visitor shares one rate-limit bucket.
app.use(helmet({ contentSecurityPolicy: false }));

const required = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const missing = required.filter(k => !process.env[k]);
if (missing.length) console.warn("Missing environment values:", missing.join(", "));
const adminDb = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;
const authDb = process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } })
  : null;

async function userFromRequest(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || !authDb) return null;
  const { data, error } = await authDb.auth.getUser(token);
  return error ? null : data.user;
}
async function requireUser(req, res, next) {
  const user = await userFromRequest(req);
  if (!user) return res.status(401).json({ error: "Sign in required." });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  const allowed = (process.env.ADMIN_EMAILS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!req.user || !allowed.includes((req.user.email || "").toLowerCase())) {
    return res.status(403).json({ error: "Administrator access required." });
  }
  next();
}
// ---------------------------------------------------------------------------
// Provider webhooks. These MUST be registered before express.json(): signature
// checks need the exact raw bytes the provider sent.
// ---------------------------------------------------------------------------
const PAYSTACK_BASE = "https://api.paystack.co";
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
async function paystack(method, pathname, body) {
  if (!process.env.PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY is not set.");
  const r = await fetch(PAYSTACK_BASE + pathname, {
    method,
    headers: { Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== true) throw new Error(j.message || "Paystack request failed (" + r.status + ")");
  return j.data;
}
// Ask Paystack directly whether a reference was paid, check amount/currency against OUR record, then settle once.
async function confirmAndSettle(reference) {
  const { data: c } = await adminDb.from("contributions").select("*").eq("reference", reference).maybeSingle();
  if (!c) return { status: "unknown" };
  if (c.status === "success") return { status: "success", contribution: c };
  const tx = await paystack("GET", "/transaction/verify/" + encodeURIComponent(reference));
  if (tx.status === "success") {
    if (Number(tx.amount) !== Number(c.amount_minor) || String(tx.currency).toUpperCase() !== c.currency) {
      await adminDb.from("audit_events").insert({ actor_id: c.user_id, request_id: c.request_id, event_type: "contribution_mismatch", details: { reference, paid: tx.amount, expected: c.amount_minor } });
      return { status: "mismatch" };
    }
    const { error } = await adminDb.rpc("settle_contribution", { p_reference: reference, p_channel: tx.channel || null });
    if (error) throw error;
    return { status: "success" };
  }
  if (["failed", "abandoned", "reversed"].includes(tx.status)) {
    await adminDb.from("contributions").update({ status: tx.status === "abandoned" ? "abandoned" : "failed" }).eq("reference", reference).eq("status", "pending");
  }
  return { status: tx.status };
}

app.post("/api/webhooks/paystack", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  try {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const sig = req.headers["x-paystack-signature"];
    if (!secret || !sig || !Buffer.isBuffer(req.body)) return res.sendStatus(401);
    const expected = crypto.createHmac("sha512", secret).update(req.body).digest("hex");
    if (!safeEqual(expected, sig)) return res.sendStatus(401);
    const event = JSON.parse(req.body.toString("utf8"));
    if (event.event === "charge.success" && event.data && event.data.reference && adminDb) {
      await confirmAndSettle(event.data.reference);
    }
    res.sendStatus(200); // always 200 for authentic events so Paystack stops retrying
  } catch (e) {
    console.error("Paystack webhook error:", e.message);
    res.sendStatus(500); // let Paystack retry
  }
});

// Dojah (face + ID verification) webhook. Signature = HMAC-SHA256 of the JSON body with your Dojah secret key.
function findKey(obj, key, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 5) return undefined;
  if (obj[key] !== undefined) return obj[key];
  for (const v of Object.values(obj)) { const f = findKey(v, key, depth + 1); if (f !== undefined) return f; }
  return undefined;
}
function mapDojahStatus(p) {
  const s = p.status !== undefined ? p.status : findKey(p, "status");
  if (s === true) return "verified";
  if (s === false) return "failed";
  const t = String(s || "").toLowerCase();
  if (/fail|reject|declin|denied/.test(t)) return "failed";
  if (/success|complete|verified|approved/.test(t)) return "verified";
  return "manual_review"; // anything unclear goes to a human, never auto-approved
}
app.post("/api/webhooks/dojah", express.raw({ type: "*/*", limit: "5mb" }), async (req, res) => {
  try {
    const secret = process.env.DOJAH_SECRET_KEY;
    const sig = req.headers["x-dojah-signature"];
    if (!secret || !sig || !Buffer.isBuffer(req.body) || !adminDb) return res.sendStatus(401);
    const rawHex = crypto.createHmac("sha256", secret).update(req.body).digest("hex");
    const payload = JSON.parse(req.body.toString("utf8"));
    const jsonHex = crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
    if (!safeEqual(rawHex, sig) && !safeEqual(jsonHex, sig)) return res.sendStatus(401);
    const reference = findKey(payload, "reference_id");
    if (!reference) return res.sendStatus(200);
    const status = mapDojahStatus(payload);
    // Store ONLY the outcome. Never save selfies, ID images or ID numbers from the payload.
    const patch = { status, updated_at: new Date().toISOString() };
    if (status === "verified") patch.verified_at = new Date().toISOString();
    const { error } = await adminDb.from("identity_verifications").update(patch).eq("provider", "dojah").eq("provider_reference", String(reference));
    if (error) throw error;
    res.sendStatus(200);
  } catch (e) {
    console.error("Dojah webhook error:", e.message);
    res.sendStatus(500);
  }
});

app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, "public")));

const usernameLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 12, standardHeaders: true, legacyHeaders: false });
const assistantLimiter = rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: true, legacyHeaders: false });

// Username availability is checked server-side; email addresses are never returned.
app.post("/api/auth/username-available", usernameLimiter, async (req, res) => {
  const username = String(req.body?.username || "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: "Use 3–20 letters, numbers or underscores for your username." });
  if (!adminDb) return res.status(503).json({ error: "Account service is not configured." });
  const { data, error } = await adminDb.from("profiles").select("id").eq("username", username).limit(1);
  if (error) {
    console.error("username availability query failed", { code: error.code, message: error.message });
    return res.status(503).json({ error: "Username checking is temporarily unavailable." });
  }
  res.json({ available: !data?.length });
});

// Supabase password sign-in accepts email/phone. This adapter resolves a username
// privately on the server, then returns only the resulting session to the caller.
app.post("/api/auth/username-login", usernameLimiter, async (req, res) => {
  const username = String(req.body?.username || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!/^[a-z0-9_]{3,20}$/.test(username) || !password) return res.status(400).json({ error: "Enter a valid username and password." });
  if (!adminDb || !authDb) return res.status(503).json({ error: "Account service is not configured." });
  try {
    const { data: profile, error: profileError } = await adminDb.from("profiles").select("id").eq("username", username).maybeSingle();
    if (profileError || !profile) return res.status(401).json({ error: "Invalid username or password." });
    const { data: userData, error: userError } = await adminDb.auth.admin.getUserById(profile.id);
    const email = userData?.user?.email;
    if (userError || !email) return res.status(401).json({ error: "Invalid username or password." });
    const { data, error } = await authDb.auth.signInWithPassword({ email, password });
    if (error || !data.session) return res.status(401).json({ error: "Invalid username or password. Check your email confirmation if this is a new account." });
    res.json({ session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token } });
  } catch (error) {
    console.error("username login failed", { message: error.message });
    res.status(503).json({ error: "Username sign-in is temporarily unavailable." });
  }
});

// Prompt-based Uplivanta assistant. The provider key stays server-side and is never
// returned to the browser. The assistant cannot approve requests or make trust decisions.
app.post("/api/assistant", requireUser, assistantLimiter, async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "The AI assistant is not connected yet. An administrator must add the OpenAI API key to Railway." });
  const raw = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const messages = raw.slice(-10).map(m => ({
    role: m?.role === "assistant" ? "assistant" : "user",
    content: String(m?.content || "").slice(0, 1800)
  })).filter(m => m.content.trim());
  if (!messages.length || messages[messages.length - 1].role !== "user") return res.status(400).json({ error: "Enter a message for the assistant." });
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-6-luna",
        instructions: "You are the UPLIVANTA help assistant. Answer the user's actual question directly and conversationally. Help explain account signup, sign-in, password safety, requesting assistance, becoming a supporter, tracking, Impact Points, and payment test mode. Be honest about which features are not yet available. Never ask for passwords, OTPs, full BVN/NIN, bank card numbers, CVV, identity document images, or other secrets. Never claim to verify identities, approve requests, determine fraud, guarantee outcomes, or move money. Direct users to human support for account-specific or safety-critical decisions. Keep answers clear and helpful.",
        input: messages.map(m => ({ role: m.role, content: m.content })),
        max_output_tokens: 700,
        store: false
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("assistant provider error", { status: response.status, type: payload?.error?.type, code: payload?.error?.code });
      return res.status(502).json({ error: "The assistant could not respond just now. Please try again shortly." });
    }
    const answer = payload.output_text || (payload.output || []).flatMap(x => x.content || []).filter(x => x.type === "output_text").map(x => x.text).join("\n");
    if (!answer) return res.status(502).json({ error: "The assistant returned an empty response. Please try again." });
    res.json({ answer });
  } catch (error) {
    console.error("assistant request failed", { message: error.message });
    res.status(502).json({ error: "The assistant is temporarily unavailable. Please try again." });
  }
});


// ---------------------------------------------------------------------------
// Trust measurements: identity status, assistance completion, evidence rate,
// response rate, community reports. Counts only. Never reporter identities or details.
// ---------------------------------------------------------------------------
const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);
async function trustMetrics(userId) {
  const [idv, commits, prompts, own] = await Promise.all([
    adminDb.from("identity_verifications").select("status").eq("user_id", userId).maybeSingle(),
    adminDb.from("assistance_commitments").select("status,verified_outcome,has_evidence").eq("user_id", userId),
    adminDb.from("contact_prompts").select("responded_at").eq("user_id", userId),
    adminDb.from("bill_requests").select("id").eq("owner_id", userId)
  ]);
  if (idv.error || commits.error || prompts.error || own.error) throw new Error("trust query failed");
  const ownIds = (own.data || []).map(x => x.id);
  let reportQuery = adminDb.from("risk_reports").select("status").or(
    ownIds.length ? `target_user_id.eq.${userId},request_id.in.(${ownIds.join(",")})` : `target_user_id.eq.${userId}`);
  const reports = await reportQuery;
  if (reports.error) throw new Error("report query failed");
  const rows = commits.data || [];
  const done = rows.filter(x => x.status === "completed" && x.verified_outcome === true);
  const p = prompts.data || [];
  const r = reports.data || [];
  const st = idv.data ? idv.data.status : "not_started";
  return {
    identity: { status: st, label: st === "verified" ? "Identity checked" : ["pending", "manual_review"].includes(st) ? "Pending" : "Not verified" },
    completion: { completed: done.length, total: rows.length, rate: pct(done.length, rows.length) },
    evidence: { withEvidence: done.filter(x => x.has_evidence).length, completed: done.length, rate: pct(done.filter(x => x.has_evidence).length, done.length) },
    response: { responded: p.filter(x => x.responded_at).length, total: p.length, rate: pct(p.filter(x => x.responded_at).length, p.length) },
    reports: {
      received: r.length,
      underInvestigation: r.filter(x => ["open", "investigating"].includes(x.status)).length,
      substantiated: r.filter(x => x.status === "substantiated").length,
      cleared: r.filter(x => ["unsubstantiated", "dismissed"].includes(x.status)).length
    }
  };
}
app.get("/api/health", (_req, res) => res.json({ ok: true, authConfigured: !!authDb, databaseConfigured: !!adminDb, paymentsEnabled: process.env.PAYMENTS_ENABLED === "true", aiConfigured: !!process.env.OPENAI_API_KEY }));

app.get("/api/requests", async (_req, res) => {
  if (!adminDb) return res.status(503).json({ error: "Database is not configured." });
  const { data, error } = await adminDb.from("bill_requests")
    .select("id,display_name,country,currency,amount_minor,category,title,story,deadline,created_at,raised_minor")
    .eq("status", "published").order("created_at", { ascending: false }).limit(60);
  if (error) return res.status(500).json({ error: "Could not load requests." });
  res.json({ requests: data || [] });
});

app.post("/api/requests", requireUser, async (req, res) => {
  if (!adminDb) return res.status(503).json({ error: "Database is not configured." });
  const { display_name, country, currency, amount_minor, category, title, story, deadline } = req.body || {};
  const allowedCurrencies = ["NGN","USD","GBP","EUR","GHS","KES","CAD","AUD"];
  if (!display_name || !country || !title || !story || !allowedCurrencies.includes(currency) ||
      !Number.isSafeInteger(amount_minor) || amount_minor < 100 || amount_minor > 100000000000) {
    return res.status(400).json({ error: "Please provide valid request details." });
  }
  const { data, error } = await adminDb.from("bill_requests").insert({
    owner_id: req.user.id, display_name: String(display_name).slice(0,50),
    country: String(country).slice(0,60), currency, amount_minor,
    category: String(category || "Other").slice(0,30), title: String(title).slice(0,90),
    story: String(story).slice(0,1000), deadline: deadline || null, status: "pending_review"
  }).select("id,status").single();
  if (error) { console.error("assistance request insert failed", { code: error.code, message: error.message, hint: error.hint }); return res.status(500).json({ error: "Request could not be saved. Please check the required fields or try again.", code: "REQUEST_SAVE_FAILED" }); }
  res.status(201).json({ request: data, message: "Submitted for review. It is not public yet." });
});


app.get("/api/supporters", async (_req, res) => {
  if (!adminDb) return res.status(503).json({ error: "Database is not configured." });
  const { data, error } = await adminDb.from("supporter_profiles")
    .select("id,display_name,country,bio,created_at")
    .eq("public_opt_in", true).eq("status", "active")
    .order("created_at", { ascending: false }).limit(60);
  if (error) return res.status(500).json({ error: "Could not load supporter directory." });
  res.json({ supporters: data || [] });
});

app.post("/api/supporters", requireUser, async (req, res) => {
  if (!adminDb) return res.status(503).json({ error: "Database is not configured." });
  const { display_name, country, bio, public_opt_in } = req.body || {};
  if (!display_name || String(display_name).length > 50 || String(country || "").length > 60 || String(bio || "").length > 350) {
    return res.status(400).json({ error: "Please provide valid profile details." });
  }
  const { data, error } = await adminDb.from("supporter_profiles").upsert({
    user_id: req.user.id, display_name: String(display_name), country: String(country || ""),
    bio: String(bio || ""), public_opt_in: public_opt_in === true, status: "active"
  }, { onConflict: "user_id" }).select("id,public_opt_in").single();
  if (error) { console.error("supporter profile upsert failed", { code: error.code, message: error.message, hint: error.hint }); return res.status(500).json({ error: "Supporter profile could not be saved. Please check the required fields or try again.", code: "SUPPORTER_SAVE_FAILED" }); }
  res.status(201).json({ supporter: data });
});

app.get("/api/admin/requests", requireUser, requireAdmin, async (_req, res) => {
  const { data, error } = await adminDb.from("bill_requests")
    .select("*").in("status", ["pending_review","needs_more_info"]).order("created_at", { ascending: true }).limit(100);
  if (error) return res.status(500).json({ error: "Could not load moderation queue." });
  res.json({ requests: data || [] });
});

app.post("/api/admin/requests/:id/review", requireUser, requireAdmin, async (req, res) => {
  const { decision, note } = req.body || {};
  if (!["publish","reject","more_info"].includes(decision)) return res.status(400).json({ error: "Invalid decision." });
  const status = decision === "publish" ? "published" : decision === "reject" ? "rejected" : "needs_more_info";
  const { error } = await adminDb.from("bill_requests").update({
    status, moderation_note: String(note || "").slice(0,500), reviewed_by: req.user.id, reviewed_at: new Date().toISOString()
  }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: "Review action failed." });
  if (decision === "more_info") {
    const { data: bill } = await adminDb.from("bill_requests").select("owner_id").eq("id", req.params.id).maybeSingle();
    if (bill) await adminDb.from("contact_prompts").insert({ user_id: bill.owner_id, request_id: req.params.id, kind: "more_info" });
  }
  res.json({ ok: true, status });
});




// Trust, transparency and Impact Points APIs. Sensitive identity documents are
// deliberately not accepted or returned by these routes.
app.get("/api/me/summary", requireUser, async (req, res) => {
  if (!adminDb) return res.status(503).json({ error: "Database is not configured." });
  const [points, recentPoints, commitments, verification] = await Promise.all([
    adminDb.from("impact_points_ledger").select("points").eq("user_id", req.user.id),
    adminDb.from("impact_points_ledger").select("points,event_type,note,created_at").eq("user_id", req.user.id).order("created_at", { ascending: false }).limit(30),
    adminDb.from("assistance_commitments").select("status,verified_outcome").eq("user_id", req.user.id),
    adminDb.from("identity_verifications").select("status,provider,updated_at").eq("user_id", req.user.id).maybeSingle()
  ]);
  if (points.error || recentPoints.error || commitments.error || verification.error) return res.status(500).json({ error: "Could not load your trust dashboard. Apply the latest database migration first." });
  const rows = commitments.data || [];
  const completed = rows.filter(x => x.status === "completed" && x.verified_outcome === true).length;
  const total = rows.length;
  const balance = (points.data || []).reduce((n, x) => n + Number(x.points || 0), 0);
  let trust = null; try { trust = await trustMetrics(req.user.id); } catch (_) {}
  res.json({ trust, impactPoints: balance, recentPoints: recentPoints.data || [], completion: { completed, total, rate: total ? Math.round(completed / total * 100) : null }, identity: verification.data || { status: "not_started" } });
});

app.post("/api/reports", requireUser, async (req, res) => {
  if (!adminDb) return res.status(503).json({ error: "Database is not configured." });
  const { target_user_id, request_id, reason, details } = req.body || {};
  const allowed = ["suspected_fraud", "duplicate_request", "misleading_evidence", "harassment", "impersonation", "other"];
  if ((!target_user_id && !request_id) || (target_user_id && request_id) || !allowed.includes(reason) || String(details || "").trim().length < 15 || String(details).length > 1500) return res.status(400).json({ error: "Choose one account or request, a report reason, and at least 15 characters of detail." });
  if (target_user_id === req.user.id) return res.status(400).json({ error: "You cannot report your own account." });
  const payload = { reporter_id: req.user.id, target_user_id: target_user_id || null, request_id: request_id || null, reason, details: String(details).trim(), status: "open" };
  const { data, error } = await adminDb.from("risk_reports").insert(payload).select("id,status,created_at").single();
  if (error) return res.status(500).json({ error: "Your report could not be saved." });
  res.status(201).json({ report: data, message: "Report received. It will be reviewed; a report is not a finding of wrongdoing." });
});

app.get("/api/requests/:id/timeline", async (req, res) => {
  if (!adminDb) return res.status(503).json({ error: "Database is not configured." });
  const { data: request, error: requestError } = await adminDb.from("bill_requests").select("id,status,created_at,reviewed_at").eq("id", req.params.id).eq("status", "published").maybeSingle();
  if (requestError || !request) return res.status(404).json({ error: "Published request not found." });
  const { data, error } = await adminDb.from("assistance_events").select("event_type,public_note,created_at").eq("request_id", req.params.id).eq("is_public", true).order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: "Could not load the public timeline." });
  res.json({ timeline: [{ event_type: "request_published", public_note: "Request passed initial moderation and was published.", created_at: request.reviewed_at || request.created_at }, ...(data || [])] });
});


app.post("/api/admin/commitments", requireUser, requireAdmin, async (req, res) => {
  const { user_id, request_id, status, verified_outcome, public_note, has_evidence } = req.body || {};
  if (!user_id || !["accepted", "in_progress", "completed", "cancelled", "disputed"].includes(status) || (status === "completed" && verified_outcome !== true)) return res.status(400).json({ error: "Provide a user, valid status, and verified outcome evidence before marking completed." });
  const { data, error } = await adminDb.from("assistance_commitments").insert({ user_id, request_id: request_id || null, status, verified_outcome: verified_outcome === true, has_evidence: has_evidence === true }).select("id,user_id,request_id,status,verified_outcome,has_evidence").single();
  if (error) return res.status(500).json({ error: "Commitment record could not be saved." });
  if (request_id && public_note) {
    const eventType = status === "completed" ? "request_completed" : "request_updated";
    const event = await adminDb.from("assistance_events").insert({ request_id, actor_id: req.user.id, event_type: eventType, public_note: String(public_note).slice(0, 500), is_public: true });
    if (event.error) return res.status(201).json({ commitment: data, warning: "Commitment saved, but public timeline event could not be saved." });
  }
  res.status(201).json({ commitment: data });
});

app.get("/api/admin/reports", requireUser, requireAdmin, async (_req, res) => {
  const { data, error } = await adminDb.from("risk_reports").select("id,reporter_id,target_user_id,request_id,reason,details,status,created_at").in("status", ["open", "investigating"]).order("created_at", { ascending: true }).limit(100);
  if (error) return res.status(500).json({ error: "Could not load reports. Apply the trust features migration." });
  res.json({ reports: data || [] });
});

app.post("/api/admin/reports/:id/review", requireUser, requireAdmin, async (req, res) => {
  const { status, review_note } = req.body || {};
  if (!["investigating", "substantiated", "unsubstantiated", "dismissed"].includes(status)) return res.status(400).json({ error: "Invalid report outcome." });
  const { error } = await adminDb.from("risk_reports").update({ status, review_note: String(review_note || "").slice(0, 700), reviewed_by: req.user.id, reviewed_at: new Date().toISOString() }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: "Report review could not be saved." });
  res.json({ ok: true, status });
});

// Admin-only, idempotent points award. No public endpoint can mint points.
app.post("/api/admin/impact-points/award", requireUser, requireAdmin, async (req, res) => {
  const { user_id, points, event_type, event_key, note } = req.body || {};
  if (!user_id || !Number.isInteger(points) || points < 1 || points > 500 || !/^[a-z0-9:_-]{6,100}$/i.test(String(event_key || "")) || !["verified_participation", "completed_assistance", "volunteering", "community_contribution", "correction"].includes(event_type)) return res.status(400).json({ error: "Provide a valid user, 1–500 points, approved event type and unique event key." });
  const { data, error } = await adminDb.from("impact_points_ledger").insert({ user_id, points, event_type, event_key, note: String(note || "").slice(0, 250), awarded_by: req.user.id }).select("id,user_id,points,event_type,created_at").single();
  if (error) return res.status(409).json({ error: "Points were not awarded. The event key may already exist, or the user is invalid." });
  res.status(201).json({ award: data });
});

// ---------------------------------------------------------------------------
// Paystack checkout (card, bank, USSD and bank transfer are all offered on Paystack's hosted page).
// ---------------------------------------------------------------------------
app.post("/api/payments/checkout", requireUser, async (req, res) => {
  try {
    if (process.env.PAYMENTS_ENABLED !== "true" || !String(process.env.PAYSTACK_SECRET_KEY || "").startsWith("sk_live_")) return res.status(503).json({ error: "Live payments are disabled. Use the clearly labelled Paystack test checkout while testing." });
    if (!adminDb) return res.status(503).json({ error: "Database is not configured." });
    const { request_id, amount_minor } = req.body || {};
    if (!request_id || !Number.isSafeInteger(amount_minor) || amount_minor < 100 || amount_minor > 500000000) {
      return res.status(400).json({ error: "Enter a valid amount (minimum ₦1)." });
    }
    const { data: bill } = await adminDb.from("bill_requests").select("id,status,currency,amount_minor,raised_minor,owner_id").eq("id", request_id).maybeSingle();
    if (!bill || bill.status !== "published") return res.status(404).json({ error: "This request is not open for contributions." });
    if (bill.currency !== "NGN") return res.status(400).json({ error: "Only NGN requests can be paid through Paystack right now." });
    if (bill.owner_id === req.user.id) return res.status(400).json({ error: "You cannot contribute to your own request." });
    if (amount_minor > Math.max(0, Number(bill.amount_minor) - Number(bill.raised_minor))) return res.status(400).json({ error: "That is more than the remaining target." });
    const reference = "upl_" + crypto.randomUUID().replace(/-/g, "");
    const { error: insErr } = await adminDb.from("contributions").insert({ request_id, user_id: req.user.id, reference, amount_minor, currency: "NGN", status: "pending" });
    if (insErr) return res.status(500).json({ error: "Could not start the payment." });
    const site = (process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "") || `${req.protocol}://${req.get("host")}`;
    const tx = await paystack("POST", "/transaction/initialize", {
      email: req.user.email, amount: amount_minor, currency: "NGN", reference,
      callback_url: site + "/", channels: ["bank_transfer", "card", "bank", "ussd"],
      metadata: { request_id, user_id: req.user.id }
    });
    res.json({ authorization_url: tx.authorization_url, reference });
  } catch (e) {
    console.error("checkout error:", e.message);
    res.status(502).json({ error: "Could not reach the payment provider. Please try again." });
  }
});

app.get("/api/payments/verify", requireUser, async (req, res) => {
  try {
    const reference = String(req.query.reference || "");
    const { data: c } = await adminDb.from("contributions").select("user_id").eq("reference", reference).maybeSingle();
    if (!c || c.user_id !== req.user.id) return res.status(404).json({ error: "Contribution not found." });
    const out = await confirmAndSettle(reference);
    res.json({ status: out.status });
  } catch (e) {
    console.error("verify error:", e.message);
    res.status(502).json({ error: "Could not verify yet. The webhook will confirm it shortly." });
  }
});

// ---------------------------------------------------------------------------
// Face + ID verification (Dojah EasyOnboard widget). We store only status + reference.
// ---------------------------------------------------------------------------
app.post("/api/identity/start", requireUser, async (req, res) => {
  const { DOJAH_APP_ID, DOJAH_PUBLIC_KEY, DOJAH_WIDGET_ID, DOJAH_SECRET_KEY } = process.env;
  if (!DOJAH_APP_ID || !DOJAH_PUBLIC_KEY || !DOJAH_WIDGET_ID || !DOJAH_SECRET_KEY) {
    return res.status(503).json({ error: "Identity verification is not connected yet." });
  }
  if (!adminDb) return res.status(503).json({ error: "Database is not configured." });
  if (!req.body || req.body.consent !== true) return res.status(400).json({ error: "Consent is required before verification." });
  const { data: existing } = await adminDb.from("identity_verifications").select("status").eq("user_id", req.user.id).maybeSingle();
  if (existing && existing.status === "verified") return res.json({ already_verified: true });
  const reference_id = "upl_idv_" + crypto.randomUUID().replace(/-/g, "");
  const { error } = await adminDb.from("identity_verifications").upsert({
    user_id: req.user.id, provider: "dojah", provider_reference: reference_id,
    status: "pending", consent_at: new Date().toISOString(), updated_at: new Date().toISOString()
  }, { onConflict: "user_id" });
  if (error) return res.status(500).json({ error: "Could not start verification." });
  res.json({ reference_id, app_id: DOJAH_APP_ID, p_key: DOJAH_PUBLIC_KEY, widget_id: DOJAH_WIDGET_ID });
});

// Public trust card for the person behind a PUBLISHED request (counts only).
app.get("/api/requests/:id/trust", async (req, res) => {
  try {
    if (!adminDb) return res.status(503).json({ error: "Database is not configured." });
    const { data: bill } = await adminDb.from("bill_requests").select("owner_id").eq("id", req.params.id).in("status", ["published", "funded"]).maybeSingle();
    if (!bill) return res.status(404).json({ error: "Published request not found." });
    res.json({ trust: await trustMetrics(bill.owner_id) });
  } catch (e) { res.status(500).json({ error: "Could not load trust measurements." }); }
});

// Staff log that a person replied to a prompt; the person can also confirm their own reply.
app.post("/api/admin/prompts", requireUser, requireAdmin, async (req, res) => {
  const { user_id, request_id, kind } = req.body || {};
  if (!user_id || !["more_info", "follow_up", "evidence_request"].includes(kind || "follow_up")) return res.status(400).json({ error: "Provide a user and a valid kind." });
  const { data, error } = await adminDb.from("contact_prompts").insert({ user_id, request_id: request_id || null, kind: kind || "follow_up" }).select("id").single();
  if (error) return res.status(500).json({ error: "Prompt could not be saved." });
  res.status(201).json({ prompt: data });
});
app.post("/api/admin/prompts/:id/responded", requireUser, requireAdmin, async (req, res) => {
  const { error } = await adminDb.from("contact_prompts").update({ responded_at: new Date().toISOString() }).eq("id", req.params.id).is("responded_at", null);
  if (error) return res.status(500).json({ error: "Could not record the response." });
  res.json({ ok: true });
});
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Uplivanta starter listening on ${port}`));
