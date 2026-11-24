import { useState, useMemo, useEffect, useRef, createContext, useContext, Fragment } from "react";
import { Shield, Sun, Search, Columns, Building, Calendar, Sparkles, Settings, Users, LogOut, Plus, Upload, Check, X, Alert, Mail, Phone, Voicemail, Linkedin, Clock, MapPin, FileText, Pen, Send, Refresh, Lock, ChevronRight, Eye, Trash, Loader, Globe, Note, Target, Dollar, ShieldCheck, History, Reset, LinkIcon, Car, UserPlus, Ban, Download, ArrowLeft, Flask } from "lucide-react";

/* ───────── helpers ───────── */
const H = 3600e3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (c) => "$" + Math.round(c / 100).toLocaleString("en-US");
const moneyK = (c) => { const d = c / 100; return d >= 1e6 ? `$${(d / 1e6).toFixed(2)}M` : d >= 1000 ? `$${Math.round(d / 1000)}k` : `$${Math.round(d)}`; };
const fmtDay = (ts) => new Date(ts).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const fmtTime = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const fmtDT = (ts) => `${fmtDay(ts)}, ${fmtTime(ts)}`;
const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const nextDay = (day) => startOfDay(day + 26 * H);
const atH = (day, h) => { const d = new Date(day); d.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0); return d.getTime(); };
const bizDays = (from, n) => { const out = []; let d = startOfDay(from); while (out.length < n) { const w = new Date(d).getDay(); if (w !== 0 && w !== 6) out.push(d); d = nextDay(d); } return out; };
const daysSince = (ts, now = Date.now()) => Math.floor((now - ts) / (24 * H));
const ago = (ts) => { const m = Math.round((Date.now() - ts) / 60000); if (m < 1) return "just now"; if (m < 60) return `${m} min ago`; if (m < 1440) return `${Math.round(m / 60)} h ago`; const d = Math.round(m / 1440); return d === 1 ? "yesterday" : `${d} days ago`; };
const dayWord = (ts, now = Date.now()) => { const a = startOfDay(ts), t = startOfDay(now); return a === t ? "today" : a === nextDay(t) ? "tomorrow" : fmtDay(ts); };
const lc1 = (t) => (t ? t.charAt(0).toLowerCase() + t.slice(1) : t);
const initials = (n) => n.split(" ").map((x) => x[0]).join("").slice(0, 2);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/* ───────── fixed lists and rules ───────── */
const CITY = { "Dallas HQ": [0, 0], Irving: [-10, 3], Plano: [2, 18], Arlington: [-18, -5], "Downtown Dallas": [0, 0], "Fort Worth (Alliance)": [-30, 12], Frisco: [0, 25], Garland: [12, 8], Mesquite: [14, -2], "Oak Lawn, Dallas": [-2, 2], Grapevine: [-17, 12], Lancaster: [2, -14], "Uptown Dallas": [-1, 2] };
const CITIES = Object.keys(CITY).filter((c) => c !== "Dallas HQ");
const drive = (a, b) => (a === b ? 5 : Math.round(Math.hypot((CITY[a] || [0, 0])[0] - (CITY[b] || [0, 0])[0], (CITY[a] || [0, 0])[1] - (CITY[b] || [0, 0])[1]) * 1.9 + 8));
const TYPES = ["Industrial", "Cold chain warehouse", "Medical office", "Construction site", "Class A office", "Data center", "Multifamily", "Hospitality", "Retail", "Self storage"];
const STAGES = [
  { id: "lead", label: "Lead", p: 0.05 }, { id: "researched", label: "Researched", p: 0.1 }, { id: "contacted", label: "Contacted", p: 0.2 },
  { id: "meeting_set", label: "Meeting set", p: 0.35 }, { id: "proposal", label: "Proposal", p: 0.55 }, { id: "contract_sent", label: "Contract sent", p: 0.8 }, { id: "won", label: "Won", p: 1 },
];
const stageIdx = (s) => STAGES.findIndex((x) => x.id === s);
const stageOf = (s) => STAGES[stageIdx(s)];
const LOST = ["Price", "Stayed with incumbent", "No budget", "No response", "Timing", "Not a fit", "Other"];
const COVER_LABEL = { "24_7": "24/7", nights: "Nights (6 pm to 6 am)", business_hours: "Business hours (Mon to Fri)" };
const DEFAULT_PKG = {
  Industrial: { posts: 2, armed: false, coverage: "24_7", supervisor: false, addons: ["patrol"], term: 36 },
  "Cold chain warehouse": { posts: 2, armed: false, coverage: "24_7", supervisor: true, addons: ["video"], term: 36 },
  "Medical office": { posts: 1, armed: false, coverage: "business_hours", supervisor: false, addons: ["patrol"], term: 24 },
  "Construction site": { posts: 1, armed: false, coverage: "nights", supervisor: false, addons: ["video"], term: 12 },
  "Class A office": { posts: 2, armed: false, coverage: "24_7", supervisor: true, addons: ["portal"], term: 36 },
  "Data center": { posts: 3, armed: true, coverage: "24_7", supervisor: true, addons: ["video"], term: 36 },
  Multifamily: { posts: 1, armed: false, coverage: "nights", supervisor: false, addons: ["patrol"], term: 12 },
  Hospitality: { posts: 2, armed: false, coverage: "nights", supervisor: false, addons: [], term: 24 },
  Retail: { posts: 1, armed: false, coverage: "business_hours", supervisor: false, addons: ["patrol"], term: 12 },
  "Self storage": { posts: 0, armed: false, coverage: "nights", supervisor: false, addons: ["patrol", "video"], term: 12 },
};

/* pricing engine: integer cents, same formula as the build spec */
function price(pk, cfg, manual = 0) {
  const hours = pk.posts * cfg.cover[pk.coverage];
  const rate = Math.round((pk.armed ? cfg.armed : cfg.unarmed) * (pk.supervisor ? cfg.sup : 1));
  const addMo = pk.addons.reduce((n, k) => n + cfg.addons[k].mo, 0);
  const td = cfg.term[pk.term] || 0;
  const annual = Math.round((hours * rate * 52 + addMo * 12) * (1 - td) * (1 - manual));
  return { hours, rate, addMo, td, manual, annual, monthly: Math.round(annual / 12) };
}
const liveCfg = (db) => db.pricing[db.pricing.length - 1];
const pkgText = (pk, cfg) => `${pk.posts ? `${plural(pk.posts, pk.armed ? "armed post" : "unarmed post")}, ${lc1(COVER_LABEL[pk.coverage])}` : "No fixed post"}${pk.supervisor ? ", with a site supervisor" : ""}${pk.addons.length ? `, plus ${pk.addons.map((k) => lc1(cfg.addons[k].label)).join(" and ")}` : ""}`;

/* who can see what */
const isMgr = (u) => u.role === "manager" || u.role === "admin";
const visible = (a, me) => !a.deleted && (isMgr(me) || a.ownerId === me.id || !a.ownerId);
const canEdit = (a, me) => isMgr(me) || a.ownerId === me.id;
const userOf = (db, id) => db.users.find((u) => u.id === id);
const acct = (db, id) => db.accounts.find((a) => a.id === id);
const openDeal = (db, aid) => db.deals.find((d) => d.accountId === aid && d.status === "open") || db.deals.find((d) => d.accountId === aid);
const primary = (a) => a.contacts.find((c) => c.primary) || a.contacts[0];

/* fit score: rules, not AI */
function fit(a, db) {
  const r = []; let s = 0; const cfg = liveCfg(db);
  if (a.signals.some((x) => x.kind === "incident" && x.confirmed)) { s += 30; r.push("Confirmed security incident"); }
  if (a.contractEnd && a.contractEnd - Date.now() < 120 * 24 * H && a.contractEnd > Date.now()) { s += 25; r.push(`Contract ends in ${Math.ceil((a.contractEnd - Date.now()) / (24 * H))} days`); }
  if (/^(none|in-house|cameras)/i.test(a.provider || "")) { s += 20; r.push("No professional guard service today"); }
  if (price(DEFAULT_PKG[a.type] || DEFAULT_PKG.Industrial, cfg).annual >= 40000000) { s += 15; r.push("Large contract value"); }
  const p = primary(a); if (p && p.email) { s += 10; r.push("Decision maker with email"); }
  return { score: s, reasons: r };
}

/* write helpers used inside update() */
const nid = (db, p) => `${p}${++db.seq}`;
const log = (db, me, accountId, type, text, extra = {}) => db.activities.push({ id: nid(db, "act"), accountId, userId: me ? me.id : null, type, text, at: Date.now(), ...extra });
const audit = (db, me, action, detail) => db.audit.push({ id: nid(db, "aud"), userId: me ? me.id : null, action, detail, at: Date.now() });
const advance = (db, me, deal, to) => { if (deal && deal.status === "open" && stageIdx(to) > stageIdx(deal.stage)) { const from = deal.stage; deal.stage = to; deal.stageAt = Date.now(); if (to === "won") deal.status = "won"; log(db, null, deal.accountId, "stage", `Stage moved from ${stageOf(from).label} to ${stageOf(to).label}`); audit(db, me, "deal.stage", `${acct(db, deal.accountId).name}: ${from} → ${to}`); } };
const touch = (db, aid) => { const d = openDeal(db, aid); if (d) d.lastAt = Date.now(); };
const suppressed = (db, email) => db.suppressions.find((s) => s.email.toLowerCase() === (email || "").toLowerCase());
const sentToday = (db, uid) => db.emails.filter((e) => e.userId === uid && e.dir === "out" && Date.now() - e.at < 24 * H).length;

/* ───────── simulated AI (the real app calls a private Claude model) ───────── */
const refFor = (db, a) => db.refs.find((r) => r.active && r.types.includes(a.type)) || db.refs.find((r) => r.active);
const proofAnon = (db, a) => { const r = refFor(db, a); return r ? `At ${r.anon}, officers hit ${r.comp}% patrol compliance with a ${r.resp}-minute average response, and the client sees every GPS-verified patrol in real time` : ""; };
const topSignal = (a) => (a.signals.find((s) => s.confirmed) || a.signals[0] || {}).text;

function makeBrief(db, a) {
  const cfg = liveCfg(db), pk = DEFAULT_PKG[a.type] || DEFAULT_PKG.Industrial, pr = price(pk, cfg), r = refFor(db, a);
  const src = (kinds) => [...new Set(a.signals.filter((s) => !kinds || kinds.includes(s.kind)).map((s) => s.sourceId).filter(Boolean))];
  const all = a.sources.map((s) => s.id);
  const first = topSignal(a);
  const none = "Not enough information. Add a source or a note to fill this in.";
  return {
    pkg: pk,
    sections: [
      { h: "Overview", t: `${a.name} is a ${lc1(a.type)} property in ${a.city}${a.size ? ` (${a.size})` : ""}${a.ownerCo ? `, owned by ${a.ownerCo}` : ""}.${a.built ? ` Built ${a.built}` : ""}${a.occ ? `${a.built ? "," : ""} ${a.occ}% occupied.` : a.built ? "." : ""}`, src: all.slice(0, 1) },
      { h: "Decision makers", t: a.contacts.length ? a.contacts.map((c) => `${c.first} ${c.last}, ${c.title || "title unknown"}.${c.pref ? ` ${c.pref}.` : ""}`).join("\n") : none, src: [] },
      { h: "Security signals", t: a.signals.length ? a.signals.map((s) => `- ${s.text}${s.confirmed ? "" : " (unconfirmed)"}`).join("\n") : none, src: src() },
      { h: "Current coverage and timing", t: a.provider || a.timing ? `${a.provider || "Provider unknown"}. ${a.timing || "No contract date on file"}.` : none, src: src(["timing"]) },
      { h: "Recommended package", t: `${pkgText(pk, cfg)}. Estimated ${money(pr.annual)} a year (${money(pr.monthly)} a month) on a ${pk.term}-month term.`, src: [], system: "Price written by the pricing engine, not the AI." },
      { h: "Proof point (internal)", t: r ? `${r.named}: ${r.comp}% patrol compliance and a ${r.resp}-minute average response. ${r.permission ? "This client has approved being named." : "Outreach must use the anonymized version: “" + r.anon + "”."}` : none, src: [] },
      { h: "Talking points", t: [first ? `Open with their problem: ${lc1(first)}.` : "Ask what prompted them to look at security now.", a.timing ? `Timing: ${lc1(a.timing)}.` : null, "Show the client portal: live officer map, GPS-verified patrols and reviewed reports the same night.", "Offer a 14-day transition plan with no coverage gap."].filter(Boolean).map((x) => `- ${x}`).join("\n"), src: src(["incident", "timing"]) },
      { h: "Likely objections", t: ["“Our current company is cheaper.” Compare cost per verified patrol, not hourly rate.", /in-house|none|cameras/i.test(a.provider || "") ? "“We handle it ourselves.” Their current setup has no reporting, backup or trained response. We add all three without adding headcount." : "“Switching is risky.” 14-day transition; incumbent officers can be interviewed and kept.", "“Not this quarter.” Offer a 30-day nights-only pilot."].map((x) => `- ${x}`).join("\n"), src: [] },
    ],
  };
}

function makeDraft(db, a, c, channel, tone, stage, slots, me) {
  const proof = proofAnon(db, a), hook = topSignal(a), short = a.name.replace(/ \(.*\)$/, "");
  const open = tone === "direct" ? `${c.first}, quick one.` : tone === "friendly" ? `Hi ${c.first}, hope your week is going well.` : `Hi ${c.first},`;
  const times = slots.length ? slots.slice(0, 2).map((s) => `${fmtDay(s.start)} at ${fmtTime(s.start)}`).join(" or ") : "early next week";
  const because = hook ? `I'm reaching out about something I noted at ${short}: ${lc1(hook).replace(/\.$/, "")}` : `I'm reaching out because we work with ${lc1(a.type)} owners in ${a.city}`;
  const myFirst = me.name.split(" ")[0];
  if (channel === "email") {
    if (stage === "contract_sent") return { subject: `Quick check on the ${short} agreement`, body: `${open}\n\nJust checking whether you had any questions on the agreement I sent over. I'm happy to walk through it in 10 minutes, ${times}.\n\nOnce it's signed we start a 14-day onboarding with no coverage gap.` };
    if (stage === "proposal") return { subject: `Proposal for ${short}: any questions?`, body: `${open}\n\nFollowing up on the proposal for ${short}. One thing that may help with the decision: ${lc1(proof)}.\n\nWould ${times} work for a short call?` };
    if (stage === "contacted") return { subject: `Following up: security at ${short}`, body: `${open}\n\nI sent a note last week and wanted to follow up briefly. ${because}.\n\n${proof}.\n\nWould a 30-minute site walk work, ${times}?` };
    return { subject: hook ? `${short}: ${lc1(hook).slice(0, 60)}` : `Security at ${short}`, body: `${open}\n\n${because}.\n\nWe protect similar ${lc1(a.type)} sites across DFW. ${proof}.\n\nCould I walk the property with you for 30 minutes, ${times}?` };
  }
  if (channel === "call") return { subject: `Call script: ${c.first} ${c.last}`, body: `Opener: “Hi ${c.first}, it's ${myFirst} with Security Of America. I'll be brief. ${because}. Is that still a concern?”\n\nIf yes, ask:\n- What happens today when something goes wrong after hours?\n- How do you know a patrol actually happened?\n- Who else would weigh in on a change, and by when?\n\nProof: “${proof}.”\n\nAsk: “Could I walk the site with you ${times}?”\n\nIf not now: “Can I send a one-page plan and check back next week?”` };
  if (channel === "voicemail") return { subject: "Voicemail (20 seconds)", body: `Hi ${c.first}, ${me.name} from Security Of America. ${because}. We cover similar sites across DFW with GPS-verified patrols you can watch live. I'll send a short email with two times to meet. My number is ${me.phone}. Thanks.` };
  return { subject: "LinkedIn note", body: `Hi ${c.first}, I work with ${lc1(a.type)} owners across DFW on site security. ${hook ? `I saw that ${lc1(hook).slice(0, 110).replace(/\.$/, "")}. ` : ""}Open to connecting?` };
}

const footer = (me, db, token) => `${me.name}\n${me.title}, Security Of America\n${me.phone}\n\nSecurity Of America · ${db.company.address} · Unsubscribe: soa-crm.example/u/${token}`;

/* compliance checks: code, not AI. blocking ones stop the send */
function runChecks(db, a, c, d) {
  const out = [], text = `${d.subject || ""}\n${d.body}`;
  if (d.channel === "email") {
    const sup = suppressed(db, c.email);
    out.push({ id: "recipient_ok", blocking: true, pass: !!c.email && !sup && c.emailStatus === "ok" && !a.doNotContact, label: !c.email ? "Contact has no email address" : sup ? `${c.email} is on the suppression list (${sup.reason})` : c.emailStatus !== "ok" ? `Contact email is marked ${c.emailStatus}` : a.doNotContact ? "Account is marked do not contact" : "Recipient can be emailed (not suppressed, bounced or unsubscribed)" });
    out.push({ id: "footer", blocking: true, pass: !!db.company.address, label: "Postal address and unsubscribe link are added automatically" });
    const s = (d.subject || "").trim();
    out.push({ id: "subject", blocking: true, pass: s.length > 0 && s.length <= 120 && s !== s.toUpperCase() && !/^(re|fwd?):/i.test(s), label: "Subject is present, honest and under 120 characters" });
  } else if (d.channel !== "linkedin") {
    out.push({ id: "phone_ok", blocking: true, pass: !c.doNotCall && !!c.phone, label: c.doNotCall ? "Contact is on the do-not-call list" : !c.phone ? "Contact has no phone number" : c.phoneType === "mobile" ? "Mobile number: dial by hand, do not use an auto-dialer" : "Business line, not on the do-not-call list", warn: c.phoneType === "mobile" });
  }
  const named = db.refs.filter((r) => !r.permission).find((r) => text.toLowerCase().includes(r.named.toLowerCase()));
  out.push({ id: "no_named_client", blocking: true, pass: !named, label: named ? `Names a client without permission: “${named.named}”` : "No client named without permission" });
  const max = d.channel === "linkedin" ? 300 : 1200;
  out.push({ id: "length", blocking: d.channel === "linkedin", pass: d.body.length <= max, label: d.channel === "linkedin" ? `Under LinkedIn's 300-character limit (${d.body.length})` : `Short enough to read on a phone (${d.body.length} of ${max} characters)` });
  const claim = text.match(/guarantee\w*|100%|never fail\w*|worst|incompetent/i);
  out.push({ id: "claims", blocking: false, pass: !claim, label: claim ? `AI flag: absolute claim or disparagement (“${claim[0]}”)` : "No guarantees or digs at the current provider (AI check)" });
  return out;
}

