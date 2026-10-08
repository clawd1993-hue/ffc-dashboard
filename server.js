/**
 * FFC Mobile Data Dashboard
 * Per-funnel high-level metrics. Sources:
 *   - GHL  → deep funnel (signups→leads→booked→shows→closes) + cash collected
 *   - Whop → ad spend, ROAS, CAC, purchases (from /api/v1/ads)
 * Deploys clean on Render (talks to GHL + Whop APIs directly; no localhost dep).
 */
const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3460;

// ── Config ──────────────────────────────────────────────────────────────
const GHL_API_KEY = process.env.GHL_API_KEY || ''; // set via env on the server; never hardcode
const GHL_BASE = 'https://services.leadconnectorhq.com';
const WHOP_BASE = 'https://api.whop.com/api/v1';
const DASH_PASSWORD = process.env.DASH_PASSWORD || 'ffc2026';

const FUNNELS = JSON.parse(fs.readFileSync(path.join(__dirname, 'funnels.json'), 'utf8')).funnels;

// Resolve a Whop API key: prefer env WHOP_KEY_<biz>, else local credentials file (dev).
function whopKey(biz) {
  if (!biz) return null;
  const envKey = process.env[`WHOP_KEY_${biz}`];
  if (envKey) return envKey.trim();
  try {
    return fs.readFileSync(path.join(os.homedir(), '.openclaw', 'credentials', `whop-api-key-${biz}.txt`), 'utf8').trim();
  } catch { return null; }
}

const DUMMY = !!process.env.DUMMY; // lite/demo mode: canned data, no external APIs, open access

app.use(express.json());
app.use(cookieParser());

// ── Dummy data (feel-test mode) ──────────────────────────────────────────
function dummyFunnel(id, range) {
  const factor = { today: 1/30, '7d': 7/30, '30d': 1, '90d': 3, all: 5 }[range] ?? 1;
  const days = { today: 1, '7d': 7, '30d': 30, '90d': 90, all: 280 }[range] ?? 30;
  const R = n => Math.max(0, Math.round(n * factor));
  // per-funnel base (roughly realistic shapes)
  const base = {
    // ai-challenge = AI Creator Whop account (biz_JZgEom4rjrp0s3) + shared FFC GHL deep funnel (tXCdfKQO, commingled)
    'ai-challenge':      { su:302, ld:93, bk:104, sh:17, cl:11, cash:26591, spend:95,   purch:2,  pval:14  },
    // faceless-reels-lab = FFC GHL deep funnel (tXCdfKQO) + its own Whop account (biz_nSTT…)
    'faceless-reels-lab':{ su:302, ld:93, bk:104, sh:17, cl:11, cash:26591, spend:1137, purch:19, pval:132 },
  }[id] || { su:0, ld:0, bk:0, sh:0, cl:0, cash:0, spend:0, purch:0, pval:0 };
  const cfg = FUNNELS.find(f => f.id === id) || {};
  const out = { id, name: cfg.name || id, range, ghl: null, whop: null, errors: [], demo: true };
  if (cfg.ghl) {
    const su=R(base.su), ld=R(base.ld), bk=R(base.bk), sh=R(base.sh), cl=R(base.cl), cash=Math.round(base.cash*factor);
    out.ghl = { signups:su, leads:ld, booked:bk, shows:sh, closes:cl, cashCollected:cash,
      avgCashPerDay: cash/days, avgDealSize: cl?cash/cl:0,
      conv: { signupToLead: su?ld/su:null, signupToBooked: su?bk/su:null, bookedToShow: bk?sh/bk:null, showToClose: sh?cl/sh:null } };
  }
  if (cfg.whopBiz) {
    const spend=base.spend, purch=base.purch;
    const clicks=1036, rev=base.pval*4;
    out.whop = { spend, purchases:purch, revenue:rev, bookedCalls:3, leads:base.ld||162,
      clicks, impressions:13980, cpc: spend/clicks, cac: purch?spend/purch:null, aov: purch?rev/purch:null,
      epc: rev/clicks, costPerLead: 7.02, costPerBookedCall: 379,
      roas: spend?rev/spend:null, activeAds:4, totalAds:5 };
  }
  if (out.ghl && out.whop && out.whop.spend>0) {
    const s=out.whop.spend;
    out.combined = { trueRoas: out.ghl.cashCollected/s, costPerClose: out.ghl.closes?s/out.ghl.closes:null,
      costPerSignup: out.ghl.signups?s/out.ghl.signups:null, costPerBooked: out.ghl.booked?s/out.ghl.booked:null,
      spendNote: 'ad-account total (not range-filtered)' };
  }
  return out;
}