/* meeting time finder: real calendar, drive time between stops */
function busyFor(db, uid) { return [...db.events.filter((e) => e.userId === uid), ...db.meetings.filter((m) => m.ownerId === uid && m.status === "scheduled").map((m) => ({ ...m, crm: true }))].sort((x, y) => x.start - y.start); }
function findSlots(db, me, a, durH, now = Date.now()) {
  const days = bizDays(now, 10), busy = busyFor(db, me.id), pref = (primary(a) || {}).pref || "";
  const morning = /morning|before 9|before 10/i.test(pref), afternoon = /afternoon|after 2|after 1/i.test(pref);
  const out = [];
  days.forEach((day, di) => {
    const mine = busy.filter((b) => startOfDay(b.start) === day);
    for (let h = 8; h + durH <= 17.5; h += 0.5) {
      const start = atH(day, h), end = start + durH * H;
      if (start < now + 2 * H) continue;
      if (mine.some((b) => start < b.end && end > b.start)) continue;
      const prev = [...mine].reverse().find((b) => b.end <= start), next = mine.find((b) => b.start >= end);
      const from = prev && prev.city ? prev.city : me.base;
      const dIn = drive(from, a.city);
      if ((prev ? prev.end : atH(day, 7.5)) + dIn * 60000 > start) continue;
      const dOut = next && next.city ? drive(a.city, next.city) : 0;
      if (next && end + dOut * 60000 > next.start) continue;
      let score = 100 - di * 6 - dIn / 3 - dOut / 3;
      if (morning) score += h < 12 ? 15 : -10; if (afternoon) score += h >= 13 ? 15 : -10;
      out.push({ day, start, end, score, why: [`${dIn} min drive from ${prev && prev.city ? prev.city : "the office"}`, next ? `${dOut ? `${dOut} min to` : "clear before"} your ${fmtTime(next.start)} ${lc1(next.title)}` : "nothing after it", (morning && h < 12) || (afternoon && h >= 13) ? `matches “${lc1(pref)}”` : null].filter(Boolean) });
    }
  });
  const picked = [];
  out.sort((x, y) => y.score - x.score).forEach((s) => { if (picked.length < 3 && !picked.some((p) => p.day === s.day)) picked.push(s); });
  return picked.sort((x, y) => x.start - y.start);
}

function makePrep(db, a, m, me) {
  const cfg = liveCfg(db), d = openDeal(db, a.id), pr = price((d && d.pkg) || DEFAULT_PKG[a.type], cfg), r = refFor(db, a), first = topSignal(a);
  return [
    { h: "Goal", t: `Walk the site, confirm the problem${first ? ` (${lc1(first).replace(/\.$/, "")})` : ""} and agree on next steps toward a proposal by end of week.` },
    { h: "Who you're meeting", t: a.contacts.map((c) => `${c.first} ${c.last}, ${c.title || ""}.${c.pref ? ` ${c.pref}.` : ""}`).join("\n") },
    { h: "Agenda", t: "- 5 min: their goals and what's not working\n- 15 min: walk gates, docks, parking and blind spots\n- 5 min: show the client portal on your phone\n- 5 min: agree on next steps" },
    { h: "Questions to ask", t: `${first ? `- What happened with: ${lc1(first).replace(/\.$/, "")}?\n` : ""}- Who needs to approve a change, and by when?\n- What does the current setup cost per month?\n- What would make the first 30 days a success?` },
    { h: "Bring", t: `${r ? `Proof point: ${r.anon}, ${r.comp}% patrol compliance. ` : ""}Price range: ${moneyK(pr.annual * 0.9)} to ${moneyK(pr.annual * 1.1)} a year.` },
    { h: "Logistics", t: `${fmtDT(m.start)}, ${m.where}. Allow ${drive(me.base, a.city)} min from the office.`, system: "Written by code from the calendar and drive time." },
  ];
}

/* next best actions: rules, not AI */
function nextActions(db, me, now = Date.now()) {
  const out = [], mineA = (id) => { const a = acct(db, id); return a && !a.deleted && a.ownerId === me.id ? a : null; };
  db.meetings.filter((m) => m.ownerId === me.id && m.status === "scheduled" && m.start > now && m.start < nextDay(bizDays(nextDay(startOfDay(now)), 1)[0])).forEach((m) => out.push({ pri: 0, aid: m.accountId, tab: "meetings", text: `${m.title} ${/^(today|tomorrow)$/.test(dayWord(m.start, now)) ? dayWord(m.start, now) : `on ${dayWord(m.start, now)}`} at ${fmtTime(m.start)}. Your prep brief is ready.`, cta: "Open prep brief", val: 0 }));
  db.deals.filter((d) => d.status === "open" && d.ownerId === me.id).forEach((d) => {
    const a = mineA(d.accountId); if (!a) return;
    const c = primary(a) || { first: "The contact", last: "" }, name = `${c.first} ${c.last}`.trim();
    const mails = db.emails.filter((e) => e.accountId === a.id).sort((x, y) => y.at - x.at);
    const lastOut = mails.find((e) => e.dir === "out"), lastIn = mails.find((e) => e.dir === "in");
    const prop = db.proposals.filter((p) => p.dealId === d.id && p.status !== "draft").slice(-1)[0], con = db.contracts.filter((k) => k.dealId === d.id).slice(-1)[0];
    const push = (pri, text, cta, tab, extra = {}) => out.push({ pri, aid: a.id, text, cta, tab, val: d.value, ...extra });
    if (lastIn && lastIn.cls === "interested" && (!lastOut || lastOut.at < lastIn.at)) push(1, `${name} replied and sounds interested.`, "Reply", "outreach");
    else if (d.stage === "contract_sent" && con && con.views >= 1 && daysSince(con.sentAt, now) >= 2) push(1, `${name} viewed the ${a.name} contract ${plural(con.views, "time")} but hasn't signed (sent ${ago(con.sentAt)}).`, "Draft nudge", "outreach");
    else if (d.stage === "proposal" && prop && prop.views.length >= 2 && daysSince(d.lastAt, now) >= 2) push(2, `${name} has opened the proposal ${prop.views.length} times. Call while it's fresh.`, "Open call script", "outreach", { channel: "call" });
    else if (d.stage === "proposal" && prop && daysSince(prop.sentAt, now) >= 5) push(2, `${a.name}: proposal sent ${daysSince(prop.sentAt, now)} days ago with no reply.`, "Draft follow-up", "outreach");
    else if (d.stage === "contacted" && lastOut && daysSince(lastOut.at, now) >= 4 && mails.filter((e) => e.dir === "out").length < 3) push(3, `No reply from ${name} in ${daysSince(lastOut.at, now)} days.`, "Draft follow-up", "outreach");
    else if (d.stage === "researched") push(3, `${a.name} is researched but not contacted.${topSignal(a) ? ` Lead with: ${lc1(topSignal(a))}` : ""}`, "Start outreach", "outreach");
    else if (d.stage === "lead") push(4, `${a.name} needs research before outreach.`, "Research", "research");
  });
  db.tasks.filter((t) => t.ownerId === me.id && !t.done && (!t.due || t.due < nextDay(startOfDay(now)))).forEach((t) => out.push({ pri: 4, aid: t.accountId, tab: "timeline", text: `Task: ${t.title}`, cta: "Open", val: 0, taskId: t.id }));
  return out.sort((x, y) => x.pri - y.pri || y.val - x.val);
}

/* ───────── seed data: every company and person here is fictional ───────── */
function seed() {
  const now = Date.now(), days = bizDays(now, 10), D = 24 * H;
  const db = { seq: 100, company: { address: "1200 Example Pkwy, Suite 400, Dallas, TX 75201" }, users: [], accounts: [], deals: [], activities: [], tasks: [], drafts: [], emails: [], suppressions: [], meetings: [], events: [], proposals: [], contracts: [], pricing: [], refs: [], audit: [], aiCalls: [], imports: [] };
  db.pricing.push({ id: "pc1", from: now - 60 * D, unarmed: 2900, armed: 3800, sup: 1.05, cover: { "24_7": 168, nights: 84, business_hours: 60 }, addons: { patrol: { label: "Mobile patrol, 3 visits a night", mo: 145000 }, video: { label: "Remote video monitoring", mo: 220000 }, portal: { label: "Client portal with live officer map", mo: 0 } }, term: { 12: 0, 24: 0.03, 36: 0.05 }, maxDisc: 0.1 });
  const U = (id, name, role, title) => db.users.push({ id, name, email: `${name.toLowerCase().replace(" ", ".")}@soa-demo.example`, role, title, phone: `(214) 555-01${String(db.users.length).padStart(2, "0")}`, base: "Dallas HQ", cap: 50, active: true, connected: true, startH: 8, endH: 17.5 });
  U("u1", "Jordan Reyes", "ae", "Account Executive"); U("u2", "Sam Patel", "ae", "Account Executive"); U("u3", "Priya Nair", "ae", "Account Executive"); U("u4", "Marcus Lee", "ae", "Account Executive"); U("u5", "Elena Cruz", "ae", "Account Executive"); U("u6", "Dana Whitfield", "manager", "Sales Manager"); U("u7", "Alex Morgan", "admin", "Systems Administrator");
  db.refs.push({ id: "r1", named: "Titanium Logistics Hub", anon: "a logistics hub we protect in Irving", types: ["Industrial", "Construction site", "Retail", "Self storage"], comp: 98.4, resp: 4, permission: false, active: true });
  db.refs.push({ id: "r2", named: "Harbor Pharma Campus", anon: "a pharma campus we protect in Dallas", types: ["Cold chain warehouse", "Medical office"], comp: 98.8, resp: 3, permission: false, active: true });
  db.refs.push({ id: "r3", named: "Apex Financial Center", anon: "a financial center we protect in Dallas", types: ["Class A office", "Data center", "Multifamily", "Hospitality"], comp: 99.1, resp: 3, permission: true, active: true });
  const A = (name, type, city, ownerCo, size, built, occ, provider, timing, endDays, ownerId, contacts, signals, web) => {
    const id = nid(db, "a"), sid = nid(db, "s");
    const a = { id, name, type, city, ownerCo, size, built, occ, provider, timing, contractEnd: endDays ? now + endDays * D : null, website: `${name.toLowerCase().replace(/[^a-z]+/g, "")}.example`, ownerId, source: "csv", createdAt: now - 30 * D, doNotContact: false,
      contacts: contacts.map((c, i) => ({ id: nid(db, "c"), first: c[0], last: c[1], title: c[2], email: `${c[0].toLowerCase()}.${c[1].toLowerCase()}@${name.toLowerCase().replace(/[^a-z]+/g, "")}.example`, phone: `(972) 555-01${String(10 + db.seq % 80)}`, phoneType: c[4] || "business", pref: c[3] || "", primary: i === 0, emailStatus: "ok", doNotCall: false })),
      sources: signals.length ? [{ id: sid, kind: "upload", title: "Prospect list notes (imported)", text: signals.map((s) => s[0]).join(". ") + ".", at: now - 30 * D }] : [],
      signals: signals.map((s) => ({ id: nid(db, "g"), text: s[0], kind: s[1], confirmed: s[2] !== false, sourceId: sid, ai: false })), briefs: [], web: web || null };
    db.accounts.push(a); return a;
  };
  const Dl = (a, stage, extra = {}) => { const pkg = DEFAULT_PKG[a.type]; const d = { id: nid(db, "d"), accountId: a.id, ownerId: a.ownerId, stage, status: stage === "won" ? "won" : "open", pkg, value: price(pkg, liveCfg(db)).annual, stageAt: now - 3 * D, lastAt: now - 3 * D, createdAt: now - 20 * D, ...extra }; db.deals.push(d); return d; };
  const mail = (a, d, uid, dir, daysAgo, subject, body, cls) => db.emails.push({ id: nid(db, "e"), accountId: a.id, dealId: d.id, contactId: a.contacts[0].id, userId: uid, dir, status: dir === "out" ? "sent" : "received", subject, body, at: now - daysAgo * D, cls: cls || null, to: dir === "out" ? a.contacts[0].email : userOf(db, uid).email });
  const prop = (a, d, daysAgo, views) => { const p = { id: nid(db, "p"), dealId: d.id, accountId: a.id, version: 1, status: views ? "viewed" : "sent", pkg: d.pkg, pricing: price(d.pkg, liveCfg(db)), cfgId: "pc1", manual: 0, approvedBy: null, note: `Thank you for walking the site with us. This proposal covers ${a.name}.`, pdf: true, token: nid(db, "tok"), sentAt: now - daysAgo * D, views: Array.from({ length: views }, (_, i) => now - (daysAgo - 1) * D + i * 5 * H), createdBy: d.ownerId }; db.proposals.push(p); return p; };

  const a1 = A("Meridian Logistics Park", "Industrial", "Irving", "Meridian Industrial Trust", "640,000 sq ft, 4 buildings", 2019, 92, "Regional guard company", "Contract ends in about 80 days", 80, "u1", [["Dana", "Okafor", "Director of Property Operations", "Prefers morning meetings"], ["Luis", "Mendez", "Facilities Manager", ""]], [["Two cargo thefts in the park in the last 90 days", "incident"], ["Current guard contract ends in about 80 days", "timing"], ["Tenants asked for after-hours gate control", "tenant"]]);
  const a2 = A("Northgate Distribution Center", "Industrial", "Fort Worth (Alliance)", "Northgate Realty Partners", "410,000 sq ft", 2016, 100, "In-house night watch", "Budget cycle starts next quarter", 0, "u1", [["Alicia", "Moreno", "General Manager", "Best reached by phone after 2 pm"]], [["A trailer was stolen from the yard last month", "incident"], ["Night watch is one in-house employee with no reporting", "other"]]);
  const a3 = A("Oak Lawn Tower (construction)", "Construction site", "Oak Lawn, Dallas", "Crestline Builders", "22-storey tower, topping out soon", null, null, "None", "Topping out in 6 weeks", 0, "u1", [["Sara", "Kim", "Project Executive", ""]], [["Copper wire theft reported on site twice this quarter", "incident"], ["Insurer requires overnight security from topping out", "timing"]]);
  const a4 = A("Lakeview Medical Plaza", "Medical office", "Plano", "Lakeview Health Properties", "120,000 sq ft, 3 buildings", 2011, 88, "Cameras only", "New tenant opens in 60 days", 60, "u1", [["Grace", "Liu", "Property Manager", "Prefers afternoon meetings"]], [["New pharmacy tenant needs a staffed lobby", "tenant"], ["Car break-ins in the parking structure", "incident"]]);
  const a5 = A("Trinity Cold Storage", "Cold chain warehouse", "Garland", "Trinity Cold Chain LLC", "280,000 sq ft", 2020, 95, "National guard company", "Contract renews in about 100 days", 100, "u1", [["Omar", "Haddad", "VP Operations", ""]], [["Customer audit flagged gaps in overnight patrol records", "incident"], ["Contract renews in about 100 days", "timing"]]);
  const a6 = A("Cedar Ridge Apartments", "Multifamily", "Arlington", "Cedar Ridge Living", "312 units", 2008, 94, "None", "", 0, "u1", [["Tina", "Brooks", "Community Manager", ""]], [], { text: "Cedar Ridge Apartments is a 312-unit community in Arlington managed by Cedar Ridge Living. Residents were notified in the latest newsletter about a series of vehicle break-ins in the east lot and a plan to add controlled gate access this year.", facts: [["Series of vehicle break-ins in the east parking lot", "incident"], ["Plans to add controlled gate access this year", "timing"]] });
  const a7 = A("Frisco Station Offices", "Class A office", "Frisco", "Frisco Station Holdings", "510,000 sq ft, 2 towers", 2021, 81, "National guard company", "Contract ends in about 45 days", 45, "u2", [["Henry", "Walsh", "Asset Manager", ""]], [["Tenant complaints about lobby coverage gaps", "incident"], ["Contract ends in about 45 days", "timing"]]);
  const a8 = A("Grapevine Mills Annex", "Retail", "Grapevine", "Annex Retail Group", "190,000 sq ft", 2004, 90, "Regional guard company", "", 0, "u2", [["Mia", "Ford", "Operations Director", ""]], [["Organised retail theft incidents up this year", "incident"]]);
  const a9 = A("Lancaster Data Campus", "Data center", "Lancaster", "Lancaster Digital", "3 halls, 40 MW", 2023, null, "In-house", "Second hall opens next quarter", 0, "u2", [["Ravi", "Shah", "Head of Critical Facilities", ""]], [["Second data hall opens next quarter and needs armed access control", "timing"]]);
  A("Mesquite Self Storage", "Self storage", "Mesquite", "Lone Star Storage Co", "640 units", 1999, 86, "Cameras only", "", 0, null, [["Paul", "Greer", "Regional Manager", ""]], [["Unit break-ins reported three weekends in a row", "incident"]]);
  A("Uptown Grand Hotel", "Hospitality", "Uptown Dallas", "Grand Hospitality Group", "240 rooms", 2015, null, "Regional guard company", "Contract ends in about 110 days", 110, null, [["Nora", "Castillo", "General Manager", "Prefers morning meetings"]], [["Guest vehicle thefts from the valet garage", "incident"], ["Contract ends in about 110 days", "timing"]]);
  A("Plano Tech Commons", "Class A office", "Plano", "Commons Property Trust", "330,000 sq ft", 2018, 77, "National guard company", "", 0, null, [["Ethan", "Cole", "Property Director", ""]], []);
  A("Arlington Freight Yard", "Industrial", "Arlington", "Freightline Properties", "55 acres", 1995, 100, "None", "", 0, null, [["Rosa", "Vega", "Yard Manager", "", "mobile"]], [["Fence cut twice in the past two months", "incident", false]]);
  const a14 = A("Garland Commerce Center", "Industrial", "Garland", "Commerce Center Partners", "300,000 sq ft", 2012, 97, "Security Of America", "Signed this quarter", 0, "u1", [["Kofi", "Mensah", "Managing Partner", ""]], [["Switched after repeated missed patrols by the previous company", "incident"]]);

  const d1 = Dl(a1, "meeting_set"), d2 = Dl(a2, "contacted", { lastAt: now - 5 * D }), d3 = Dl(a3, "contract_sent"), d4 = Dl(a4, "proposal", { lastAt: now - 6 * D }), d5 = Dl(a5, "researched");
  Dl(a6, "lead"); const d7 = Dl(a7, "proposal", { lastAt: now - 3 * D }), d8 = Dl(a8, "contacted", { lastAt: now - 1 * D }); Dl(a9, "lead"); Dl(a14, "won", { stageAt: now - 12 * D });
  [a1, a2, a3, a4, a5, a7, a8, a14].forEach((a) => { const b = makeBrief(db, a); a.briefs.push({ id: nid(db, "b"), version: 1, sections: b.sections, pkg: b.pkg, by: a.ownerId, at: now - 14 * D }); });
  mail(a1, d1, "u1", "out", 9, "Meridian: two cargo thefts in the park", "Hi Dana,\n\nI'm reaching out because I understand there have been two cargo thefts in the park in the last 90 days.\n\nCould I walk the property with you for 30 minutes?", null);
  mail(a1, d1, "u1", "in", 8, "Re: Meridian: two cargo thefts in the park", "Jordan, yes, this is on my list. Let's find a time next week. Mornings are best.", "interested");
  mail(a1, d1, "u1", "out", 8, "Re: Meridian: two cargo thefts in the park", "Thanks Dana. I've sent an invite for a site walk.", null);
  mail(a2, d2, "u1", "out", 5, "Northgate: trailer theft from the yard", "Hi Alicia,\n\nI'm reaching out because I understand a trailer was stolen from the yard last month.\n\nCould I walk the property with you for 30 minutes?", null);
  mail(a8, d8, "u2", "out", 2, "Grapevine Mills Annex: retail theft", "Hi Mia,\n\nI'm reaching out because organised retail theft incidents are up this year.", null);
  mail(a8, d8, "u2", "in", 1, "Re: Grapevine Mills Annex: retail theft", "Sam, good timing. Can you send two times for a call this week?", "interested");
  const p3 = prop(a3, d3, 5, 3); p3.status = "accepted"; prop(a4, d4, 6, 0); prop(a7, d7, 4, 3);
  db.contracts.push({ id: nid(db, "k"), dealId: d3.id, accountId: a3.id, proposalId: p3.id, status: "viewed", signerId: a3.contacts[0].id, views: 4, sentAt: now - 3 * D, signedAt: null, startDate: now + 21 * D, by: "u1" });
  const day1 = days[0] === startOfDay(now) ? days[1] : days[0];
  db.meetings.push({ id: nid(db, "m"), accountId: a1.id, dealId: d1.id, ownerId: "u1", contactIds: [a1.contacts[0].id], title: `Site walk: ${a1.name}`, kind: "site_walk", status: "scheduled", start: atH(day1, 10), end: atH(day1, 11), where: `${a1.name}, ${a1.city}`, city: a1.city, prep: null });
  db.meetings[0].prep = makePrep(db, a1, db.meetings[0], db.users[0]);
  const E = (uid, di, h, dur, title, city) => db.events.push({ id: nid(db, "ev"), userId: uid, title, start: atH(days[di], h), end: atH(days[di], h + dur), city: city || null });
  E("u1", 0, 15, 1, "Pipeline review with sales director", "Dallas HQ"); E("u1", 1, 14, 1, "Dentist", "Plano"); E("u1", 2, 9, 1.5, "Team stand-up and training", "Dallas HQ"); E("u1", 2, 13, 1, "Client lunch", "Uptown Dallas"); E("u1", 3, 11, 1, "Vendor call", null); E("u1", 4, 8.5, 1, "Forecast call", null); E("u1", 6, 10, 2, "Trade association event", "Frisco");
  E("u2", 0, 10, 1, "Pipeline review", "Dallas HQ"); E("u2", 1, 13, 1.5, "Site visit follow-up", "Grapevine"); E("u2", 3, 9, 1, "Team stand-up", "Dallas HQ");
  db.tasks.push({ id: nid(db, "t"), ownerId: "u1", accountId: a5.id, title: "Call Omar about the audit findings", due: now, done: false });
  db.suppressions.push({ email: "old.contact@formerprospect.example", reason: "unsubscribe", at: now - 40 * D, by: null });
  const hist = (a, type, text, daysAgo, uid) => db.activities.push({ id: nid(db, "act"), accountId: a.id, userId: uid || a.ownerId, type, text, at: now - daysAgo * D });
  hist(a1, "note", "Imported from prospect list", 30); hist(a1, "email_out", "Email sent to Dana Okafor", 9); hist(a1, "email_in", "Reply from Dana Okafor (interested)", 8); hist(a1, "meeting", "Site walk booked", 8);
  hist(a2, "email_out", "Email sent to Alicia Moreno", 5); hist(a3, "proposal", "Proposal v1 sent", 5); hist(a3, "contract", "Contract sent for signature", 3); hist(a4, "proposal", "Proposal v1 sent", 6); hist(a14, "contract", "Contract signed. Deal won.", 12);
  audit(db, db.users[6], "pricing.create", "Initial pricing loaded (unconfirmed demo numbers)");
  return db;
}

/* ───────── app context and small UI kit ───────── */
const Ctx = createContext(null);
const useApp = () => useContext(Ctx);
const inp = "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500";
const TONES = { g: "border-emerald-800 bg-emerald-950/60 text-emerald-300", a: "border-amber-800 bg-amber-950/60 text-amber-300", b: "border-blue-800 bg-blue-950/60 text-blue-300", r: "border-red-800 bg-red-950/60 text-red-300", z: "border-zinc-700 bg-zinc-800/60 text-zinc-300" };
const Pill = ({ tone = "z", children, title }) => <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${TONES[tone]}`}>{children}</span>;
const KINDS = { default: "border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700", primary: "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-500", ai: "border-blue-600 bg-blue-600 text-white hover:bg-blue-500", danger: "border-red-800 bg-red-950 text-red-200 hover:bg-red-900", ghost: "border-transparent text-zinc-300 hover:bg-zinc-800", demo: "border-dashed border-amber-700 bg-amber-950/40 text-amber-200 hover:bg-amber-900/40" };
function Btn({ kind = "default", icon: I, busy, children, className = "", small, ...p }) {
  return <button type="button" {...p} disabled={p.disabled || busy} className={`inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${small ? "px-2 py-1 text-xs" : "px-3 py-2 text-sm"} ${KINDS[kind]} ${className}`}>{busy ? <Loader size={14} className="animate-spin" /> : I ? <I size={14} /> : null}{children}</button>;
}
function Panel({ title, icon: I, right, children, className = "", pad = true }) {
  return <section className={`min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/60 ${className}`}>{title && <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-3">{I && <I size={16} className="text-zinc-400" />}<h2 className="text-sm font-semibold text-zinc-100">{title}</h2><div className="ml-auto flex flex-wrap items-center gap-2">{right}</div></header>}<div className={pad ? "p-4" : ""}>{children}</div></section>;
}
function Modal({ title, onClose, children, wide }) {
  useEffect(() => { const k = (e) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:p-8" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div role="dialog" aria-label={title} className={`w-full ${wide ? "max-w-3xl" : "max-w-lg"} rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl`}><header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3"><h2 className="text-sm font-semibold text-zinc-100">{title}</h2><button onClick={onClose} aria-label="Close" className="ml-auto rounded p-1 text-zinc-400 hover:bg-zinc-800"><X size={16} /></button></header><div className="p-4">{children}</div></div></div>;
}
const Field = ({ label, children, hint }) => <label className="block text-xs text-zinc-400"><span className="mb-1 block">{label}</span>{children}{hint && <span className="mt-1 block text-zinc-500">{hint}</span>}</label>;
const Empty = ({ children }) => <p className="rounded-lg border border-dashed border-zinc-800 px-4 py-6 text-center text-sm text-zinc-500">{children}</p>;
const Stat = ({ label, value, sub, tone = "text-zinc-100" }) => <div className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4"><p className="text-xs text-zinc-400">{label}</p><p className={`mt-1 text-2xl font-semibold ${tone}`}>{value}</p>{sub && <p className="mt-1 text-xs text-zinc-500">{sub}</p>}</div>;
const AiNote = ({ children }) => <p className="flex items-start gap-1.5 text-xs text-blue-300/80"><Sparkles size={12} className="mt-0.5 shrink-0" />{children}</p>;
const DemoNote = ({ children }) => <p className="flex items-start gap-1.5 text-xs text-amber-300/80"><Flask size={12} className="mt-0.5 shrink-0" />{children}</p>;
const StagePill = ({ d }) => (d.status === "lost" ? <Pill tone="r">Lost</Pill> : <Pill tone={d.stage === "won" ? "g" : stageIdx(d.stage) >= 4 ? "a" : "b"}>{stageOf(d.stage).label}</Pill>);
const Lines = ({ t }) => <div className="space-y-1 text-sm text-zinc-300">{t.split("\n").map((l, i) => (l.startsWith("- ") ? <p key={i} className="flex gap-2"><span className="text-zinc-600">•</span><span>{l.slice(2)}</span></p> : <p key={i}>{l || " "}</p>))}</div>;

/* ───────── sign-in ───────── */
function Login({ db, onPick }) {
  const [step, setStep] = useState(0);
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6">
        <div className="flex items-center gap-2"><Shield size={22} className="text-emerald-400" /><div><h1 className="text-lg font-semibold text-zinc-100">Security Of America · Sales CRM</h1><p className="text-xs text-zinc-400">Private workspace for the sales team</p></div></div>
        {step === 0 && <div className="mt-6 space-y-3">
          <Btn kind="primary" icon={Lock} className="w-full" onClick={async () => { setStep(1); await sleep(900); setStep(2); }}>Sign in with Microsoft</Btn>
          <p className="text-xs text-zinc-500">The CRM stores no passwords. Sign-in and two-factor are handled by the company login, and the same consent connects your mailbox and calendar.</p>
        </div>}
        {step === 1 && <p className="mt-6 flex items-center gap-2 text-sm text-zinc-300"><Loader size={16} className="animate-spin" />Redirecting to company sign-in…</p>}
        {step === 2 && <div className="mt-6">
          <DemoNote>Demo: choose who to sign in as. Try an account executive, then the manager, to see what each can see.</DemoNote>
          <ul className="mt-3 space-y-2">{db.users.filter((u) => u.active).map((u) => <li key={u.id}><button onClick={() => onPick(u.id)} className="flex w-full items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-left hover:border-zinc-600"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-800 text-xs font-semibold text-zinc-200">{initials(u.name)}</span><span className="min-w-0 flex-1"><span className="block text-sm text-zinc-100">{u.name}</span><span className="block truncate text-xs text-zinc-500">{u.email}</span></span><Pill tone={u.role === "ae" ? "b" : u.role === "manager" ? "g" : "a"}>{u.role === "ae" ? "Account executive" : u.role === "manager" ? "Manager" : "Admin"}</Pill></button></li>)}</ul>
        </div>}
      </div>
    </div>
  );
}

/* ───────── Today ───────── */
function Today() {
  const { db, me, go, update } = useApp();
  const now = Date.now();
  const mine = db.deals.filter((d) => (isMgr(me) ? true : d.ownerId === me.id));
  const open = mine.filter((d) => d.status === "open");
  const weighted = open.reduce((n, d) => n + d.value * stageOf(d.stage).p, 0);
  const days = bizDays(now, 5);
  const showDay = days[0];
  const myBusy = busyFor(db, me.id);
  const todays = myBusy.filter((b) => startOfDay(b.start) === showDay);
  const meetWeek = db.meetings.filter((m) => m.ownerId === me.id && m.status === "scheduled" && m.accountId && m.start >= days[0] && m.start < nextDay(days[4]));
  const won = mine.filter((d) => d.status === "won");
  const actions = nextActions(db, me, now);
  const PRI = ["g", "a", "a", "b", "z"];
  return (
    <div className="space-y-4">
      {!me.connected && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-800 bg-amber-950/50 px-4 py-3 text-sm text-amber-200"><Alert size={16} />Your mailbox connection expired. Sending and reply tracking are paused.<Btn small onClick={() => go("settings")}>Reconnect</Btn></div>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={isMgr(me) ? "Team open pipeline" : "Open pipeline"} value={moneyK(open.reduce((n, d) => n + d.value, 0))} sub={plural(open.length, "deal")} tone="text-blue-300" />
        <Stat label="Weighted forecast" value={moneyK(weighted)} sub="Value × stage probability" tone="text-amber-300" />
        <Stat label="Your customer meetings, next 5 days" value={meetWeek.length} sub={meetWeek[0] ? `Next: ${dayWord(meetWeek[0].start)} ${fmtTime(meetWeek[0].start)}` : "None booked"} tone="text-emerald-300" />
        <Stat label="Won this quarter" value={moneyK(won.reduce((n, d) => n + d.value, 0))} sub={`${won.length} signed`} tone="text-emerald-300" />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Next best actions" icon={Target} className="lg:col-span-2" right={<Pill>Rules, not AI: same result every time</Pill>}>
          {actions.length === 0 ? <Empty>Nothing needs you right now. Find new prospects to work.</Empty> : <ul className="space-y-2">{actions.map((x, i) => { const a = x.aid && acct(db, x.aid); return <li key={i} className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"><Pill tone={PRI[x.pri]}>P{x.pri}</Pill><div className="min-w-0 flex-1"><p className="text-sm font-medium text-zinc-100">{a ? a.name : "Task"}</p><p className="text-sm text-zinc-400">{x.text}</p></div>{x.taskId && <Btn small icon={Check} onClick={() => update((d) => { d.tasks.find((t) => t.id === x.taskId).done = true; })}>Done</Btn>}{a && <Btn small kind={x.pri <= 1 ? "primary" : "default"} onClick={() => go("account", { id: a.id, tab: x.tab, channel: x.channel })}>{x.cta}</Btn>}</li>; })}</ul>}
        </Panel>
        <Panel title={`${startOfDay(now) === showDay ? "Today's" : fmtDay(showDay) + "'s"} schedule`} icon={Calendar}>
          {todays.length === 0 ? <Empty>Nothing on the calendar.</Empty> : <ul className="space-y-2">{todays.map((b) => <li key={b.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"><p className="text-sm text-zinc-100">{fmtTime(b.start)} · {b.title}</p><p className="text-xs text-zinc-500">{b.crm ? "CRM meeting" : "From your calendar"}{b.city ? ` · ${b.city}` : ""}</p></li>)}</ul>}
          <button onClick={() => go("calendar")} className="mt-3 text-xs text-blue-300 hover:underline">Open calendar</button>
        </Panel>
      </div>
    </div>
  );
}

/* ───────── Prospect finder ───────── */
const SAMPLE_CSV = `account name,property type,city,owner company,size,current provider,contact first name,contact last name,contact title,contact email,signal
Irving Gateway Plaza,Retail,Irving,Gateway Retail Partners,"210,000 sq ft",Regional guard company,Jamal,Reed,Property Manager,jamal.reed@irvinggateway.example,Parking lot assaults reported this spring
Garland Rail Depot,Industrial,Garland,Depot Holdings,38 acres,None,Wei,Zhang,Site Director,wei.zhang@garlandrail.example,Copper theft from rail spur
Frisco Medical Pavilion,Medical office,Frisco,Pavilion Health REIT,"95,000 sq ft",Cameras only,Ana,Silva,Practice Administrator,ana.silva@friscopavilion.example,
Downtown Lofts on Elm,Multifamily,Downtown Dallas,Elm Street Living,180 units,In-house,Chris,Nguyen,Community Manager,chris.nguyen@elmlofts.example,Package thefts and tailgating at the garage
Plano Tech Commons,Class A office,Plano,Commons Property Trust,"330,000 sq ft",National guard company,Ethan,Cole,Property Director,ethan.cole@planotech.example,
,Retail,Mesquite,Unknown,,,,,,,
Mesquite Town Square,Shopping,Mesquite,Town Square LLC,,,Lee,Park,Manager,not-an-email,`;
function parseCsv(text) {
  const rows = text.trim().split(/\r?\n/).map((line) => { const out = []; let cur = "", q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === "," && !q) { out.push(cur.trim()); cur = ""; } else cur += ch; } out.push(cur.trim()); return out; });
  const head = rows.shift().map((h) => h.toLowerCase());
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] || ""])));
}
function ImportModal({ onClose }) {
  const { db, me, update, toast } = useApp();
  const [text, setText] = useState(""); const [assign, setAssign] = useState(false); const [busy, setBusy] = useState(false);
  const rows = useMemo(() => { try { return text.trim() ? parseCsv(text) : []; } catch (e) { return []; } }, [text]);
  const judged = rows.map((r) => {
    const name = r["account name"], city = r.city;
    if (!name) return { r, bad: "Missing account name" };
    if (r["property type"] && !TYPES.includes(r["property type"])) return { r, bad: `Unknown property type “${r["property type"]}”` };
    if (r["contact email"] && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r["contact email"])) return { r, bad: "Contact email is not valid" };
    if (db.accounts.some((a) => !a.deleted && a.name.toLowerCase() === name.toLowerCase() && (a.city || "").toLowerCase() === (city || "").toLowerCase())) return { r, dup: true };
    return { r };
  });
  const good = judged.filter((j) => !j.bad && !j.dup);
  const run = async () => {
    setBusy(true); await sleep(900);
    update((d) => {
      good.forEach(({ r }) => {
        const sid = nid(d, "s");
        d.accounts.push({ id: nid(d, "a"), name: r["account name"], type: r["property type"] || "Industrial", city: r.city, ownerCo: r["owner company"], size: r.size, built: null, occ: null, provider: r["current provider"], timing: "", contractEnd: null, website: "", ownerId: assign ? me.id : null, source: "csv", createdAt: Date.now(), doNotContact: false,
          contacts: r["contact first name"] ? [{ id: nid(d, "c"), first: r["contact first name"], last: r["contact last name"], title: r["contact title"], email: r["contact email"], phone: "", phoneType: "unknown", pref: "", primary: true, emailStatus: suppressed(d, r["contact email"]) ? "unsubscribed" : "ok", doNotCall: false }] : [],
          sources: r.signal ? [{ id: sid, kind: "upload", title: "Imported CSV row", text: r.signal, at: Date.now() }] : [], signals: r.signal ? [{ id: nid(d, "g"), text: r.signal, kind: "incident", confirmed: false, sourceId: sid, ai: false }] : [], briefs: [], web: null });
      });
      audit(d, me, "import.run", `${good.length} accounts created, ${judged.length - good.length} rows skipped`);
    });
    toast(`Imported ${plural(good.length, "account")}. ${judged.length - good.length} rows skipped.`); onClose();
  };
  return (
    <Modal title="Import prospects from CSV" onClose={onClose} wide>
      <p className="text-sm text-zinc-400">Prospect lists come from a source you've licensed. Paste the file contents, or load the sample.</p>
      <div className="mt-3 flex gap-2"><Btn small icon={FileText} onClick={() => setText(SAMPLE_CSV)}>Load sample file</Btn></div>
      <textarea aria-label="CSV contents" value={text} onChange={(e) => setText(e.target.value)} rows={6} className={`${inp} mt-3 font-mono text-xs`} placeholder="account name,property type,city,…" />
      {rows.length > 0 && <div className="mt-3 space-y-2">
        <div className="flex flex-wrap gap-2"><Pill tone="g">{good.length} new</Pill><Pill tone="a">{judged.filter((j) => j.dup).length} duplicate</Pill><Pill tone="r">{judged.filter((j) => j.bad).length} invalid</Pill></div>
        <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">{judged.map((j, i) => <li key={i} className="flex gap-2 rounded border border-zinc-800 px-2 py-1"><span className="w-10 text-zinc-500">Row {i + 2}</span><span className="flex-1 truncate text-zinc-300">{j.r["account name"] || "(no name)"}{j.r.city ? `, ${j.r.city}` : ""}</span><span className={j.bad ? "text-red-300" : j.dup ? "text-amber-300" : "text-emerald-300"}>{j.bad || (j.dup ? "Already in the CRM (same name and city)" : "Will be created")}</span></li>)}</ul>
        <label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" checked={assign} onChange={(e) => setAssign(e.target.checked)} />Assign the new accounts to me (otherwise they go to the shared pool)</label>
      </div>}
      <div className="mt-4 flex justify-end gap-2"><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" icon={Upload} busy={busy} disabled={!good.length} onClick={run}>Import {good.length || ""} accounts</Btn></div>
    </Modal>
  );
}
function AddAccount({ onClose }) {
  const { db, me, update, go, toast } = useApp();
  const [f, setF] = useState({ name: "", type: TYPES[0], city: CITIES[0], ownerCo: "", provider: "", first: "", last: "", title: "", email: "" });
  const dup = db.accounts.find((a) => !a.deleted && a.name.toLowerCase() === f.name.trim().toLowerCase() && a.city === f.city);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => {
    const newId = `a-new-${Date.now()}`;
    update((d) => { d.accounts.push({ id: newId, name: f.name.trim(), type: f.type, city: f.city, ownerCo: f.ownerCo, size: "", built: null, occ: null, provider: f.provider, timing: "", contractEnd: null, website: "", ownerId: me.id, source: "manual", createdAt: Date.now(), doNotContact: false, contacts: f.first ? [{ id: nid(d, "c"), first: f.first, last: f.last, title: f.title, email: f.email, phone: "", phoneType: "unknown", pref: "", primary: true, emailStatus: "ok", doNotCall: false }] : [], sources: [], signals: [], briefs: [], web: null });
      const pkg = DEFAULT_PKG[f.type]; d.deals.push({ id: nid(d, "d"), accountId: newId, ownerId: me.id, stage: "lead", status: "open", pkg, value: price(pkg, liveCfg(d)).annual, stageAt: Date.now(), lastAt: Date.now(), createdAt: Date.now() });
      log(d, me, newId, "note", "Account created"); });
    toast("Account created and assigned to you."); onClose(); go("account", { id: newId, tab: "research" });
  };
  return (
    <Modal title="Add account" onClose={onClose}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field label="Property or company name"><input className={inp} value={f.name} onChange={set("name")} placeholder="e.g. Riverside Business Park" /></Field></div>
        <Field label="Property type"><select className={inp} value={f.type} onChange={set("type")}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="City"><select className={inp} value={f.city} onChange={set("city")}>{CITIES.map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="Owner or manager"><input className={inp} value={f.ownerCo} onChange={set("ownerCo")} /></Field>
        <Field label="Current security"><input className={inp} value={f.provider} onChange={set("provider")} placeholder="None, In-house, a company…" /></Field>
        <Field label="Contact first name"><input className={inp} value={f.first} onChange={set("first")} /></Field>
        <Field label="Contact last name"><input className={inp} value={f.last} onChange={set("last")} /></Field>
        <Field label="Contact title"><input className={inp} value={f.title} onChange={set("title")} /></Field>
        <Field label="Contact email"><input className={inp} value={f.email} onChange={set("email")} placeholder="name@company.example" /></Field>
      </div>
      {dup && <p role="alert" className="mt-3 text-sm text-amber-300">An account with this name and city already exists{visible(dup, me) ? "." : " and belongs to another rep."}</p>}
      <div className="mt-4 flex justify-end gap-2"><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={!f.name.trim() || !!dup} onClick={save}>Create account</Btn></div>
    </Modal>
  );
}
function Prospects() {
  const { db, me, go, update, toast } = useApp();
  const [q, setQ] = useState(""); const [city, setCity] = useState(""); const [type, setType] = useState(""); const [minFit, setMinFit] = useState(0); const [owner, setOwner] = useState(isMgr(me) ? "all" : "mine_pool"); const [modal, setModal] = useState(null);
  const rows = db.accounts.filter((a) => visible(a, me)).map((a) => ({ a, f: fit(a, db), d: openDeal(db, a.id) }))
    .filter(({ a, f }) => (!q || `${a.name} ${a.ownerCo} ${a.city}`.toLowerCase().includes(q.toLowerCase())) && (!city || a.city === city) && (!type || a.type === type) && f.score >= minFit && (owner === "all" || owner === "mine_pool" ? true : owner === "mine" ? a.ownerId === me.id : owner === "pool" ? !a.ownerId : a.ownerId === owner))
    .sort((x, y) => y.f.score - x.f.score);
  const hidden = db.accounts.filter((a) => !a.deleted && !visible(a, me)).length;
  const claim = (a) => { update((d) => { const x = acct(d, a.id); if (x.ownerId) return; x.ownerId = me.id; const pkg = DEFAULT_PKG[x.type]; if (!openDeal(d, x.id)) d.deals.push({ id: nid(d, "d"), accountId: x.id, ownerId: me.id, stage: "lead", status: "open", pkg, value: price(pkg, liveCfg(d)).annual, stageAt: Date.now(), lastAt: Date.now(), createdAt: Date.now() }); log(d, me, x.id, "owner", `${me.name} claimed this account`); audit(d, me, "account.claim", x.name); }); toast(`${a.name} is now yours.`); };
  return (
    <div className="space-y-4">
      <Panel title="Prospect finder" icon={Search} right={<><Btn small icon={Upload} onClick={() => setModal("import")}>Import CSV</Btn><Btn small kind="primary" icon={Plus} onClick={() => setModal("add")}>Add account</Btn></>}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="lg:col-span-2"><Field label="Search"><input className={inp} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, owner or city" /></Field></div>
          <Field label="City"><select className={inp} value={city} onChange={(e) => setCity(e.target.value)}><option value="">All cities</option>{CITIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Property type"><select className={inp} value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{TYPES.map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Owner"><select className={inp} value={owner} onChange={(e) => setOwner(e.target.value)}>{isMgr(me) ? <option value="all">Everyone</option> : <option value="mine_pool">Mine and unassigned</option>}<option value="mine">Mine</option><option value="pool">Unassigned pool</option>{isMgr(me) && db.users.filter((u) => u.role === "ae").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-zinc-400"><label className="flex items-center gap-2">Minimum fit score <input type="range" min="0" max="80" step="10" value={minFit} onChange={(e) => setMinFit(+e.target.value)} /> <span className="w-6 text-zinc-200">{minFit}</span></label><span className="ml-auto">{plural(rows.length, "account")}{!isMgr(me) && hidden ? ` · ${hidden} owned by other reps are hidden from you` : ""}</span></div>
      </Panel>
      <Panel pad={false}>
        {rows.length === 0 ? <div className="p-4"><Empty>No accounts match. Clear the filters, add an account or import a list.</Empty></div> : <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-sm"><thead className="text-xs text-zinc-500"><tr><th className="px-4 py-2 font-medium">Account</th><th className="px-2 py-2 font-medium">Fit</th><th className="px-2 py-2 font-medium">Why</th><th className="px-2 py-2 font-medium">Stage</th><th className="px-2 py-2 font-medium">Owner</th><th className="px-4 py-2" /></tr></thead>
          <tbody>{rows.map(({ a, f, d }) => <tr key={a.id} className="border-t border-zinc-800 hover:bg-zinc-900"><td className="px-4 py-3"><button className="text-left" onClick={() => go("account", { id: a.id })}><span className="block font-medium text-zinc-100 hover:underline">{a.name}</span><span className="block text-xs text-zinc-500">{a.type} · {a.city}{a.ownerCo ? ` · ${a.ownerCo}` : ""}</span></button></td>
            <td className="px-2 py-3"><span className={`inline-flex h-8 w-10 items-center justify-center rounded-lg border text-sm font-semibold ${f.score >= 60 ? TONES.g : f.score >= 30 ? TONES.a : TONES.z}`}>{f.score}</span></td>
            <td className="px-2 py-3"><div className="flex max-w-xs flex-wrap gap-1">{f.reasons.length ? f.reasons.map((r) => <Pill key={r}>{r}</Pill>) : <span className="text-xs text-zinc-600">No signals yet</span>}</div></td>
            <td className="px-2 py-3">{d ? <StagePill d={d} /> : <span className="text-xs text-zinc-600">No deal</span>}</td>
            <td className="px-2 py-3 text-xs text-zinc-400">{a.ownerId ? userOf(db, a.ownerId).name : <Pill tone="a">Unassigned</Pill>}</td>
            <td className="px-4 py-3 text-right">{!a.ownerId ? <Btn small kind="primary" icon={UserPlus} onClick={() => claim(a)}>Claim</Btn> : <Btn small onClick={() => go("account", { id: a.id })}>Open</Btn>}</td></tr>)}</tbody></table></div>}
      </Panel>
      {modal === "import" && <ImportModal onClose={() => setModal(null)} />}
      {modal === "add" && <AddAccount onClose={() => setModal(null)} />}
    </div>
  );
}

/* ───────── Pipeline ───────── */
function moveStage(update, me, dealId, to, toast) {
  if ((to === "contract_sent" || to === "won") && !isMgr(me)) { toast(`${stageOf(to).label} is set by the system when the contract is ${to === "won" ? "signed" : "sent"}. A manager can override.`, "a"); return; }
  update((d) => { const deal = d.deals.find((x) => x.id === dealId); if (!deal || deal.status !== "open" || deal.stage === to) return;
    const from = deal.stage; deal.stage = to; deal.stageAt = Date.now(); deal.lastAt = Date.now(); if (to === "won") deal.status = "won";
    log(d, me, deal.accountId, "stage", `${me.name} moved the stage from ${stageOf(from).label} to ${stageOf(to).label}`); audit(d, me, "deal.stage", `${acct(d, deal.accountId).name}: ${from} → ${to} (manual)`); });
}
function Pipeline() {
  const { db, me, go, update, toast } = useApp();
  const [owner, setOwner] = useState("all"); const [drag, setDrag] = useState(null); const [over, setOver] = useState(null);
  const deals = db.deals.filter((d) => { const a = acct(db, d.accountId); return a && !a.deleted && d.status !== "lost" && (isMgr(me) ? owner === "all" || d.ownerId === owner : d.ownerId === me.id); });
  const open = deals.filter((d) => d.status === "open");
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Open pipeline" value={moneyK(open.reduce((n, d) => n + d.value, 0))} sub={plural(open.length, "deal")} tone="text-blue-300" />
        <Stat label="Weighted forecast" value={moneyK(open.reduce((n, d) => n + d.value * stageOf(d.stage).p, 0))} sub="Σ value × stage probability" tone="text-amber-300" />
        <Stat label="Won" value={moneyK(deals.filter((d) => d.status === "won").reduce((n, d) => n + d.value, 0))} tone="text-emerald-300" />
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">{isMgr(me) ? <Field label="Show deals for"><select className={inp} value={owner} onChange={(e) => setOwner(e.target.value)}><option value="all">Whole team</option>{db.users.filter((u) => u.role === "ae").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field> : <p className="text-xs text-zinc-400">You see your own deals. Your manager sees the whole team's.</p>}</div>
      </div>
      <p className="text-xs text-zinc-500">Drag a card to move its stage. “Contract sent” and “Won” are set automatically by the e-signature system.</p>
      <div className="overflow-x-auto pb-2"><div className="flex min-w-[1250px] gap-3">
        {STAGES.map((s) => { const col = deals.filter((d) => d.stage === s.id); return (
          <div key={s.id} onDragOver={(e) => { e.preventDefault(); setOver(s.id); }} onDragLeave={() => setOver(null)} onDrop={() => { if (drag) moveStage(update, me, drag, s.id, toast); setDrag(null); setOver(null); }} className={`w-44 shrink-0 rounded-xl border p-2 ${over === s.id ? "border-blue-600 bg-blue-950/20" : "border-zinc-800 bg-zinc-900/40"}`}>
            <div className="mb-2 px-1"><p className="text-xs font-semibold text-zinc-200">{s.label} <span className="font-normal text-zinc-500">· {Math.round(s.p * 100)}%</span></p><p className="text-xs text-zinc-500">{col.length} · {moneyK(col.reduce((n, d) => n + d.value, 0))}</p></div>
            <div className="space-y-2">{col.map((d) => { const a = acct(db, d.accountId); return <div key={d.id} draggable={d.status === "open"} onDragStart={() => setDrag(d.id)} onClick={() => go("account", { id: a.id })} className="cursor-pointer rounded-lg border border-zinc-800 bg-zinc-950 p-2 hover:border-zinc-600"><p className="text-xs font-medium text-zinc-100">{a.name}</p><p className="mt-1 text-xs text-zinc-400">{moneyK(d.value)} a year</p><p className="mt-1 flex items-center justify-between text-xs text-zinc-600"><span>{daysSince(d.stageAt)}d in stage</span><span title={userOf(db, d.ownerId).name} className="rounded-full bg-zinc-800 px-1.5 text-zinc-300">{initials(userOf(db, d.ownerId).name)}</span></p></div>; })}{col.length === 0 && <p className="px-1 py-3 text-center text-xs text-zinc-700">Empty</p>}</div>
          </div>); })}
      </div></div>
    </div>
  );
}

/* ───────── Calendar ───────── */
function CalendarView() {
  const { db, me, go } = useApp();
  const days = bizDays(Date.now(), 10), busy = busyFor(db, me.id);
  return (
    <Panel title="Calendar · next two weeks" icon={Calendar} right={<Pill tone={me.connected ? "g" : "a"}>{me.connected ? "Calendar connected" : "Calendar disconnected"}</Pill>}>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">{days.map((d) => { const list = busy.filter((b) => startOfDay(b.start) === d); return <div key={d} className={`min-h-28 rounded-lg border p-2 ${d === startOfDay(Date.now()) ? "border-blue-700 bg-blue-950/20" : "border-zinc-800 bg-zinc-950/50"}`}><p className="text-xs font-semibold text-zinc-300">{fmtDay(d)}{d === startOfDay(Date.now()) ? " · today" : ""}</p><div className="mt-2 space-y-1">{list.map((b) => <button key={b.id} disabled={!b.crm} onClick={() => b.crm && go("account", { id: b.accountId, tab: "meetings" })} className={`block w-full rounded border px-2 py-1 text-left text-xs ${b.crm ? "border-emerald-800 bg-emerald-950/50 text-emerald-200 hover:border-emerald-600" : "border-zinc-800 bg-zinc-900 text-zinc-400"}`}><span className="block">{fmtTime(b.start)} to {fmtTime(b.end)}</span><span className="block truncate">{b.title}</span></button>)}{list.length === 0 && <p className="text-xs text-zinc-700">Free</p>}</div></div>; })}</div>
      <p className="mt-3 text-xs text-zinc-500">Green = meetings booked from the CRM. Grey = other events read from your own calendar; other reps never see their titles.</p>
    </Panel>
  );
}

/* ───────── Ask Sales AI ───────── */
function askAnswer(db, me, q) {
  const s = q.toLowerCase(), now = Date.now();
  const mineD = db.deals.filter((d) => (isMgr(me) || d.ownerId === me.id) && acct(db, d.accountId) && !acct(db, d.accountId).deleted);
  const item = (d, sub) => ({ label: acct(db, d.accountId).name, sub, aid: d.accountId });
  const named = db.accounts.find((a) => visible(a, me) && s.includes(a.name.toLowerCase().split(" ")[0]));
  if (named && /draft|write|email|follow/.test(s)) return { fn: "accountByName", text: `Open ${named.name} to draft that. Outreach is written and checked on the account page so nothing is sent from here.`, items: [{ label: named.name, sub: "Go to Outreach", aid: named.id, tab: "outreach" }] };
  if (/stall|stuck|quiet|cold/.test(s)) { const l = mineD.filter((d) => d.status === "open" && daysSince(d.lastAt, now) >= 4); return { fn: "stalledDeals(4)", text: l.length ? `${plural(l.length, "deal")} with no activity in 4 or more days.` : "Nothing is stalled.", items: l.map((d) => item(d, `${stageOf(d.stage).label} · quiet for ${daysSince(d.lastAt, now)} days · ${moneyK(d.value)}`)) }; }
  if (/meet|calendar|this week|tomorrow|today/.test(s)) { const l = db.meetings.filter((m) => m.ownerId === me.id && m.status === "scheduled" && m.start > now).sort((a, b) => a.start - b.start); return { fn: "meetingsBetween(now, +14d)", text: l.length ? `You have ${plural(l.length, "customer meeting")} coming up.` : "No customer meetings are booked.", items: l.map((m) => ({ label: m.title, sub: fmtDT(m.start), aid: m.accountId, tab: "meetings" })) }; }
  if (/forecast|pipeline|quota|number/.test(s)) { const o = mineD.filter((d) => d.status === "open"); return { fn: "forecast", text: `Open pipeline is ${moneyK(o.reduce((n, d) => n + d.value, 0))} across ${plural(o.length, "deal")}. Weighted forecast is ${moneyK(o.reduce((n, d) => n + d.value * stageOf(d.stage).p, 0))}.`, items: STAGES.slice(0, 6).map((st) => ({ label: st.label, sub: `${o.filter((d) => d.stage === st.id).length} deals · ${moneyK(o.filter((d) => d.stage === st.id).reduce((n, d) => n + d.value, 0))}` })) }; }
  if (/repl|respond|answer/.test(s)) { const l = db.emails.filter((e) => e.dir === "in" && (isMgr(me) || e.userId === me.id) && daysSince(e.at, now) <= 14); return { fn: "recentReplies(14)", text: l.length ? `${plural(l.length, "reply")} in the last two weeks.` : "No replies in the last two weeks.", items: l.map((e) => ({ label: acct(db, e.accountId).name, sub: `${e.cls || "other"} · ${ago(e.at)}`, aid: e.accountId, tab: "outreach" })) }; }
  if (/best|top|prospect|fit|who should/.test(s)) { const l = db.accounts.filter((a) => visible(a, me)).map((a) => ({ a, f: fit(a, db) })).sort((x, y) => y.f.score - x.f.score).slice(0, 5); return { fn: "topAccountsByFit(5)", text: "The five best-fit accounts you can work, by fit score.", items: l.map(({ a, f }) => ({ label: `${a.name} · ${f.score}`, sub: f.reasons.join(" · ") || "No signals yet", aid: a.id })) }; }
  if (named) { const d = openDeal(db, named.id); return { fn: "accountByName", text: `${named.name}: ${named.type} in ${named.city}. ${d ? `${stageOf(d.stage).label}, ${moneyK(d.value)} a year.` : "No deal yet."}`, items: [{ label: named.name, sub: "Open account", aid: named.id }] }; }
  return { fn: null, text: "I can answer from your CRM data: stalled deals, meetings, forecast, replies, best prospects, or a named account. I couldn't match that question to one of those.", items: [] };
}
function Ask() {
  const { db, me, go, update } = useApp();
  const [q, setQ] = useState(""); const [busy, setBusy] = useState(false); const [log2, setLog] = useState([]);
  const ask = async (text) => { const question = (text || q).trim(); if (!question) return; setBusy(true); setQ(""); await sleep(800); const r = askAnswer(db, me, question); update((d) => d.aiCalls.push({ id: nid(d, "ai"), userId: me.id, feature: "ask", model: "writer", at: Date.now() })); setLog((l) => [{ question, ...r }, ...l]); setBusy(false); };
  return (
    <Panel title="Ask Sales AI" icon={Sparkles} right={<Pill tone="b">Reads only what you're allowed to see</Pill>}>
      <form onSubmit={(e) => { e.preventDefault(); ask(); }} className="flex gap-2"><input autoFocus aria-label="Question" className={inp} value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. What's stalled? Who am I meeting this week?" /><Btn kind="ai" icon={Sparkles} busy={busy} onClick={() => ask()}>Ask</Btn></form>
      <div className="mt-3 flex flex-wrap gap-2">{["What's stalled?", "Who am I meeting this week?", "What's my forecast?", "Any replies?", "Who are my best prospects?"].map((x) => <button key={x} onClick={() => ask(x)} className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800">{x}</button>)}</div>
      <div className="mt-4 space-y-3">{log2.map((r, i) => <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"><p className="text-xs text-zinc-500">You asked: {r.question}</p><p className="mt-1 text-sm text-zinc-100">{r.text}</p>{r.fn && <p className="mt-1 text-xs text-zinc-600">Query run by the server: {r.fn}</p>}{r.items.length > 0 && <ul className="mt-2 space-y-1">{r.items.map((it, j) => <li key={j}><button disabled={!it.aid} onClick={() => it.aid && go("account", { id: it.aid, tab: it.tab })} className="flex w-full items-center gap-2 rounded border border-zinc-800 px-3 py-2 text-left hover:border-zinc-600 disabled:hover:border-zinc-800"><span className="min-w-0 flex-1"><span className="block text-sm text-zinc-200">{it.label}</span><span className="block text-xs text-zinc-500">{it.sub}</span></span>{it.aid && <ChevronRight size={14} className="text-zinc-600" />}</button></li>)}</ul>}</div>)}
        {log2.length === 0 && <AiNote>The AI can't run its own database queries or change anything. It picks from a fixed list of read-only questions, and the server runs them with your permissions.</AiNote>}</div>
    </Panel>
  );
}

/* ───────── Account: Research ───────── */
const SRC_ICON = { upload: Upload, website: Globe, rep_note: Note };
const KIND_TONE = { incident: "r", timing: "a", tenant: "b", growth: "g", other: "z" };
function ResearchTab({ a }) {
  const { db, me, update, toast, aiLog } = useApp();
  const [note, setNote] = useState(""); const [busy, setBusy] = useState(null); const [ver, setVer] = useState(null); const [sig, setSig] = useState("");
  const brief = a.briefs.find((b) => b.version === ver) || a.briefs[a.briefs.length - 1];
  const addNote = () => { update((d) => { const x = acct(d, a.id); x.sources.push({ id: nid(d, "s"), kind: "rep_note", title: `Note from ${me.name}`, text: note.trim(), at: Date.now() }); }); setNote(""); toast("Note saved as a source."); };
  const fetchSite = async () => {
    setBusy("fetch"); await sleep(1400);
    const already = a.sources.some((s) => s.kind === "website"), found = already ? 0 : ((a.web || {}).facts || []).length;
    update((d) => { const x = acct(d, a.id); if (x.sources.some((s) => s.kind === "website")) return; const sid = nid(d, "s");
      const w = x.web || { text: `${x.name} is a ${lc1(x.type)} property in ${x.city}. The site lists leasing contacts and general property information. No security-related announcements were found.`, facts: [] };
      x.sources.push({ id: sid, kind: "website", title: `${x.website || "website"} (4 pages read)`, text: w.text, at: Date.now() });
      w.facts.forEach((f) => { x.signals.push({ id: nid(d, "g"), text: f[0], kind: f[1], confirmed: false, sourceId: sid, ai: true }); });
      d.aiCalls.push({ id: nid(d, "ai"), userId: me.id, feature: "signal_extract", model: "fast", at: Date.now() }); touch(d, x.id); });
    setBusy(null); toast(already ? "Website was already read." : found ? `Website read. ${plural(found, "possible signal")} found: confirm the ones that are right.` : "Website read. No new signals found.");
  };
  const gen = async () => {
    setBusy("brief"); await sleep(1600);
    update((d) => { const x = acct(d, a.id), b = makeBrief(d, x); x.briefs.push({ id: nid(d, "b"), version: x.briefs.length + 1, sections: b.sections, pkg: b.pkg, by: me.id, at: Date.now() }); log(d, me, x.id, "note", `Research brief v${x.briefs.length} generated`); advance(d, me, openDeal(d, x.id), "researched"); touch(d, x.id); });
    aiLog("research_brief", "writer"); setVer(null); setBusy(null);
  };
  const canBrief = a.sources.length > 0 || a.signals.length > 0;
  return (
    <div className="space-y-4">
      <Panel title="Sources" icon={FileText} right={<Btn small kind="ai" icon={Globe} busy={busy === "fetch"} onClick={fetchSite}>Read their website</Btn>}>
        <p className="mb-3 text-xs text-zinc-500">The AI may only use what's listed here. Each fact in the brief points back to its source.</p>
        {a.sources.length === 0 ? <Empty>No sources yet. Read their website or add a note from a call or site visit.</Empty> : <ul className="space-y-2">{a.sources.map((s, i) => { const I = SRC_ICON[s.kind] || FileText; return <li key={s.id} id={`src-${s.id}`} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"><p className="flex items-center gap-2 text-sm text-zinc-200"><span className="flex h-5 w-5 items-center justify-center rounded bg-zinc-800 text-xs text-zinc-300">{i + 1}</span><I size={14} className="text-zinc-500" />{s.title}<span className="ml-auto text-xs text-zinc-600">{ago(s.at)}</span></p><p className="mt-1 text-xs text-zinc-400">{s.text}</p></li>; })}</ul>}
        <div className="mt-3 flex gap-2"><input aria-label="Add a note" className={inp} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add what you learned on a call or site visit" /><Btn icon={Plus} disabled={!note.trim()} onClick={addNote}>Add note</Btn></div>
      </Panel>
      <Panel title="Security signals" icon={Alert}>
        {a.signals.length === 0 ? <Empty>No signals yet.</Empty> : <ul className="space-y-2">{a.signals.map((s) => <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2"><Pill tone={KIND_TONE[s.kind]}>{s.kind}</Pill><span className="min-w-0 flex-1 text-sm text-zinc-200">{s.text}</span>{s.ai && <Pill tone="b"><Sparkles size={10} />Found by AI</Pill>}{s.confirmed ? <Pill tone="g"><Check size={10} />Confirmed</Pill> : <><Pill tone="a">Unconfirmed</Pill><Btn small kind="primary" onClick={() => update((d) => { acct(d, a.id).signals.find((x) => x.id === s.id).confirmed = true; })}>Confirm</Btn></>}<button aria-label="Remove signal" onClick={() => update((d) => { const x = acct(d, a.id); x.signals = x.signals.filter((y) => y.id !== s.id); })} className="rounded p-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"><Trash size={14} /></button></li>)}</ul>}
        <div className="mt-3 flex gap-2"><input aria-label="Add a signal" className={inp} value={sig} onChange={(e) => setSig(e.target.value)} placeholder="Add a signal you know first-hand, e.g. a break-in last week" /><Btn icon={Plus} disabled={!sig.trim()} onClick={() => { update((d) => { const x = acct(d, a.id), sid = nid(d, "s"); x.sources.push({ id: sid, kind: "rep_note", title: `Note from ${me.name}`, text: sig.trim(), at: Date.now() }); x.signals.push({ id: nid(d, "g"), text: sig.trim(), kind: "incident", confirmed: true, sourceId: sid, ai: false }); }); setSig(""); }}>Add</Btn></div>
      </Panel>
      <Panel title="AI research brief" icon={Sparkles} right={<>{a.briefs.length > 1 && <select aria-label="Brief version" className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-300" value={brief.version} onChange={(e) => setVer(+e.target.value)}>{a.briefs.map((b) => <option key={b.id} value={b.version}>Version {b.version}</option>)}</select>}<Btn small kind="ai" icon={brief ? Refresh : Sparkles} busy={busy === "brief"} disabled={!canBrief} onClick={gen}>{brief ? "Regenerate" : "Generate brief"}</Btn></>}>
        {!canBrief && <p role="alert" className="mb-3 text-sm text-amber-300">Add at least one source or signal first. The AI isn't allowed to write a brief from nothing.</p>}
        {busy === "brief" ? <p className="flex items-center gap-2 text-sm text-blue-300"><Loader size={14} className="animate-spin" />Reading {plural(a.sources.length, "source")} and writing the brief…</p> : !brief ? <Empty>No brief yet.</Empty> : <div className="space-y-4">
          <p className="text-xs text-zinc-500">Version {brief.version} · {ago(brief.at)} · by {(userOf(db, brief.by) || {}).name}</p>
          {brief.sections.map((s) => <div key={s.h}><h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-100">{s.h}{s.src.map((id) => { const n = a.sources.findIndex((x) => x.id === id); return n < 0 ? null : <a key={id} href={`#src-${id}`} title={a.sources[n].title} className="rounded bg-blue-950 px-1.5 text-xs font-normal text-blue-300 hover:bg-blue-900">source {n + 1}</a>; })}</h3><div className="mt-1"><Lines t={s.t} /></div>{s.system && <p className="mt-1 text-xs text-zinc-600">{s.system}</p>}</div>)}
        </div>}
      </Panel>
    </div>
  );
}