// ── Auth (single shared password → signed cookie) ─────────────────────────
const AUTH_TOKEN = crypto.createHash('sha256').update('ffc-dash|' + DASH_PASSWORD).digest('hex').slice(0, 32);
function authed(req) { return req.cookies?.ffc_dash === AUTH_TOKEN; }
app.post('/api/login', (req, res) => {
  if ((req.body?.password || '') === DASH_PASSWORD) {
    res.cookie('ffc_dash', AUTH_TOKEN, { httpOnly: true, sameSite: 'lax', maxAge: 90 * 864e5 });
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: 'Wrong password' });
});
function requireAuth(req, res, next) {
  if (DUMMY || process.env.DEV_OPEN || !process.env.DASH_PASSWORD) return next(); // open when no password set
  if (authed(req)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── GHL helpers ────────────────────────────────────────────────────────────
async function ghlFetch(endpoint) {
  const res = await fetch(`${GHL_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`GHL ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// contacts cache per location (5 min) — GHL is source of truth, restart-safe
const ghlCache = {}; // locationId → { ts, contacts }
const GHL_TTL = 5 * 60 * 1000;
async function ghlContacts(locationId) {
  const hit = ghlCache[locationId];
  if (hit && Date.now() - hit.ts < GHL_TTL) return hit.contacts;
  const all = [];
  let startAfter = null, startAfterId = null, pages = 60;
  while (pages-- > 0) {
    let ep = `/contacts/?locationId=${locationId}&limit=100`;
    if (startAfter) ep += `&startAfter=${encodeURIComponent(startAfter)}`;
    if (startAfterId) ep += `&startAfterId=${encodeURIComponent(startAfterId)}`;
    const data = await ghlFetch(ep);
    const c = data.contacts || [];
    if (!c.length) break;
    all.push(...c);
    const m = data.meta || {};
    if (!m.startAfter || !m.startAfterId) break;
    startAfter = m.startAfter; startAfterId = m.startAfterId;
    if (all.length >= (m.total || Infinity)) break;
  }
  ghlCache[locationId] = { ts: Date.now(), contacts: all };
  return all;
}

function rangeWindow(range) {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = 864e5;
  if (range === 'all') {
    const from = new Date('2026-01-01T00:00:00');
    const to = new Date(startToday.getTime() + day);
    return { from, to, days: Math.max(1, Math.round((to - from) / day)) };
  }
  const map = { today: 0, '7d': 7, '30d': 30, '90d': 90 };
  const days = map[range] ?? 30;
  const from = days === 0 ? startToday : new Date(startToday.getTime() - days * day);
  const to = new Date(startToday.getTime() + day);
  return { from, to, days: days || 1 };
}

function ghlMetrics(contacts, cfg, range) {
  const { from, to, days } = rangeWindow(range);
  const T = cfg.tags;
  const hasTag = (c, tag) => (c.tags || []).map(t => String(t).toLowerCase()).includes(tag);
  const inWin = (c, field) => { const d = new Date(c[field] || c.dateAdded); return d >= from && d < to; };

  const uniqByTag = (tag, field = 'dateUpdated') => {
    const seen = new Set();
    for (const c of contacts) {
      if (!inWin(c, field) || !hasTag(c, tag)) continue;
      const k = (c.email || c.id || '').toLowerCase();
      if (k) seen.add(k);
    }
    return seen.size;
  };

  const signups = contacts.filter(c => hasTag(c, T.signup) && inWin(c, 'dateAdded')).length;
  const leads = uniqByTag(T.lead, 'dateAdded');
  const booked = uniqByTag(T.booked);
  const shows = uniqByTag(T.show);
  const closes = uniqByTag(T.close);

  // cash collected (unique closed-won, first amount per email)
  const seen = new Map();
  for (const c of contacts) {
    if (!inWin(c, 'dateUpdated') || !hasTag(c, T.close)) continue;
    const k = (c.email || c.id || '').toLowerCase();
    if (!k || seen.has(k)) continue;
    const f = (c.customFields || []).find(x => x && (x.id === cfg.cashFieldId || /last.?payment/i.test(x.name || '')));
    seen.set(k, Number(f?.value) || 0);
  }
  let cash = 0; for (const v of seen.values()) cash += v;

  return {
    signups, leads, booked, shows, closes,
    cashCollected: cash,
    avgCashPerDay: cash / days,
    avgDealSize: closes ? cash / closes : 0,
    conv: {
      signupToLead: signups ? leads / signups : null,
      signupToBooked: signups ? booked / signups : null,
      bookedToShow: booked ? shows / booked : null,
      showToClose: shows ? closes / shows : null
    }
  };
}

// ── Whop helpers ────────────────────────────────────────────────────────────
const whopCache = {}; // biz → { ts, ads }
const WHOP_TTL = 5 * 60 * 1000;
async function whopAds(biz) {
  const hit = whopCache[biz];
  if (hit && Date.now() - hit.ts < WHOP_TTL) return hit.ads;
  const key = whopKey(biz);
  if (!key) return null;
  const res = await fetch(`${WHOP_BASE}/ads`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Whop ${res.status}`);
  const data = await res.json();
  const ads = Array.isArray(data.data) ? data.data : [];
  whopCache[biz] = { ts: Date.now(), ads };
  return ads;
}

// FFC product set (front-end + bumps + OTOs) → revenue = sum of their Whop custom_event_values
const WHOP_PRODUCTS = ['purchase', 'bump_22_niches', 'bump_viral_reels', 'oto_dfy_funnel', 'oto_dfy_products', 'downsell'];
function whopSummary(ads) {
  if (!ads) return null;
  const sum = (k) => ads.reduce((a, x) => a + (Number(x[k]) || 0), 0);
  const spend = sum('spend'), clicks = sum('clicks');
  let fePurch = 0, revenue = 0, bookedCalls = 0;      // fePurch = front-end ($6.95) buyers
  for (const x of ads) {
    const cc = x.custom_event_counts || {}, cv = x.custom_event_values || {};
    fePurch += Number(cc.purchase) || Number(x.purchases) || 0;
    bookedCalls += Number(cc.booked_call) || 0;
    for (const p of WHOP_PRODUCTS) revenue += Number(cv[p]) || 0;   // front-end + bumps + OTOs $
  }
  return {
    spend, clicks, impressions: sum('impressions'), leads: sum('leads'),
    purchases: fePurch, revenue, bookedCalls,
    cpc: clicks ? spend / clicks : null,                 // cost per click
    cac: fePurch ? spend / fePurch : null,               // cost per front-end buyer
    aov: fePurch ? revenue / fePurch : null,             // avg order value (incl bumps + OTOs)
    epc: clicks ? revenue / clicks : null,               // earnings per click (incl bumps + OTOs)
    costPerLead: sum('leads') ? spend / sum('leads') : null,
    costPerBookedCall: bookedCalls ? spend / bookedCalls : null,
    roas: spend ? revenue / spend : null,
    activeAds: ads.filter(a => a.status === 'active').length,
    totalAds: ads.length
  };
}

// ── API ──────────────────────────────────────────────────────────────────────
app.get('/api/funnels', requireAuth, (req, res) => {
  res.json({ funnels: FUNNELS.map(f => ({ id: f.id, name: f.name, hasGhl: !!f.ghl, hasWhop: !!f.whopBiz })) });
});

app.get('/api/funnel/:id', requireAuth, async (req, res) => {
  const cfg = FUNNELS.find(f => f.id === req.params.id);
  if (!cfg) return res.status(404).json({ error: 'Unknown funnel' });
  const range = (req.query.range || '30d').toLowerCase();
  if (DUMMY) return res.json(dummyFunnel(req.params.id, range));
  const out = { id: cfg.id, name: cfg.name, range, ghl: null, whop: null, errors: [] };

  const jobs = [];
  if (cfg.ghl) jobs.push(
    ghlContacts(cfg.ghl.locationId)
      .then(c => { out.ghl = ghlMetrics(c, cfg.ghl, range); })
      .catch(e => out.errors.push('GHL: ' + e.message))
  );
  if (cfg.whopBiz) jobs.push(
    whopAds(cfg.whopBiz)
      .then(a => { out.whop = whopSummary(a); })
      .catch(e => out.errors.push('Whop: ' + e.message))
  );
  await Promise.all(jobs);

  // Combined truth metrics when both sources exist: Whop sees only the $6.95
  // challenge value, blind to the Elite closes (those land in GHL/FanBasis).
  // Real ROAS = GHL cash / ad spend; real cost-per-close = spend / GHL closes.
  if (out.ghl && out.whop && out.whop.spend > 0) {
    const s = out.whop.spend;
    out.combined = {
      trueRoas: out.ghl.cashCollected / s,
      costPerClose: out.ghl.closes ? s / out.ghl.closes : null,
      costPerSignup: out.ghl.signups ? s / out.ghl.signups : null,
      costPerBooked: out.ghl.booked ? s / out.ghl.booked : null,
      spendNote: 'ad-account total (not range-filtered)'
    };
  }
  res.json(out);
});

// combined CAC/cash cards — if GHL present, cost-per-close from Whop spend / GHL closes
app.post('/api/refresh', requireAuth, (req, res) => {
  for (const k of Object.keys(ghlCache)) delete ghlCache[k];
  for (const k of Object.keys(whopCache)) delete whopCache[k];
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, funnels: FUNNELS.length }));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`📊 FFC mobile dashboard on :${PORT}  (${FUNNELS.length} funnels)`));