/* ───────── Account: Outreach ───────── */
const CH = [{ id: "email", label: "Email", icon: Mail }, { id: "call", label: "Call script", icon: Phone }, { id: "voicemail", label: "Voicemail", icon: Voicemail }, { id: "linkedin", label: "LinkedIn note", icon: Linkedin }];
const CLS_TONE = { interested: "g", not_now: "a", not_interested: "r", unsubscribe: "r", out_of_office: "z", other: "z" };
function OutreachTab({ a, deal, route }) {
  const { db, me, update, toast, aiLog } = useApp();
  const [cid, setCid] = useState((primary(a) || {}).id); const [channel, setChannel] = useState(route.channel || "email"); const [tone, setTone] = useState("professional");
  const [draft, setDraft] = useState(route.prefill || null); const [busy, setBusy] = useState(false); const [outcome, setOutcome] = useState("Connected");
  const c = a.contacts.find((x) => x.id === cid);
  if (!c) return <Empty>Add a contact first (right-hand panel). Outreach needs someone to reach.</Empty>;
  const write = async () => { setBusy(true); await sleep(1300); const slots = channel === "linkedin" ? [] : findSlots(db, me, a, 1); setDraft(makeDraft(db, a, c, channel, tone, deal ? deal.stage : "lead", slots, me)); aiLog("outreach_draft", "writer"); setBusy(false); };
  const d = draft ? { ...draft, channel } : null;
  const checks = d ? runChecks(db, a, c, d) : [];
  const blocked = checks.filter((k) => k.blocking && !k.pass);
  const used = sentToday(db, me.id), capHit = used >= me.cap;
  const token = `${(c.email || "x").split("@")[0]}.${a.id}`;
  const send = () => {
    update((x) => { const eid = nid(x, "e"); x.emails.push({ id: eid, accountId: a.id, dealId: deal ? deal.id : null, contactId: c.id, userId: me.id, dir: "out", status: "sent", subject: draft.subject, body: `${draft.body}\n\n${footer(me, x, token)}`, at: Date.now(), cls: null, to: c.email });
      log(x, me, a.id, "email_out", `Email sent to ${c.first} ${c.last}: “${draft.subject}”`); audit(x, me, "email.send", `${c.email} · ${a.name}`);
      const dl = openDeal(x, a.id);
      if (route.proposalId) { const p = x.proposals.find((y) => y.id === route.proposalId); if (p && p.status === "draft") { p.status = "sent"; p.sentAt = Date.now(); log(x, me, a.id, "proposal", `Proposal v${p.version} sent to ${c.first} ${c.last}`); } advance(x, me, dl, "proposal"); } else advance(x, me, dl, "contacted");
      touch(x, a.id); });
    setDraft(null); toast(`Sent from your mailbox to ${c.email}.`);
  };
  const logIt = () => { update((x) => { log(x, me, a.id, channel === "linkedin" ? "linkedin" : channel, `${CH.find((k) => k.id === channel).label} with ${c.first} ${c.last}: ${channel === "linkedin" ? "sent" : outcome}`); advance(x, me, openDeal(x, a.id), "contacted"); touch(x, a.id); }); setDraft(null); toast("Logged on the timeline."); };
  const thread = db.emails.filter((e) => e.accountId === a.id).sort((x, y) => y.at - x.at);
  const lastOut = thread.find((e) => e.dir === "out");
  const sim = (kind) => update((x) => {
    const ct = acct(x, a.id).contacts.find((k) => k.id === lastOut.contactId) || c, name = `${ct.first} ${ct.last}`;
    if (kind === "bounce") { x.emails.find((e) => e.id === lastOut.id).status = "bounced"; ct.emailStatus = "bounced"; if (!suppressed(x, ct.email)) x.suppressions.push({ email: ct.email, reason: "bounce", at: Date.now(), by: null }); log(x, null, a.id, "email_in", `Delivery failed to ${ct.email}. Address suppressed.`); return; }
    const bodies = { interested: `Thanks for reaching out. Yes, this is a priority for us. Can you send two times this week?`, not_now: "Appreciate the note. We're locked in until next quarter. Check back then.", unsubscribe: "Please remove me from your list." };
    x.emails.push({ id: nid(x, "e"), accountId: a.id, dealId: lastOut.dealId, contactId: ct.id, userId: lastOut.userId, dir: "in", status: "received", subject: `Re: ${lastOut.subject}`, body: bodies[kind], at: Date.now(), cls: kind, to: me.email });
    x.aiCalls.push({ id: nid(x, "ai"), userId: lastOut.userId, feature: "reply_classify", model: "fast", at: Date.now() });
    log(x, null, a.id, "email_in", `Reply from ${name} (AI read it as: ${kind.replace("_", " ")})`);
    if (kind === "interested") x.tasks.push({ id: nid(x, "t"), ownerId: lastOut.userId, accountId: a.id, title: `Reply to ${name}`, due: Date.now(), done: false });
    if (kind === "unsubscribe") { ct.emailStatus = "unsubscribed"; if (!suppressed(x, ct.email)) x.suppressions.push({ email: ct.email, reason: "unsubscribe", at: Date.now(), by: null }); log(x, null, a.id, "note", `${ct.email} unsubscribed. No rep can email this address again.`); }
    touch(x, a.id); });
  return (
    <div className="space-y-4">
      <Panel title="Write outreach" icon={Send} right={<Pill tone={capHit ? "r" : "z"}>{used} of {me.cap} emails sent in the last 24 h</Pill>}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="To"><select className={inp} value={cid} onChange={(e) => { setCid(e.target.value); setDraft(null); }}>{a.contacts.map((k) => <option key={k.id} value={k.id}>{k.first} {k.last}{k.title ? `, ${k.title}` : ""}</option>)}</select></Field>
          <Field label="Channel"><select className={inp} value={channel} onChange={(e) => { setChannel(e.target.value); setDraft(null); }}>{CH.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select></Field>
          <Field label="Tone"><select className={inp} value={tone} onChange={(e) => setTone(e.target.value)}><option value="professional">Professional</option><option value="friendly">Friendly</option><option value="direct">Direct</option></select></Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2"><Btn kind="ai" icon={Sparkles} busy={busy} onClick={write}>{draft ? "Rewrite with AI" : "Write with AI"}</Btn><Btn onClick={() => setDraft({ subject: "", body: "" })}>Write it myself</Btn>{c.pref && <span className="text-xs text-zinc-500">{c.first}: {lc1(c.pref)}</span>}</div>
        {d && <div className="mt-4 grid gap-4 lg:grid-cols-5">
          <div className="space-y-2 lg:col-span-3">
            {(channel === "email") && <input aria-label="Subject" className={inp} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} placeholder="Subject" />}
            <textarea aria-label="Message" rows={channel === "email" ? 10 : 8} className={inp} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            {channel === "email" && <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-950/50 p-3"><p className="mb-1 flex items-center gap-1 text-xs text-zinc-500"><Lock size={11} />Added automatically. Can't be removed.</p><pre className="whitespace-pre-wrap font-sans text-xs text-zinc-400">{footer(me, db, token)}</pre></div>}
          </div>
          <div className="lg:col-span-2">
            <p className="mb-2 text-xs font-semibold text-zinc-300">Compliance check</p>
            <ul className="space-y-1.5">{checks.map((k) => <li key={k.id} className={`flex items-start gap-2 rounded-lg border px-2 py-1.5 text-xs ${k.pass ? (k.warn ? TONES.a : "border-zinc-800 text-zinc-300") : k.blocking ? TONES.r : TONES.a}`}>{k.pass && !k.warn ? <Check size={13} className="mt-0.5 shrink-0 text-emerald-400" /> : k.blocking && !k.pass ? <Ban size={13} className="mt-0.5 shrink-0" /> : <Alert size={13} className="mt-0.5 shrink-0" />}<span>{k.label}{!k.pass && <span className="ml-1 opacity-70">{k.blocking ? "· blocks sending" : "· warning"}</span>}</span></li>)}</ul>
            <div className="mt-3 space-y-2">
              {channel === "email" ? <>
                <Btn kind="primary" icon={Send} className="w-full" disabled={blocked.length > 0 || capHit || !me.connected || !draft.body.trim()} onClick={send}>Send to {c.first}</Btn>
                {capHit && <p className="text-xs text-red-300">Daily cap reached.</p>}{!me.connected && <p className="text-xs text-amber-300">Reconnect your mailbox in Settings to send.</p>}
                <p className="text-xs text-zinc-500">Goes from your own mailbox, one message per click. Nothing is ever sent automatically.</p>
              </> : channel === "linkedin" ? <><Btn icon={FileText} className="w-full" onClick={() => { try { navigator.clipboard.writeText(draft.body); } catch (e) { /* clipboard not available */ } toast("Copied. Paste it into LinkedIn yourself."); }}>Copy note</Btn><Btn kind="primary" className="w-full" disabled={blocked.length > 0} onClick={logIt}>Log as sent</Btn></> : <>
                <Field label="Outcome"><select className={inp} value={outcome} onChange={(e) => setOutcome(e.target.value)}>{["Connected", "Left voicemail", "No answer", "Wrong number"].map((o) => <option key={o}>{o}</option>)}</select></Field>
                <Btn kind="primary" className="w-full" disabled={blocked.length > 0} onClick={logIt}>Log outcome</Btn>
              </>}
            </div>
          </div>
        </div>}
      </Panel>
      <Panel title="Email thread" icon={Mail}>
        {thread.length === 0 ? <Empty>No email yet. Replies to emails sent from the CRM show up here; the rest of your inbox is never read.</Empty> : <ul className="space-y-2">{thread.map((e) => <li key={e.id} className={`rounded-lg border p-3 ${e.dir === "in" ? "border-emerald-900 bg-emerald-950/20" : "border-zinc-800 bg-zinc-950/60"}`}><p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500"><Pill tone={e.dir === "in" ? "g" : "z"}>{e.dir === "in" ? "Reply" : "Sent"}</Pill>{e.status === "bounced" && <Pill tone="r">Bounced</Pill>}{e.cls && <Pill tone={CLS_TONE[e.cls]}><Sparkles size={10} />{e.cls.replace("_", " ")}</Pill>}<span className="text-zinc-300">{e.subject}</span><span className="ml-auto">{ago(e.at)}</span></p><pre className="mt-2 whitespace-pre-wrap font-sans text-sm text-zinc-300">{e.body}</pre></li>)}</ul>}
        {lastOut && <div className="mt-3 rounded-lg border border-dashed border-amber-800 bg-amber-950/20 p-3"><DemoNote>Demo controls: pretend the prospect did something, to see how the CRM reacts.</DemoNote><div className="mt-2 flex flex-wrap gap-2"><Btn small kind="demo" onClick={() => sim("interested")}>Replies: interested</Btn><Btn small kind="demo" onClick={() => sim("not_now")}>Replies: not now</Btn><Btn small kind="demo" onClick={() => sim("unsubscribe")}>Clicks unsubscribe</Btn><Btn small kind="demo" onClick={() => sim("bounce")}>Email bounces</Btn></div></div>}
      </Panel>
    </div>
  );
}

/* ───────── Account: Meetings ───────── */
function MeetingsTab({ a }) {
  const { db, me, update, toast, aiLog } = useApp();
  const [kind, setKind] = useState("site_walk"); const [slots, setSlots] = useState(null); const [busy, setBusy] = useState(false); const [openPrep, setOpenPrep] = useState(null);
  const dur = kind === "site_walk" ? 1 : 0.5, c = primary(a);
  const find = async () => { setBusy(true); await sleep(1100); setSlots(findSlots(db, me, a, dur)); setBusy(false); };
  const book = (s) => {
    if (busyFor(db, me.id).some((b) => s.start < b.end && s.end > b.start)) { toast("That time was just taken. Here are fresh times.", "a"); setSlots(findSlots(db, me, a, dur)); return; }
    update((x) => { const acc = acct(x, a.id); const m = { id: nid(x, "m"), accountId: a.id, dealId: (openDeal(x, a.id) || {}).id, ownerId: me.id, contactIds: c ? [c.id] : [], title: `${kind === "site_walk" ? "Site walk" : "Call"}: ${a.name}`, kind, status: "scheduled", start: s.start, end: s.end, where: kind === "site_walk" ? `${a.name}, ${a.city}` : "Phone", city: kind === "site_walk" ? a.city : null, prep: null };
      m.prep = makePrep(x, acc, m, me); x.meetings.push(m); x.aiCalls.push({ id: nid(x, "ai"), userId: me.id, feature: "prep_brief", model: "writer", at: Date.now() });
      log(x, me, a.id, "meeting", `${m.title} booked for ${fmtDT(s.start)}${c ? `. Invite sent to ${c.first} ${c.last}` : ""}`); advance(x, me, openDeal(x, a.id), "meeting_set"); touch(x, a.id); });
    setSlots(null); toast(`Booked. Calendar invite sent${c ? ` to ${c.email}` : ""}.`);
  };
  const mine = db.meetings.filter((m) => m.accountId === a.id).sort((x, y) => y.start - x.start);
  const setStatus = (id, status) => update((x) => { const m = x.meetings.find((y) => y.id === id); m.status = status; log(x, me, a.id, "meeting", `${m.title}: marked ${status.replace("_", " ")}`); touch(x, a.id); });
  return (
    <div className="space-y-4">
      <Panel title="Book a meeting" icon={Calendar}>
        <div className="flex flex-wrap items-end gap-3"><div className="w-56"><Field label="Type"><select className={inp} value={kind} onChange={(e) => { setKind(e.target.value); setSlots(null); }}><option value="site_walk">Site walk, 60 minutes</option><option value="call">Phone call, 30 minutes</option></select></Field></div><Btn kind="ai" icon={Sparkles} busy={busy} disabled={!me.connected} onClick={find}>Find best times</Btn></div>
        <p className="mt-2 text-xs text-zinc-500">Reads your real calendar for the next two weeks and leaves room to drive between stops{c && c.pref ? `. ${c.first}: ${lc1(c.pref)}` : ""}.</p>
        {slots && (slots.length === 0 ? <div className="mt-3"><Empty>No free time fits in the next two weeks. Try a shorter meeting.</Empty></div> : <ul className="mt-3 grid gap-2 md:grid-cols-3">{slots.map((s) => <li key={s.start} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"><p className="text-sm font-semibold text-zinc-100">{fmtDay(s.start)}</p><p className="text-sm text-zinc-300">{fmtTime(s.start)} to {fmtTime(s.end)}</p><ul className="mt-2 space-y-1 text-xs text-zinc-400">{s.why.map((w, i) => <li key={i} className="flex gap-1.5">{i === 0 ? <Car size={12} className="mt-0.5 shrink-0" /> : <Clock size={12} className="mt-0.5 shrink-0" />}{w}</li>)}</ul><Btn small kind="primary" className="mt-3 w-full" onClick={() => book(s)}>Book and send invite</Btn></li>)}</ul>)}
      </Panel>
      <Panel title="Meetings with this account" icon={Clock}>
        {mine.length === 0 ? <Empty>No meetings yet.</Empty> : <ul className="space-y-2">{mine.map((m) => <li key={m.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium text-zinc-100">{m.title}</p><Pill tone={m.status === "scheduled" ? "b" : m.status === "done" ? "g" : "r"}>{m.status.replace("_", " ")}</Pill><span className="text-xs text-zinc-500">{fmtDT(m.start)} · {m.where}</span><span className="ml-auto flex flex-wrap gap-2"><Btn small kind="ai" icon={FileText} onClick={() => setOpenPrep(openPrep === m.id ? null : m.id)}>{openPrep === m.id ? "Hide prep brief" : "Prep brief"}</Btn>{m.status === "scheduled" && <><Btn small onClick={() => setStatus(m.id, "done")}>Done</Btn><Btn small onClick={() => setStatus(m.id, "no_show")}>No-show</Btn><Btn small onClick={() => setStatus(m.id, "cancelled")}>Cancel</Btn></>}</span></div>
          {openPrep === m.id && m.prep && <div className="mt-3 grid gap-3 border-t border-zinc-800 pt-3 md:grid-cols-2">{m.prep.map((s) => <div key={s.h}><h3 className="text-xs font-semibold text-blue-300">{s.h}</h3><div className="mt-1"><Lines t={s.t} /></div></div>)}</div>}</li>)}</ul>}
      </Panel>
    </div>
  );
}

/* ───────── Account: Proposal ───────── */
function PaperProposal({ db, a, p, publicView }) {
  const cfg = db.pricing.find((c) => c.id === p.cfgId) || liveCfg(db), rep = userOf(db, p.createdBy), pr = p.pricing;
  return (
    <div className="rounded-lg bg-white p-6 text-zinc-900 shadow">
      <div className="flex items-center gap-2 border-b border-zinc-200 pb-3"><Shield size={20} className="text-emerald-600" /><span className="font-semibold">Security Of America</span><span className="ml-auto text-xs text-zinc-500">Proposal v{p.version}</span></div>
      <h3 className="mt-4 text-xl font-semibold">Security services for {a.name}</h3>
      <p className="mt-1 text-sm text-zinc-600">{a.city}{a.ownerCo ? ` · Prepared for ${a.ownerCo}` : ""}</p>
      {p.note && <p className="mt-4 text-sm">{p.note}</p>}
      <h4 className="mt-5 text-sm font-semibold">Scope of service</h4>
      <p className="mt-1 text-sm">{pkgText(p.pkg, cfg)}. {p.pkg.term}-month term.</p>
      <table className="mt-4 w-full text-sm"><tbody>
        {p.pkg.posts > 0 && <tr className="border-t border-zinc-200"><td className="py-2">Guard coverage: {pr.hours} hours a week at {money(pr.rate)} an hour</td><td className="py-2 text-right">{money(pr.hours * pr.rate * 52)} / yr</td></tr>}
        {p.pkg.addons.map((k) => <tr key={k} className="border-t border-zinc-200"><td className="py-2">{cfg.addons[k].label}</td><td className="py-2 text-right">{cfg.addons[k].mo ? `${money(cfg.addons[k].mo * 12)} / yr` : "Included"}</td></tr>)}
        {pr.td > 0 && <tr className="border-t border-zinc-200"><td className="py-2">{p.pkg.term}-month term discount</td><td className="py-2 text-right">−{Math.round(pr.td * 100)}%</td></tr>}
        {pr.manual > 0 && <tr className="border-t border-zinc-200"><td className="py-2">Additional discount</td><td className="py-2 text-right">−{Math.round(pr.manual * 1000) / 10}%</td></tr>}
        <tr className="border-t-2 border-zinc-900 font-semibold"><td className="py-2">Annual total</td><td className="py-2 text-right">{money(pr.annual)}</td></tr>
        <tr><td className="pb-2 text-zinc-600">Billed monthly</td><td className="pb-2 text-right text-zinc-600">{money(pr.monthly)}</td></tr>
      </tbody></table>
      <h4 className="mt-4 text-sm font-semibold">Start plan</h4><p className="mt-1 text-sm">14-day transition with no coverage gap. Site-specific post orders written with your team in week one.</p>
      <p className="mt-5 border-t border-zinc-200 pt-3 text-xs text-zinc-600">{rep.name}, {rep.title} · {rep.phone} · {rep.email}</p>
      {publicView && <button className="mt-3 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white">Contact {rep.name.split(" ")[0]}</button>}
    </div>
  );
}
function ProposalTab({ a, deal }) {
  const { db, me, update, toast, go } = useApp();
  const cfg = liveCfg(db);
  const [pkg, setPkg] = useState(deal.pkg); const [disc, setDisc] = useState(0); const [note, setNote] = useState(`Thank you for your time. This proposal covers ${a.name}.`); const [busy, setBusy] = useState(null); const [view, setView] = useState(null);
  const pr = price(pkg, cfg, disc / 100);
  const list = db.proposals.filter((p) => p.dealId === deal.id).sort((x, y) => y.version - x.version);
  const set = (k, v) => setPkg({ ...pkg, [k]: v });
  const save = () => { update((x) => { const v = x.proposals.filter((p) => p.dealId === deal.id).length + 1; x.proposals.push({ id: nid(x, "p"), dealId: deal.id, accountId: a.id, version: v, status: "draft", pkg, pricing: price(pkg, liveCfg(x), disc / 100), cfgId: liveCfg(x).id, manual: disc / 100, approvedBy: null, note, pdf: false, token: nid(x, "tok"), sentAt: null, views: [], createdBy: me.id }); const dl = x.deals.find((y) => y.id === deal.id); dl.pkg = pkg; dl.value = price(pkg, liveCfg(x), disc / 100).annual; log(x, me, a.id, "proposal", `Proposal v${v} drafted at ${money(dl.value)} a year`); touch(x, a.id); }); toast("Saved as a new version."); };
  const render = async (p) => { setBusy(p.id); await sleep(1500); update((x) => { x.proposals.find((y) => y.id === p.id).pdf = true; }); setBusy(null); toast("PDF ready."); };
  const c = primary(a);
  const toEmail = (p) => go("account", { id: a.id, tab: "outreach", proposalId: p.id, prefill: { subject: `Proposal for ${a.name.replace(/ \(.*\)$/, "")}`, body: `Hi ${c ? c.first : "there"},\n\nThank you for walking the site with me. Here is our proposal for ${a.name}:\n\nsoa-crm.example/p/${p.token}\n\nIt covers ${lc1(pkgText(p.pkg, cfg))}, at ${money(p.pricing.monthly)} a month. I'm happy to walk through it whenever suits you.` } });
  return (
    <div className="space-y-4">
      <Panel title="Build a proposal" icon={Dollar} right={<Pill>Prices are calculated on the server from the company price list</Pill>}>
        <div className="grid gap-4 lg:grid-cols-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:col-span-3">
            <Field label="Guard posts"><input type="number" min="0" max="20" className={inp} value={pkg.posts} onChange={(e) => set("posts", Math.max(0, Math.min(20, +e.target.value || 0)))} /></Field>
            <Field label="Coverage"><select className={inp} value={pkg.coverage} onChange={(e) => set("coverage", e.target.value)}>{Object.keys(COVER_LABEL).map((k) => <option key={k} value={k}>{COVER_LABEL[k]}</option>)}</select></Field>
            <Field label="Officers"><select className={inp} value={pkg.armed ? "armed" : "unarmed"} onChange={(e) => set("armed", e.target.value === "armed")}><option value="unarmed">Unarmed ({money(cfg.unarmed)}/h)</option><option value="armed">Armed ({money(cfg.armed)}/h)</option></select></Field>
            <Field label="Term"><select className={inp} value={pkg.term} onChange={(e) => set("term", +e.target.value)}>{[12, 24, 36].map((t) => <option key={t} value={t}>{t} months{cfg.term[t] ? ` (−${Math.round(cfg.term[t] * 100)}%)` : ""}</option>)}</select></Field>
            <div className="space-y-2 sm:col-span-2"><label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" checked={pkg.supervisor} onChange={(e) => set("supervisor", e.target.checked)} />Site supervisor (+{Math.round((cfg.sup - 1) * 100)}% on the hourly rate)</label>
              {Object.keys(cfg.addons).map((k) => <label key={k} className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" checked={pkg.addons.includes(k)} onChange={(e) => set("addons", e.target.checked ? [...pkg.addons, k] : pkg.addons.filter((y) => y !== k))} />{cfg.addons[k].label} <span className="text-zinc-500">{cfg.addons[k].mo ? `${money(cfg.addons[k].mo)} a month` : "included"}</span></label>)}</div>
            <Field label={`Extra discount: ${disc}%`} hint={`Above ${Math.round(cfg.maxDisc * 100)}% needs a manager's approval before it can be sent.`}><input type="range" min="0" max="20" step="1" value={disc} onChange={(e) => setDisc(+e.target.value)} className="w-full" /></Field>
            <Field label="Cover note"><textarea rows={3} className={inp} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          </div>
          <div className="lg:col-span-2"><div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4"><p className="text-xs text-zinc-400">Annual</p><p className="text-3xl font-semibold text-emerald-300">{money(pr.annual)}</p><p className="text-sm text-zinc-400">{money(pr.monthly)} a month</p>
            <dl className="mt-3 space-y-1 text-xs text-zinc-400"><div className="flex justify-between"><dt>Hours a week</dt><dd className="text-zinc-200">{pr.hours}</dd></div><div className="flex justify-between"><dt>Hourly rate</dt><dd className="text-zinc-200">{money(pr.rate)}</dd></div><div className="flex justify-between"><dt>Add-ons a month</dt><dd className="text-zinc-200">{money(pr.addMo)}</dd></div><div className="flex justify-between"><dt>Term discount</dt><dd className="text-zinc-200">{Math.round(pr.td * 100)}%</dd></div><div className="flex justify-between"><dt>Extra discount</dt><dd className={disc / 100 > cfg.maxDisc ? "text-amber-300" : "text-zinc-200"}>{disc}%</dd></div></dl>
            {disc / 100 > cfg.maxDisc && <p className="mt-2 flex items-start gap-1 text-xs text-amber-300"><Alert size={12} className="mt-0.5 shrink-0" />Needs manager approval.</p>}
            <Btn kind="primary" className="mt-3 w-full" icon={Plus} onClick={save}>Save as new version</Btn></div></div>
        </div>
      </Panel>
      <Panel title="Proposal versions" icon={FileText}>
        {list.length === 0 ? <Empty>No proposals yet. Build one above and save it.</Empty> : <ul className="space-y-2">{list.map((p) => { const needs = p.manual > cfg.maxDisc && !p.approvedBy; return <li key={p.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium text-zinc-100">Version {p.version}</p><Pill tone={p.status === "draft" ? "z" : p.status === "accepted" ? "g" : "b"}>{p.status}</Pill><span className="text-sm text-zinc-300">{money(p.pricing.annual)} a year</span>{p.manual > 0 && <Pill tone={needs ? "a" : "z"}>{Math.round(p.manual * 100)}% discount{p.approvedBy ? ` · approved by ${userOf(db, p.approvedBy).name}` : needs ? " · needs approval" : ""}</Pill>}{p.status !== "draft" && <Pill tone={p.views.length ? "g" : "z"}><Eye size={10} />{plural(p.views.length, "view")}{p.views.length ? ` · last ${ago(p.views[p.views.length - 1])}` : ""}</Pill>}
          <span className="ml-auto flex flex-wrap gap-2">
            {needs && (isMgr(me) ? <Btn small kind="primary" icon={Check} onClick={() => update((x) => { x.proposals.find((y) => y.id === p.id).approvedBy = me.id; audit(x, me, "proposal.approve_discount", `${a.name} v${p.version}: ${Math.round(p.manual * 100)}%`); log(x, me, a.id, "proposal", `${me.name} approved the ${Math.round(p.manual * 100)}% discount`); })}>Approve discount</Btn> : <span className="text-xs text-amber-300">Waiting for a manager</span>)}
            {!p.pdf ? <Btn small icon={FileText} busy={busy === p.id} onClick={() => render(p)}>Generate PDF</Btn> : <Btn small icon={Eye} onClick={() => setView({ p, pub: false })}>Preview PDF</Btn>}
            {p.status === "draft" && <Btn small kind="primary" icon={Mail} disabled={!p.pdf || needs || !c} onClick={() => toEmail(p)}>Email the link</Btn>}
            {p.status !== "draft" && <Btn small kind="demo" icon={LinkIcon} onClick={() => { update((x) => { const y = x.proposals.find((z) => z.id === p.id); y.views.push(Date.now()); if (y.status === "sent") y.status = "viewed"; if (y.views.length === 1 || Date.now() - y.views[y.views.length - 2] > 12 * H) log(x, null, a.id, "proposal", `Proposal v${y.version} was viewed`); }); setView({ p, pub: true }); }}>Open the link as the prospect</Btn>}
          </span></div></li>; })}</ul>}
      </Panel>
      {view && <Modal wide title={view.pub ? "What the prospect sees at the share link" : "PDF preview"} onClose={() => setView(null)}>{view.pub && <div className="mb-3"><DemoNote>This public page needs no login. Opening it was just recorded as a view.</DemoNote></div>}<PaperProposal db={db} a={a} p={db.proposals.find((x) => x.id === view.p.id)} publicView={view.pub} /></Modal>}
    </div>
  );
}

/* ───────── Account: Contract ───────── */
function ContractTab({ a, deal }) {
  const { db, me, update, toast } = useApp();
  const sent = db.proposals.filter((p) => p.dealId === deal.id && p.status !== "draft").slice(-1)[0];
  const k = db.contracts.filter((x) => x.dealId === deal.id).slice(-1)[0];
  const [signer, setSigner] = useState((primary(a) || {}).id); const [start, setStart] = useState(new Date(Date.now() + 21 * 24 * H).toISOString().slice(0, 10)); const [busy, setBusy] = useState(false);
  const live = k && !["voided", "declined"].includes(k.status);
  const send = async () => { setBusy(true); await sleep(1200); update((x) => { x.contracts.push({ id: nid(x, "k"), dealId: deal.id, accountId: a.id, proposalId: sent.id, status: "sent", signerId: signer, views: 0, sentAt: Date.now(), signedAt: null, startDate: new Date(start).getTime(), by: me.id }); x.proposals.find((p) => p.id === sent.id).status = "accepted"; log(x, me, a.id, "contract", "Service agreement sent for e-signature"); audit(x, me, "contract.send", a.name); advance(x, me, openDeal(x, a.id), "contract_sent"); touch(x, a.id); }); setBusy(false); toast("Sent for signature."); };
  const ev = (kind) => update((x) => { const y = x.contracts.find((z) => z.id === k.id), dl = x.deals.find((z) => z.id === deal.id);
    if (kind === "view") { y.views++; if (y.status === "sent") y.status = "viewed"; log(x, null, a.id, "contract", "Signer opened the contract"); }
    if (kind === "sign") { if (y.status === "signed") return; y.status = "signed"; y.signedAt = Date.now(); log(x, null, a.id, "contract", "Contract signed. Signed copy stored."); advance(x, null, dl, "won"); x.tasks.push({ id: nid(x, "t"), ownerId: dl.ownerId, accountId: a.id, title: `Hand ${a.name} off to operations`, due: Date.now(), done: false }); audit(x, null, "contract.signed", `${a.name} (e-signature webhook)`); }
    if (kind === "decline") { y.status = "declined"; log(x, null, a.id, "contract", "Signer declined the contract"); x.tasks.push({ id: nid(x, "t"), ownerId: dl.ownerId, accountId: a.id, title: `Call about the declined contract: ${a.name}`, due: Date.now(), done: false }); } });
  const signerC = k && a.contacts.find((c) => c.id === k.signerId);
  return (
    <div className="space-y-4">
      {!sent ? <Empty>Send a proposal first. The contract is built from the proposal the customer received.</Empty> : !live ? (
        <Panel title="Send the service agreement" icon={Pen}>
          <p className="text-sm text-zinc-400">Built from proposal v{sent.version}: {lc1(pkgText(sent.pkg, liveCfg(db)))}, {money(sent.pricing.annual)} a year, {sent.pkg.term} months.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3"><Field label="Signer"><select className={inp} value={signer} onChange={(e) => setSigner(e.target.value)}>{a.contacts.map((c) => <option key={c.id} value={c.id}>{c.first} {c.last}</option>)}</select></Field><Field label="Service start date"><input type="date" className={inp} value={start} onChange={(e) => setStart(e.target.value)} /></Field><div className="flex items-end"><Btn kind="primary" icon={Pen} busy={busy} disabled={!signer || !start} onClick={send}>Send for signature</Btn></div></div>
          <p className="mt-2 text-xs text-zinc-500">The customer signs first, then the company counter-signer. Reps can't mark a deal Won by hand; the signature does it.</p>
        </Panel>) : (
        <Panel title="Service agreement" icon={Pen} right={<Pill tone={k.status === "signed" ? "g" : "a"}>{k.status}</Pill>}>
          <dl className="grid gap-3 text-sm sm:grid-cols-4"><div><dt className="text-xs text-zinc-500">Signer</dt><dd className="text-zinc-200">{signerC ? `${signerC.first} ${signerC.last}` : "Contact removed"}</dd></div><div><dt className="text-xs text-zinc-500">Sent</dt><dd className="text-zinc-200">{ago(k.sentAt)}</dd></div><div><dt className="text-xs text-zinc-500">Opened</dt><dd className="text-zinc-200">{plural(k.views, "time")}</dd></div><div><dt className="text-xs text-zinc-500">{k.status === "signed" ? "Signed" : "Start date"}</dt><dd className="text-zinc-200">{k.status === "signed" ? ago(k.signedAt) : fmtDay(k.startDate)}</dd></div></dl>
          {k.status === "signed" ? <p className="mt-3 flex items-center gap-2 text-sm text-emerald-300"><ShieldCheck size={16} />Signed copy stored. The deal is Won and a hand-off task was created.</p> : <>
            <div className="mt-3 rounded-lg border border-dashed border-amber-800 bg-amber-950/20 p-3"><DemoNote>Demo controls: in the real app these arrive from the e-signature service.</DemoNote><div className="mt-2 flex flex-wrap gap-2"><Btn small kind="demo" icon={Eye} onClick={() => ev("view")}>Signer opens it</Btn><Btn small kind="demo" icon={Check} onClick={() => ev("sign")}>Signer signs</Btn><Btn small kind="demo" icon={X} onClick={() => ev("decline")}>Signer declines</Btn></div></div>
            <div className="mt-3"><Btn small kind="danger" onClick={() => update((x) => { x.contracts.find((z) => z.id === k.id).status = "voided"; log(x, me, a.id, "contract", "Contract voided"); })}>Void contract</Btn></div></>}
        </Panel>)}
    </div>
  );
}

/* ───────── Account page ───────── */
const ACT_ICON = { note: Note, email_out: Send, email_in: Mail, call: Phone, voicemail: Voicemail, linkedin: Linkedin, meeting: Calendar, stage: ChevronRight, proposal: FileText, contract: Pen, owner: UserPlus };
function AccountPage({ route }) {
  const { db, me, go, update, toast } = useApp();
  const a = acct(db, route.id);
  const [lost, setLost] = useState(false); const [reason, setReason] = useState(LOST[0]); const [note, setNote] = useState(""); const [task, setTask] = useState(""); const [nc, setNc] = useState(null);
  if (!a || !visible(a, me)) return <Panel><Empty>Not found. This account doesn't exist or belongs to another rep.</Empty><div className="mt-3 text-center"><Btn onClick={() => go("prospects")}>Back to prospects</Btn></div></Panel>;
  const deal = openDeal(db, a.id), edit = canEdit(a, me), f = fit(a, db), tab = route.tab || "research";
  const TABS = [["research", "Research", Sparkles], ["outreach", "Outreach", Send], ["meetings", "Meetings", Calendar], ["proposal", "Proposal", Dollar], ["contract", "Contract", Pen], ["timeline", "Timeline", History]];
  const acts = db.activities.filter((x) => x.accountId === a.id).sort((x, y) => y.at - x.at);
  const tasks = db.tasks.filter((t) => t.accountId === a.id && !t.done);
  const claim = () => update((d) => { const x = acct(d, a.id); if (x.ownerId) return; x.ownerId = me.id; const pkg = DEFAULT_PKG[x.type]; if (!openDeal(d, x.id)) d.deals.push({ id: nid(d, "d"), accountId: x.id, ownerId: me.id, stage: "lead", status: "open", pkg, value: price(pkg, liveCfg(d)).annual, stageAt: Date.now(), lastAt: Date.now(), createdAt: Date.now() }); log(d, me, x.id, "owner", `${me.name} claimed this account`); audit(d, me, "account.claim", x.name); });
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <button onClick={() => go("prospects")} className="mb-2 flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"><ArrowLeft size={12} />Prospects</button>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1"><h1 className="text-xl font-semibold text-zinc-100">{a.name}</h1><p className="text-sm text-zinc-400">{a.type} · {a.city}{a.ownerCo ? ` · ${a.ownerCo}` : ""}{a.size ? ` · ${a.size}` : ""}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">{deal && <StagePill d={deal} />}{deal && <Pill>{moneyK(deal.value)} a year</Pill>}<Pill tone={f.score >= 60 ? "g" : f.score >= 30 ? "a" : "z"} title={f.reasons.join(" · ")}>Fit {f.score}</Pill><Pill tone={a.ownerId ? "z" : "a"}>{a.ownerId ? `Owner: ${userOf(db, a.ownerId).name}` : "Unassigned pool"}</Pill></div></div>
          {edit && deal && deal.status === "open" && <div className="flex flex-wrap items-end gap-2">
            <Field label="Stage"><select aria-label="Deal stage" className={inp} value={deal.stage} onChange={(e) => moveStage(update, me, deal.id, e.target.value, toast)}>{STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
            {isMgr(me) && <Field label="Owner"><select className={inp} value={a.ownerId || ""} onChange={(e) => update((d) => { const x = acct(d, a.id), to = e.target.value; x.ownerId = to; d.deals.filter((y) => y.accountId === a.id && y.status === "open").forEach((y) => { y.ownerId = to; }); log(d, me, a.id, "owner", `${me.name} reassigned this account to ${userOf(d, to).name}`); audit(d, me, "account.assign", `${x.name} → ${userOf(d, to).name}`); })}>{db.users.filter((u) => u.role === "ae" || u.id === a.ownerId).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>}
            <Btn kind="danger" onClick={() => setLost(true)}>Mark lost</Btn></div>}
        </div>
      </div>
      {!edit ? <Panel><div className="flex flex-wrap items-center gap-3"><p className="flex-1 text-sm text-zinc-300">This account is in the shared pool. Claim it to research it, reach out and build a deal. Once claimed, other reps no longer see it.</p><Btn kind="primary" icon={UserPlus} onClick={claim}>Claim this account</Btn></div></Panel> : !deal ? <Empty>No deal.</Empty> : (
        <div className="grid gap-4 xl:grid-cols-4">
          <div className="min-w-0 space-y-4 xl:col-span-3">
            <div role="tablist" className="flex gap-1 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/60 p-1">{TABS.map(([id, label, I]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => go("account", { id: a.id, tab: id })} className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm ${tab === id ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}><I size={14} />{label}</button>)}</div>
            {tab === "research" && <ResearchTab a={a} />}
            {tab === "outreach" && <OutreachTab key={route.proposalId || route.channel || "o"} a={a} deal={deal} route={route} />}
            {tab === "meetings" && <MeetingsTab a={a} />}
            {tab === "proposal" && <ProposalTab a={a} deal={deal} />}
            {tab === "contract" && <ContractTab a={a} deal={deal} />}
            {tab === "timeline" && <Panel title="Timeline" icon={History}>
              <div className="mb-3 flex gap-2"><input aria-label="Add a note" className={inp} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note" /><Btn icon={Plus} disabled={!note.trim()} onClick={() => { update((d) => { log(d, me, a.id, "note", note.trim()); touch(d, a.id); }); setNote(""); }}>Add</Btn></div>
              <ul className="space-y-2">{acts.map((x) => { const I = ACT_ICON[x.type] || Note; return <li key={x.id} className="flex gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2"><I size={14} className="mt-1 shrink-0 text-zinc-500" /><div className="min-w-0 flex-1"><p className="text-sm text-zinc-200">{x.text}</p><p className="text-xs text-zinc-600">{x.userId ? userOf(db, x.userId).name : "System"} · {ago(x.at)}</p></div></li>; })}</ul></Panel>}
          </div>
          <div className="space-y-4">
            <Panel title="Contacts" icon={Users} right={<Btn small icon={Plus} onClick={() => setNc({ first: "", last: "", title: "", email: "", phone: "" })}>Add</Btn>}>
              {a.contacts.length === 0 ? <Empty>No contacts.</Empty> : <ul className="space-y-3">{a.contacts.map((c) => <li key={c.id} className="text-sm"><p className="flex flex-wrap items-center gap-1.5 text-zinc-100">{c.first} {c.last}{c.primary && <Pill tone="b">Primary</Pill>}{c.emailStatus !== "ok" && <Pill tone="r">{c.emailStatus}</Pill>}{c.doNotCall && <Pill tone="r">Do not call</Pill>}</p><p className="text-xs text-zinc-500">{c.title}</p><p className="truncate text-xs text-zinc-400">{c.email}</p><p className="text-xs text-zinc-400">{c.phone}{c.phone && c.phoneType !== "unknown" ? ` · ${c.phoneType}` : ""}</p>{c.pref && <p className="text-xs text-zinc-500">{c.pref}</p>}<label className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500"><input type="checkbox" checked={c.doNotCall} onChange={(e) => update((d) => { acct(d, a.id).contacts.find((y) => y.id === c.id).doNotCall = e.target.checked; })} />Do not call</label></li>)}</ul>}
            </Panel>
            <Panel title="Tasks" icon={Check}>
              {tasks.length === 0 ? <p className="text-xs text-zinc-600">No open tasks.</p> : <ul className="space-y-2">{tasks.map((t) => <li key={t.id} className="flex items-start gap-2 text-sm text-zinc-200"><input aria-label={`Complete ${t.title}`} type="checkbox" className="mt-1" onChange={() => update((d) => { d.tasks.find((y) => y.id === t.id).done = true; })} />{t.title}</li>)}</ul>}
              <div className="mt-3 flex gap-2"><input aria-label="New task" className={inp} value={task} onChange={(e) => setTask(e.target.value)} placeholder="New task" /><Btn icon={Plus} disabled={!task.trim()} onClick={() => { update((d) => { d.tasks.push({ id: nid(d, "t"), ownerId: me.id, accountId: a.id, title: task.trim(), due: Date.now(), done: false }); }); setTask(""); }} /></div>
            </Panel>
            <Panel title="Property" icon={Building}><dl className="space-y-2 text-xs"><div><dt className="text-zinc-500">Current security</dt><dd className="text-zinc-200">{a.provider || "Unknown"}</dd></div><div><dt className="text-zinc-500">Timing</dt><dd className="text-zinc-200">{a.timing || "Unknown"}</dd></div><div><dt className="text-zinc-500">Fit reasons</dt><dd className="text-zinc-200">{f.reasons.join(" · ") || "None yet"}</dd></div></dl></Panel>
          </div>
        </div>)}
      {lost && <Modal title={`Mark ${a.name} as lost`} onClose={() => setLost(false)}><Field label="Reason (required)"><select className={inp} value={reason} onChange={(e) => setReason(e.target.value)}>{LOST.map((r) => <option key={r}>{r}</option>)}</select></Field><div className="mt-4 flex justify-end gap-2"><Btn onClick={() => setLost(false)}>Cancel</Btn><Btn kind="danger" onClick={() => { update((d) => { const dl = d.deals.find((y) => y.id === deal.id); dl.status = "lost"; dl.lostReason = reason; log(d, me, a.id, "stage", `Deal marked lost: ${reason}`); audit(d, me, "deal.lost", `${a.name}: ${reason}`); }); setLost(false); toast("Deal marked lost."); }}>Mark lost</Btn></div></Modal>}
      {nc && <Modal title="Add contact" onClose={() => setNc(null)}><div className="grid gap-3 sm:grid-cols-2">{[["first", "First name"], ["last", "Last name"], ["title", "Title"], ["email", "Email"], ["phone", "Phone"]].map(([k, l]) => <Field key={k} label={l}><input className={inp} value={nc[k]} onChange={(e) => setNc({ ...nc, [k]: e.target.value })} /></Field>)}</div><div className="mt-4 flex justify-end gap-2"><Btn onClick={() => setNc(null)}>Cancel</Btn><Btn kind="primary" disabled={!nc.first.trim()} onClick={() => { update((d) => { const x = acct(d, a.id); x.contacts.push({ id: nid(d, "c"), ...nc, phoneType: "unknown", pref: "", primary: x.contacts.length === 0, emailStatus: suppressed(d, nc.email) ? "unsubscribed" : "ok", doNotCall: false }); }); setNc(null); }}>Add contact</Btn></div></Modal>}
    </div>
  );
}

/* ───────── Admin ───────── */
function Admin() {
  const { db, me, update, toast } = useApp();
  const [tab, setTab] = useState("users"); const cfg = liveCfg(db);
  const [pf, setPf] = useState({ unarmed: cfg.unarmed / 100, armed: cfg.armed / 100, patrol: cfg.addons.patrol.mo / 100, video: cfg.addons.video.mo / 100, maxDisc: cfg.maxDisc * 100 }); const [sup, setSup] = useState("");
  const TABS = [["users", "Users"], ["pricing", "Pricing"], ["refs", "Client references"], ["supp", "Suppression list"], ["audit", "Audit log"], ["ai", "AI activity"]].filter(([id]) => me.role === "admin" || !["users", "audit"].includes(id));
  const cur = TABS.some(([id]) => id === tab) ? tab : TABS[0][0];
  return (
    <div className="space-y-4">
      <div className="flex gap-1 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/60 p-1">{TABS.map(([id, l]) => <button key={id} onClick={() => setTab(id)} className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm ${cur === id ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}>{l}</button>)}</div>
      {cur === "users" && <Panel title="Users" icon={Users} pad={false}><div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><thead className="text-xs text-zinc-500"><tr><th className="px-4 py-2 font-medium">Name</th><th className="px-2 py-2 font-medium">Role</th><th className="px-2 py-2 font-medium">Daily email cap</th><th className="px-2 py-2 font-medium">Accounts</th><th className="px-4 py-2 font-medium">Active</th></tr></thead><tbody>{db.users.map((u) => <tr key={u.id} className="border-t border-zinc-800"><td className="px-4 py-2"><span className="block text-zinc-100">{u.name}</span><span className="block text-xs text-zinc-500">{u.email}</span></td><td className="px-2 py-2"><select aria-label={`Role for ${u.name}`} disabled={u.id === me.id} className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs" value={u.role} onChange={(e) => update((d) => { userOf(d, u.id).role = e.target.value; audit(d, me, "user.role", `${u.name} → ${e.target.value}`); })}><option value="ae">Account executive</option><option value="manager">Manager</option><option value="admin">Admin</option></select></td><td className="px-2 py-2"><input aria-label={`Cap for ${u.name}`} type="number" min="0" max="500" className="w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs" value={u.cap} onChange={(e) => update((d) => { userOf(d, u.id).cap = Math.max(0, Math.min(500, +e.target.value || 0)); })} /></td><td className="px-2 py-2 text-xs text-zinc-400">{db.accounts.filter((a) => a.ownerId === u.id && !a.deleted).length}</td><td className="px-4 py-2"><input aria-label={`Active ${u.name}`} type="checkbox" disabled={u.id === me.id} checked={u.active} onChange={(e) => { if (!e.target.checked && db.accounts.some((a) => a.ownerId === u.id && !a.deleted)) { toast(`Reassign ${u.name}'s accounts before deactivating.`, "a"); return; } update((d) => { userOf(d, u.id).active = e.target.checked; audit(d, me, "user.active", `${u.name}: ${e.target.checked}`); }); }} /></td></tr>)}</tbody></table></div></Panel>}
      {cur === "pricing" && <Panel title="Company price list" icon={Dollar} right={<Pill tone="a">Demo numbers: replace with your real pricing</Pill>}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{[["unarmed", "Unarmed, $ an hour"], ["armed", "Armed, $ an hour"], ["patrol", "Mobile patrol, $ a month"], ["video", "Video monitoring, $ a month"], ["maxDisc", "Discount limit before approval, %"]].map(([k, l]) => <Field key={k} label={l}><input type="number" className={inp} value={pf[k]} onChange={(e) => setPf({ ...pf, [k]: +e.target.value })} /></Field>)}</div>
        <div className="mt-3 flex flex-wrap items-center gap-3"><Btn kind="primary" onClick={() => { update((d) => { const c = liveCfg(d); d.pricing.push({ ...c, id: nid(d, "pc"), from: Date.now(), unarmed: Math.round(pf.unarmed * 100), armed: Math.round(pf.armed * 100), maxDisc: pf.maxDisc / 100, addons: { ...c.addons, patrol: { ...c.addons.patrol, mo: Math.round(pf.patrol * 100) }, video: { ...c.addons.video, mo: Math.round(pf.video * 100) } } }); audit(d, me, "pricing.create", `New price list version ${d.pricing.length}`); }); toast("Saved as a new version. Proposals already sent keep their old numbers."); }}>Save as new version</Btn><span className="text-xs text-zinc-500">Version {db.pricing.length} is live. Term discounts: 24 months 3%, 36 months 5%. Supervisor +5%.</span></div>
      </Panel>}
      {cur === "refs" && <Panel title="Client references used as proof points" icon={ShieldCheck}><p className="mb-3 text-xs text-zinc-500">Outreach may only name a client when permission is on. Otherwise it uses the anonymized wording, and the compliance check blocks the real name.</p><ul className="space-y-2">{db.refs.map((r) => <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"><div className="min-w-0 flex-1"><p className="text-sm text-zinc-100">{r.named}</p><p className="text-xs text-zinc-500">Anonymized: “{r.anon}” · {r.comp}% patrol compliance · {r.resp} min response · used for {r.types.join(", ")}</p></div><label className="flex items-center gap-2 text-xs text-zinc-300"><input type="checkbox" checked={r.permission} onChange={(e) => update((d) => { d.refs.find((x) => x.id === r.id).permission = e.target.checked; audit(d, me, "reference.permission", `${r.named}: ${e.target.checked}`); })} />Client approved being named</label></li>)}</ul></Panel>}
      {cur === "supp" && <Panel title="Suppression list" icon={Ban}><p className="mb-3 text-xs text-zinc-500">Company-wide. No rep can email an address on this list.</p><div className="mb-3 flex gap-2"><input aria-label="Email to suppress" className={inp} value={sup} onChange={(e) => setSup(e.target.value)} placeholder="name@company.example" /><Btn icon={Plus} disabled={!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sup) || !!suppressed(db, sup)} onClick={() => { update((d) => { d.suppressions.push({ email: sup.trim(), reason: "manual", at: Date.now(), by: me.id }); audit(d, me, "suppression.add", sup.trim()); }); setSup(""); }}>Add</Btn></div><ul className="space-y-1">{db.suppressions.map((s) => <li key={s.email} className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 px-3 py-2 text-sm"><span className="flex-1 text-zinc-200">{s.email}</span><Pill tone={s.reason === "bounce" ? "a" : "r"}>{s.reason}</Pill><span className="text-xs text-zinc-600">{ago(s.at)}</span><Btn small onClick={() => update((d) => { d.suppressions = d.suppressions.filter((x) => x.email !== s.email); audit(d, me, "suppression.remove", s.email); })}>Remove</Btn></li>)}</ul></Panel>}
      {cur === "audit" && <Panel title="Audit log" icon={History}><p className="mb-3 text-xs text-zinc-500">Append-only. Nobody can edit or delete entries.</p><ul className="space-y-1 font-mono text-xs">{[...db.audit].reverse().map((x) => <li key={x.id} className="flex flex-wrap gap-3 rounded border border-zinc-800 px-3 py-1.5"><span className="w-28 text-zinc-600">{fmtDT(x.at)}</span><span className="w-28 text-zinc-400">{x.userId ? userOf(db, x.userId).name : "System"}</span><span className="w-44 text-blue-300">{x.action}</span><span className="min-w-0 flex-1 text-zinc-300">{x.detail}</span></li>)}</ul></Panel>}
      {cur === "ai" && <Panel title="AI activity" icon={Sparkles}><p className="mb-3 text-xs text-zinc-500">Every AI request is recorded: who, which feature, which model tier. The real app also stores token counts and timing.</p>{db.aiCalls.length === 0 ? <Empty>No AI requests yet in this session.</Empty> : <ul className="space-y-1 text-xs">{[...db.aiCalls].reverse().map((x) => <li key={x.id} className="flex gap-3 rounded border border-zinc-800 px-3 py-1.5"><span className="w-28 text-zinc-600">{fmtTime(x.at)}</span><span className="w-32 text-zinc-400">{userOf(db, x.userId).name}</span><span className="flex-1 text-blue-300">{x.feature}</span><span className="text-zinc-500">{x.model} model</span></li>)}</ul>}</Panel>}
    </div>
  );
}

/* ───────── Settings ───────── */
function SettingsView() {
  const { me, update, toast } = useApp();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="My settings" icon={Settings}><div className="grid gap-3 sm:grid-cols-2">
        <Field label="Where your day starts"><select className={inp} value={me.base} onChange={(e) => update((d) => { userOf(d, me.id).base = e.target.value; })}>{Object.keys(CITY).map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Phone shown in your signature"><input className={inp} value={me.phone} onChange={(e) => update((d) => { userOf(d, me.id).phone = e.target.value; })} /></Field>
        <Field label="Working hours"><input className={inp} disabled value="8:00 am to 5:30 pm, Monday to Friday" /></Field>
        <Field label="Daily email cap (set by your manager)"><input className={inp} disabled value={me.cap} /></Field></div></Panel>
      <Panel title="Mailbox and calendar" icon={Mail} right={<Pill tone={me.connected ? "g" : "a"}>{me.connected ? "Connected" : "Needs reconnect"}</Pill>}>
        <p className="text-sm text-zinc-400">Connected through your company sign-in as {me.email}. The CRM can send email you click Send on, read replies to those emails only, and read and create calendar events.</p>
        <div className="mt-3 flex flex-wrap gap-2">{me.connected ? <Btn kind="demo" onClick={() => { update((d) => { userOf(d, me.id).connected = false; }); toast("Connection expired (simulated).", "a"); }}>Demo: simulate an expired connection</Btn> : <Btn kind="primary" icon={Refresh} onClick={() => { update((d) => { userOf(d, me.id).connected = true; }); toast("Reconnected."); }}>Reconnect</Btn>}</div>
      </Panel>
    </div>
  );
}

/* ───────── shell and root ───────── */
function CRM() {
  const [db, setDb] = useState(seed); const [meId, setMeId] = useState(null); const [route, setRoute] = useState({ page: "today" }); const [toasts, setToasts] = useState([]);
  const update = (fn) => setDb((old) => { const next = JSON.parse(JSON.stringify(old)); fn(next); return next; });
  const toast = (text, tone = "g") => { const id = Math.random(); setToasts((t) => [...t, { id, text, tone }]); setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200); };
  const go = (page, extra = {}) => { setRoute({ page, ...extra }); try { window.scrollTo(0, 0); } catch (e) { /* no window scroll */ } };
  const me = meId && db.users.find((u) => u.id === meId);
  const aiLog = (feature, model) => update((d) => d.aiCalls.push({ id: nid(d, "ai"), userId: meId, feature, model, at: Date.now() }));
  useEffect(() => { const k = (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && meId) { e.preventDefault(); go("ask"); } }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [meId]);
  const signIn = (id) => { setMeId(id); setRoute({ page: "today" }); update((d) => audit(d, userOf(d, id), "auth.login", "Signed in with company single sign-on")); };
  if (!me) return <div className="soa-root min-h-screen bg-zinc-950 font-sans text-zinc-100"><DemoBar /><Login db={db} onPick={signIn} /></div>;
  const NAV = [["today", "Today", Sun], ["prospects", "Prospects", Search], ["pipeline", "Pipeline", Columns], ["calendar", "Calendar", Calendar], ["ask", "Ask Sales AI", Sparkles], ...(isMgr(me) ? [["admin", "Admin", ShieldCheck]] : []), ["settings", "Settings", Settings]];
  const page = route.page === "admin" && !isMgr(me) ? "today" : route.page;
  const nb = nextActions(db, me).length;
  return (
    <Ctx.Provider value={{ db, me, update, go, toast, route, aiLog }}>
      <div className="soa-root min-h-screen bg-zinc-950 font-sans text-zinc-100">
        <DemoBar right={<><label className="flex items-center gap-1.5">Viewing as <select aria-label="Switch user" className="rounded border border-amber-800 bg-amber-950 px-1.5 py-0.5 text-amber-100" value={me.id} onChange={(e) => { setMeId(e.target.value); setRoute({ page: "today" }); }}>{db.users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name} ({u.role === "ae" ? "AE" : u.role})</option>)}</select></label><button onClick={() => { setDb(seed()); setMeId(null); setRoute({ page: "today" }); }} className="flex items-center gap-1 rounded border border-amber-800 px-1.5 py-0.5 hover:bg-amber-900/50"><Reset size={11} />Reset demo</button></>} />
        <header className="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur"><div className="mx-auto flex max-w-[1400px] items-center gap-3 px-4 py-3"><Shield size={20} className="text-emerald-400" /><span className="font-semibold">Security Of America <span className="font-normal text-zinc-500">· Sales CRM</span></span><span className="ml-auto hidden text-sm text-zinc-400 sm:block">{me.name}, {me.title}</span><Btn small kind="ghost" icon={LogOut} onClick={() => setMeId(null)}>Sign out</Btn></div>
          <nav className="mx-auto flex max-w-[1400px] gap-1 overflow-x-auto px-3 pb-2">{NAV.map(([id, label, I]) => <button key={id} onClick={() => go(id)} aria-current={page === id ? "page" : undefined} className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm ${page === id || (id === "prospects" && page === "account") ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"}`}><I size={14} />{label}{id === "today" && nb > 0 && <span className="rounded-full bg-blue-600 px-1.5 text-xs text-white">{nb}</span>}</button>)}</nav></header>
        <main className="mx-auto max-w-[1400px] p-4">
          {page === "today" && <Today />}{page === "prospects" && <Prospects key={me.id} />}{page === "pipeline" && <Pipeline />}{page === "calendar" && <CalendarView />}{page === "ask" && <Ask key={me.id} />}{page === "admin" && <Admin />}{page === "settings" && <SettingsView />}
          {page === "account" && <AccountPage key={route.id} route={route} />}
        </main>
        <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">{toasts.map((t) => <div key={t.id} className={`rounded-lg border px-3 py-2 text-sm shadow-lg ${t.tone === "a" ? "border-amber-700 bg-amber-950 text-amber-100" : "border-emerald-700 bg-emerald-950 text-emerald-100"}`}>{t.text}</div>)}</div>
      </div>
    </Ctx.Provider>
  );
}
function DemoBar({ right }) {
  return <div className="border-b border-amber-900 bg-amber-950/70 text-xs text-amber-200"><div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5"><span className="flex items-center gap-1.5"><Flask size={12} />Demo of the planned Sales CRM · fictional companies and people · AI, email, calendar and e-signature are simulated · nothing is sent or saved</span><span className="ml-auto flex flex-wrap items-center gap-3">{right}</span></div></div>;
}
export default CRM;
