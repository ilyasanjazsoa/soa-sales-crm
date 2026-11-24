/* REFERENCE ONLY. Extracted from the Security Of America OS demo (sales section + the sign-in screen it uses).
   This file does not run on its own. It shows the intended screens, wording and logic. All AI here is simulated;
   all prospects and contacts are fictional. Do not copy the mock data or the simulated AI into the product. */
/* ───────── sales & marketing workspace (separate sign-in) ───────── */
/* All prospects, owners and contacts below are fictional demo data. */
const MI = 1609.34;
const CITY_XY = { Irving: [-10, 3], Plano: [2, 18], Arlington: [-18, -5], "Downtown Dallas": [0, 0], "Fort Worth (Alliance)": [-30, 12], Frisco: [0, 25], Garland: [12, 8], Mesquite: [14, -2], "Oak Lawn, Dallas": [-2, 2], Grapevine: [-17, 12], Lancaster: [2, -14], "Uptown Dallas": [-1, 2], "Dallas HQ": [0, 0] };
/* the sales week rolls to next week from Friday 3 pm through the weekend, so there's always time left to book */
const salesWeek = () => {
  const ws = weekStartOf(Date.now()), t = todayIdx(ws), nowH = new Date().getHours() + new Date().getMinutes() / 60;
  return t > 4 || (t === 4 && nowH >= 15) ? { ws: ws + 7 * DAY_MS, t: 0, nowH: -10, next: true } : { ws, t, nowH, next: false };
};
const dayWord = (day) => { const { t, next } = salesWeek(); return next ? DAYS[day] : day === t ? "today" : day === t + 1 ? "tomorrow" : DAYS[day]; };
const driveMin = (a, b) => Math.round(Math.hypot(a[0] - b[0], a[1] - b[1]) * 1.9 + 8);
const STAGES = ["Lead", "Researched", "Contacted", "Meeting set", "Proposal", "Contract sent", "Won"];
const STAGE_P = { Lead: 0.05, Researched: 0.1, Contacted: 0.2, "Meeting set": 0.35, Proposal: 0.55, "Contract sent": 0.8, Won: 1 };
const RATES = { unarmed: 29, armed: 38 };
const COVER = { "24/7": 168, "Nights (6 pm–6 am)": 84, "Business hours (Mon–Fri)": 60 };
const ADDONS = { patrol: { label: "Mobile patrol, 3 visits a night", mo: 1450 }, video: { label: "Remote video monitoring", mo: 2200 }, portal: { label: "Client portal with live officer map", mo: 0 } };
const lc1 = (t) => (t ? t.charAt(0).toLowerCase() + t.slice(1) : t);
const money = (n) => "$" + Math.round(n).toLocaleString();
const moneyK = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n > 0 ? `$${Math.round(n / 1000)}k` : "$0");
const fmtHour = (h) => `${Math.floor(h) % 12 || 12}:${h % 1 ? "30" : "00"} ${h < 12 ? "am" : "pm"}`;
function price(pk) {
  const hours = pk.posts * COVER[pk.coverage];
  const rate = RATES[pk.armed ? "armed" : "unarmed"] * (pk.supervisor ? 1.05 : 1);
  const addMo = pk.addons.reduce((n, k) => n + ADDONS[k].mo, 0);
  const disc = pk.term === 36 ? 0.05 : pk.term === 24 ? 0.03 : 0;
  const annual = (hours * rate * 52 + addMo * 12) * (1 - disc);
  return { hours, rate, addMo, disc, annual, monthly: annual / 12 };
}

const PROSPECTS = [
  { id: "meridian", hook: "the park has had two cargo thefts in the last 90 days, and the current guard contract ends January 31", subj: "Cargo theft at Meridian and the Jan 31 renewal", name: "Meridian Logistics Park", type: "Industrial", city: "Irving", owner: "Meridian Industrial Trust", size: "640,000 sq ft, 4 buildings", built: 2019, occ: "92%", provider: "Regional guard company", renew: "Contract ends Jan 31", index: 8,
    signals: ["2 cargo thefts in the park in the last 90 days", "Current guard contract ends Jan 31", "Tenants asked for after-hours gate control"],
    contacts: [{ name: "Dana Whitaker", title: "Regional Property Manager", email: "d.whitaker@meridian-trust.example", phone: "(972) 555-0191", pref: "Prefers morning meetings" }, { name: "Greg Tull", title: "VP Asset Management", email: "g.tull@meridian-trust.example", phone: "(972) 555-0102", pref: "Signs contracts over $500k" }],
    suggest: { posts: 2, coverage: "24/7", armed: false, supervisor: true, addons: ["patrol", "portal"], term: 24 }, fit: 92 },
  { id: "northgate", hook: "your tenant moves to 24/7 operations in Q1, and the 400-space trailer yard has no gate staff yet", subj: "Gate coverage for Northgate's 24/7 start", name: "Northgate Distribution Center", type: "Industrial", city: "Fort Worth (Alliance)", owner: "Northgate Logistics Fund II", size: "1.1M sq ft cross-dock", built: 2021, occ: "100%", provider: "None, tenant-managed", renew: "New 24/7 operation starts in Q1", index: 6,
    signals: ["Tenant moves to 24/7 operations in Q1", "Trailer yard of 400+ spaces with no gate staff", "Insurance carrier asked for a manned gate"],
    contacts: [{ name: "Alicia Moreno", title: "Facilities Manager", email: "a.moreno@northgate-fund.example", phone: "(817) 555-0164", pref: "Best reached by phone after 2 pm" }],
    suggest: { posts: 2, coverage: "24/7", armed: false, supervisor: false, addons: ["video", "portal"], term: 36 }, fit: 89 },
  { id: "bluebonnet", hook: "your new pharma tenant requires GDP-trained security ahead of an audit in 60 days", subj: "GDP-trained security before your pharma audit", name: "Bluebonnet Cold Storage", type: "Cold chain warehouse", city: "Lancaster", owner: "Bluebonnet Cold Chain Inc.", size: "310,000 sq ft, 14 cold rooms", built: 2016, occ: "88%", provider: "In-house night watch", renew: "Pharma tenant audit in 60 days", index: 5,
    signals: ["New pharma tenant requires GDP-trained security", "Temperature alarms handled by one night watchman", "Audit in 60 days"],
    contacts: [{ name: "Grace Holloway", title: "Operations Director", email: "g.holloway@bluebonnet-cold.example", phone: "(972) 555-0148", pref: "Prefers afternoon meetings" }],
    suggest: { posts: 1, coverage: "24/7", armed: false, supervisor: false, addons: ["video", "portal"], term: 24 }, fit: 90 },
  { id: "lakeview", hook: "the parking garage has had after-hours vandalism, and the new oncology wing opens in March", subj: "Lakeview garage coverage", name: "Lakeview Medical Plaza", type: "Medical office", city: "Plano", owner: "Lakeview Healthcare Properties", size: "180,000 sq ft, 3 floors + garage", built: 2012, occ: "95%", provider: "Regional guard company", renew: "Renews in April", index: 4,
    signals: ["After-hours vandalism in the parking garage", "New oncology wing opens in March", "Staff escort requests after 7 pm"],
    contacts: [{ name: "Marcus Bell", title: "Director of Facilities", email: "m.bell@lakeview-hp.example", phone: "(469) 555-0127", pref: "Prefers morning meetings" }],
    suggest: { posts: 1, coverage: "Nights (6 pm–6 am)", armed: false, supervisor: false, addons: ["patrol", "portal"], term: 12 }, fit: 84 },
  { id: "oaklawn", hook: "the site has lost copper and tools three times since September, and your builder's risk policy calls for a night guard", subj: "Night coverage at Oak Lawn Tower", name: "Oak Lawn Tower (construction)", type: "Construction site", city: "Oak Lawn, Dallas", owner: "Oak Lawn Development LLC", size: "32-story tower under construction", built: 2027, occ: "Pre-leasing", provider: "Cameras only", renew: "Topping out in May", index: 7,
    signals: ["3 copper and tool thefts since September", "Builder's risk policy requires a night guard", "Crane yard open to the street"],
    contacts: [{ name: "Sara Kim", title: "Project Executive", email: "s.kim@oaklawn-dev.example", phone: "(214) 555-0186", pref: "On site 6 am–2 pm" }],
    suggest: { posts: 1, coverage: "Nights (6 pm–6 am)", armed: true, supervisor: false, addons: ["video", "portal"], term: 12 }, fit: 87 },
  { id: "titanium-x", hook: "our patrol data shows two north fence breaches in 14 days, all between 1 and 4 am", subj: "North fence: a fix before the renewal", name: "Titanium Logistics Hub (expansion)", type: "Existing client", city: "Irving", owner: "Titanium Freight Group", size: "Current client since 2022", built: 2015, occ: "Client", provider: "Security Of America", renew: "Renews in 45 days", index: 8,
    signals: ["Ops data: 2 north fence breaches in 14 days, all 01:00–04:00", "Client asked about camera coverage on the north fence", "Contract renews in 45 days"],
    contacts: [{ name: "Ray Dominguez", title: "Site Operations Manager", email: "r.dominguez@titanium-freight.example", phone: "(972) 555-0175", pref: "Prefers calls before 9 am" }],
    suggest: { posts: 1, coverage: "Nights (6 pm–6 am)", armed: true, supervisor: false, addons: ["video"], term: 24 }, fit: 95 },
  { id: "trinity", hook: "you're planning a lobby access upgrade this spring, and tenants have raised tailgating concerns", subj: "Lobby access upgrade at Trinity Gateway", name: "Trinity Gateway Tower", type: "Class A office", city: "Downtown Dallas", owner: "Gateway Tower Holdings", size: "28 floors, 610,000 sq ft", built: 2008, occ: "81%", provider: "Regional guard company", renew: "Lobby access upgrade planned", index: 5,
    signals: ["Lobby turnstile and access upgrade planned for spring", "Tenant complaints about tailgating", "Occupancy recovering, lease-up incentives"],
    contacts: [{ name: "Robert Lin", title: "VP Operations", email: "r.lin@gateway-holdings.example", phone: "(214) 555-0139", pref: "Assistant books meetings" }],
    suggest: { posts: 2, coverage: "Business hours (Mon–Fri)", armed: false, supervisor: true, addons: ["portal"], term: 24 }, fit: 71 },
  { id: "sterling", hook: "your SOC 2 auditor asked for a 24/7 manned post before the second data hall opens", subj: "A 24/7 post for your SOC 2 audit", name: "Sterling Data Center", type: "Data center", city: "Garland", owner: "Sterling Digital Infrastructure", size: "12 MW, 2 data halls", built: 2020, occ: "97%", provider: "In-house", renew: "SOC 2 audit in Q2", index: 3,
    signals: ["SOC 2 auditor asked for a 24/7 manned post", "Mantrap and visitor logs are manual", "Second data hall opening"],
    contacts: [{ name: "Nina Patel", title: "Security Compliance Lead", email: "n.patel@sterling-di.example", phone: "(972) 555-0158", pref: "Prefers video calls" }],
    suggest: { posts: 1, coverage: "24/7", armed: false, supervisor: false, addons: ["portal"], term: 36 }, fit: 81 },
  { id: "cedar", hook: "residents have reported more package theft since the renovation, right as you're in lease-up", subj: "Package theft at Cedar Ridge", name: "Cedar Ridge Apartments", type: "Multifamily", city: "Arlington", owner: "Cedar Ridge Residential Partners", size: "420 units", built: 1998, occ: "86% after renovation", provider: "None", renew: "Lease-up after renovation", index: 6,
    signals: ["Package theft complaints up after renovation", "Lease-up marketing promises a safer community", "Gate left open overnight"],
    contacts: [{ name: "Priya Shah", title: "Asset Manager", email: "p.shah@cedar-ridge.example", phone: "(817) 555-0123", pref: "Prefers afternoon meetings" }],
    suggest: { posts: 1, coverage: "Nights (6 pm–6 am)", armed: false, supervisor: false, addons: ["patrol"], term: 12 }, fit: 76 },
  { id: "grapevine", hook: "your spring convention calendar is filling up, and event security is handled by front-desk staff today", subj: "Event security for your spring conventions", name: "Grapevine Lakes Hotel & Conference Center", type: "Hospitality", city: "Grapevine", owner: "Lakes Hospitality Partners", size: "380 rooms, 60,000 sq ft event space", built: 2011, occ: "74%", provider: "In-house", renew: "Event calendar doubles in spring", index: 4,
    signals: ["Large conventions booked for spring", "Event security handled by front-desk staff", "Parking garage car break-ins"],
    contacts: [{ name: "Luis Ortega", title: "General Manager", email: "l.ortega@lakes-hospitality.example", phone: "(817) 555-0170", pref: "Prefers morning meetings" }],
    suggest: { posts: 1, coverage: "Nights (6 pm–6 am)", armed: false, supervisor: false, addons: ["patrol", "portal"], term: 12 }, fit: 74 },
  { id: "prairie", hook: "tenants are reporting more shoplifting ahead of the holidays and asking for a visible patrol", subj: "A visible patrol for the holidays", name: "Prairie Commons Shopping Center", type: "Retail", city: "Frisco", owner: "Prairie Retail Group", size: "260,000 sq ft, 41 tenants", built: 2005, occ: "90%", provider: "Regional guard company", renew: "Holiday season", index: 5,
    signals: ["Shoplifting reports up before the holidays", "Tenants want a visible patrol", "Parking lot lighting complaints"],
    contacts: [{ name: "Kevin O'Hara", title: "Property Manager", email: "k.ohara@prairie-retail.example", phone: "(469) 555-0111", pref: "Prefers afternoon meetings" }],
    suggest: { posts: 1, coverage: "Business hours (Mon–Fri)", armed: false, supervisor: false, addons: ["patrol"], term: 12 }, fit: 68 },
  { id: "riverside", hook: "you've had four unit break-ins this year and your insurance premium went up 18%", subj: "Fewer break-ins (and a lower premium) at Riverside", name: "Riverside Self Storage", type: "Self storage", city: "Mesquite", owner: "Riverside Storage Co.", size: "900 units", built: 2001, occ: "93%", provider: "None", renew: "Insurance renewal in 90 days", index: 7,
    signals: ["4 unit break-ins this year", "Insurance premium up 18%", "Owner-operated, small budget"],
    contacts: [{ name: "Tom Becker", title: "Owner", email: "tom@riverside-storage.example", phone: "(972) 555-0105", pref: "Prefers evening calls" }],
    suggest: { posts: 0, coverage: "Nights (6 pm–6 am)", armed: false, supervisor: false, addons: ["patrol", "video"], term: 12 }, fit: 55 },
];
const PROS = Object.fromEntries(PROSPECTS.map((p) => [p.id, p]));
const fitWhy = (p) => [p.index >= 7 ? "High incident activity nearby" : p.index >= 5 ? "Moderate incident activity" : null, /ends|renew|audit|starts|opens|Topping/.test(p.renew) ? `Timing: ${lc1(p.renew)}` : null, p.provider === "None" || /In-house|Cameras|tenant-managed/.test(p.provider) ? "No professional guard service today" : `Incumbent: ${p.provider.toLowerCase()}`, price(p.suggest).annual >= 400000 ? "Large contract value" : null].filter(Boolean);
const CASE = { Industrial: "titanium", "Cold chain warehouse": "harbor", "Medical office": "harbor", "Construction site": "titanium", "Existing client": "titanium", "Class A office": "apex", "Data center": "apex", Multifamily: "apex", Hospitality: "apex", Retail: "amazon", "Self storage": "amazon" };
const CASE_ANON = { titanium: "a logistics hub we protect in Irving", harbor: "a pharma campus we protect in Dallas", apex: "a financial center we protect in Dallas", amazon: "a large distribution warehouse we protect in DFW" };
const proofAnon = (p, sites) => { const s = sites.find((x) => x.id === CASE[p.type]) || sites[0]; return s ? `At ${CASE_ANON[s.id] || "a similar site we protect"}, officers hit ${s.kpi?.comp || "98%"} patrol compliance with a ${s.kpi?.resp || "4 min"} average response, and the client sees every GPS-verified patrol in real time` : ""; };
const caseStudy = (p, sites) => { const s = sites.find((x) => x.id === CASE[p.type]) || sites[0]; return s ? `${s.name}: ${s.kpi?.comp || "98%"} patrol compliance and a ${s.kpi?.resp || "4 min"} average response, with every patrol verified by GPS and visible to the client in real time` : ""; };

const INIT_SALES = () => {
  const { t } = salesWeek();
  const d = (n) => Math.min(4, t + n);
  return {
    deals: [
      { id: "D-201", pid: "meridian", stage: "Meeting set", touched: 1, opens: 2 },
      { id: "D-202", pid: "northgate", stage: "Contacted", touched: 2, opens: 3 },
      { id: "D-203", pid: "lakeview", stage: "Proposal", touched: 6, opens: 1, proposal: { status: "sent", day: "6 days ago" } },
      { id: "D-204", pid: "bluebonnet", stage: "Researched", touched: 3, opens: 0 },
      { id: "D-205", pid: "oaklawn", stage: "Contract sent", touched: 3, opens: 4, proposal: { status: "sent", day: "3 days ago" } },
      { id: "D-206", pid: "titanium-x", stage: "Proposal", touched: 2, opens: 1 },
      { id: "D-207", pid: "trinity", stage: "Lead", touched: 9, opens: 0 },
    ],
    activity: {
      meridian: [["Meeting booked: on-site walk with Dana Whitaker", "1 day ago"], ["Discovery call: cargo thefts and the incumbent's Jan 31 end date", "4 days ago"], ["Email opened twice", "5 days ago"]],
      northgate: [["Email opened 3 times (most recently 2 h ago)", "today"], ["Intro email sent to Alicia Moreno", "2 days ago"]],
      lakeview: [["Proposal sent: 1 night post with mobile patrol", "6 days ago"], ["On-site meeting with Marcus Bell", "9 days ago"]],
      bluebonnet: [["Research brief generated", "3 days ago"]],
      oaklawn: [["Contract sent for e-signature, viewed 4 times", "3 days ago"], ["Proposal accepted verbally by Sara Kim", "5 days ago"]],
      "titanium-x": [["Upsell idea flagged from ops data: north fence breaches", "2 days ago"]],
      trinity: [["Added from a commercial listing alert", "9 days ago"]],
    },
    meetings: [
      { id: "M-1", pid: null, title: "Pipeline review with sales director", day: t, start: 15, dur: 1, where: "Dallas HQ" },
      { id: "M-2", pid: "meridian", title: "On-site walk: Meridian Logistics Park", day: d(1), start: 10, dur: 1.5, where: "Irving" },
      { id: "M-3", pid: null, title: "Marketing sync: Q1 campaign", day: d(2), start: 9, dur: 1, where: "Dallas HQ" },
      { id: "M-4", pid: "lakeview", title: "Call: Lakeview Medical check-in", day: d(2), start: 14, dur: 0.5, where: "Phone" },
      { id: "M-5", pid: null, title: "Chamber of Commerce breakfast", day: d(3), start: 8, dur: 1.5, where: "Downtown Dallas" },
    ],
    wins: [],
  };
};

function nextActions(s) {
  const out = [];
  const { t, nowH } = salesWeek();
  s.meetings.filter((m) => m.pid && (m.day === t ? m.start > nowH : m.day === t + 1)).forEach((m) => out.push({ pri: 0, pid: m.pid, text: `${m.title} ${dayWord(m.day)} at ${fmtHour(m.start)}. Your prep brief is ready.`, cta: "Open prep brief", sec: "meetings" }));
  s.deals.forEach((d) => {
    const p = PROS[d.pid], c = p.contacts[0];
    if (d.stage === "Contract sent") out.push({ pri: 1, pid: p.id, text: `${c.name} viewed the ${p.name} contract ${d.opens} times but hasn't signed (sent ${d.proposal?.day || `${d.touched} days ago`}). Send a short nudge and offer a 10-minute call.`, cta: "Draft nudge", sec: "outreach", channel: "email" });
    else if (d.stage === "Contacted" && d.opens >= 3) out.push({ pri: 1, pid: p.id, text: `${c.name} opened your email ${d.opens} times. Call while it's fresh. ${c.pref}.`, cta: "Open call script", sec: "outreach", channel: "call" });
    else if (d.stage === "Proposal" && d.touched >= 5) out.push({ pri: 2, pid: p.id, text: `${p.name}: proposal sent ${d.touched} days ago with no reply. Follow up with a relevant case study.`, cta: "Draft follow-up", sec: "outreach", channel: "email" });
    else if (d.stage === "Proposal" && p.type === "Existing client") out.push({ pri: 2, pid: p.id, text: `Upsell: ${p.signals[0]}. Propose ${ADDONS.video.label.toLowerCase()} before the renewal.`, cta: "Build proposal", sec: "proposal" });
    else if (d.stage === "Researched") out.push({ pri: 3, pid: p.id, text: `${p.name} is researched but not contacted yet. Lead with: ${lc1(p.signals[0])}.`, cta: "Start outreach", sec: "outreach", channel: "email" });
    else if (d.stage === "Lead") out.push({ pri: 4, pid: p.id, text: `${p.name} needs research before outreach (${lc1(p.signals[0])}).`, cta: "Research", sec: "research" });
  });
  return out.sort((a, b) => a.pri - b.pri);
}

function researchBrief(p, sites) {
  const pk = price(p.suggest);
  return [
    { h: "Overview", t: `${p.name} is a ${lc1(p.type)} property in ${p.city} (${p.size}), owned by ${p.owner}. Built ${p.built}, ${p.occ} occupied.` },
    { h: "Decision makers", t: p.contacts.map((c) => `${c.name}, ${c.title}. ${c.pref}.`).join("\n") },
    { h: "Security signals", t: p.signals.map((s) => `- ${s}`).join("\n") },
    { h: "Current coverage and timing", t: `${p.provider}. ${p.renew}.` },
    { h: "Recommended package", t: `${p.suggest.posts ? `${p.suggest.posts} ${p.suggest.armed ? "armed" : "unarmed"} post${p.suggest.posts > 1 ? "s" : ""}, ${lc1(p.suggest.coverage)}` : "No fixed post"}${p.suggest.addons.length ? `, plus ${p.suggest.addons.map((a) => ADDONS[a].label.toLowerCase()).join(" and ")}` : ""}. Estimated ${money(pk.annual)} a year on a ${p.suggest.term}-month term.` },
    { h: "Proof point (internal)", t: `${caseStudy(p, sites)}. Outreach uses an anonymized version unless the client approves a named reference.` },
    { h: "Talking points", t: [`Open with their problem: ${lc1(p.signals[0])}.`, /ends|renew/i.test(p.renew) ? `The timing works: ${lc1(p.renew)}, so a switch needs no early-termination cost.` : `Tie the start date to: ${lc1(p.renew)}.`, "Show the client portal: live officer map, GPS-verified patrols and AI-audited reports the same night.", "Offer a 14-day transition plan with no coverage gap."].map((x) => `- ${x}`).join("\n") },
    { h: "Likely objections", t: ["\"Our current company is cheaper.\" Compare cost per verified patrol, not hourly rate: every round is GPS-logged and visible to them.", `"We handle it in-house." ${/In-house|tenant/.test(p.provider) ? "Their in-house watch has no reporting, backup or SOP training. We add both without adding headcount." : "Offer a 30-day pilot on nights only."}`, "\"Switching is risky.\" 14-day transition, incumbent officers can be interviewed and kept."].map((x) => `- ${x}`).join("\n") },
  ];
}

function draftOutreach(p, channel, tone, ci, slots, sites, stage) {
  const c = p.contacts[ci] || p.contacts[0], first = c.name.split(" ")[0];
  const proof = proofAnon(p, sites);
  const short = p.name.replace(/ \(.*\)$/, "");
  const open = tone === "Direct" ? `${first}, quick one.` : tone === "Friendly" ? `Hi ${first}, hope your week is off to a good start.` : `Hi ${first},`;
  const times = slots.length ? slots.slice(0, 2).map((s) => s.label).join(" or ") : "early next week";
  const sign = "Thanks,\nJordan Reyes\nAccount Executive, Security Of America\n\nSecurity Of America · Dallas, TX · Unsubscribe";
  if (channel === "email") {
    if (stage === "Contract sent") return { subject: `Quick check on the ${short} agreement`, body: `${open}\n\nJust checking whether you had any questions on the agreement I sent over. I'm happy to walk through it in 10 minutes, ${times}.\n\nOnce it's signed we start a 14-day onboarding with no coverage gap.\n\n${sign}` };
    if (stage === "Proposal") return { subject: `Re: proposal for ${short}`, body: `${open}\n\nFollowing up on the proposal for ${short}. One thing that may help with the decision: ${proof.charAt(0).toLowerCase() + proof.slice(1)}.\n\nWould ${times} work for a short call to answer any questions?\n\n${sign}` };
    return { subject: p.subj, body: `${open}\n\nI'm reaching out because ${p.hook}.\n\nWe protect similar ${lc1(p.type)} sites across DFW. ${proof}.\n\nCould I walk the property with you for 30 minutes, ${times}?\n\n${sign}` };
  }
  if (channel === "call") return { subject: `Call script: ${c.name}`, body: `Opener: "Hi ${first}, it's Jordan with Security Of America. I'll be brief. I'm calling because ${p.hook}. Is that still a concern?"\n\nIf yes, ask:\n- What happens today when something goes wrong after hours?\n- How do you know a patrol actually happened?\n- Who else would weigh in on a change, and by when?\n\nProof: "${proof}."\n\nAsk: "Could I walk the site with you ${times}?"\n\nIf not now: "Can I send a one-page plan and check back next week?"` };
  if (channel === "voicemail") return { subject: "Voicemail (20 seconds)", body: `Hi ${first}, Jordan Reyes from Security Of America. I'm calling because ${p.hook}. We cover similar sites across DFW with GPS-verified patrols you can watch live. I'll send a short email with two times to meet. My number is (214) 555-0100. Thanks.` };
  return { subject: "LinkedIn note", body: `Hi ${first}, I work with ${lc1(p.type)} owners across DFW on site security. I saw that ${p.hook.replace(/^your /, "your team's ").slice(0, 150)}, and a short conversation could be useful. Open to connecting?` };
}
const sites_names = () => INIT_SITES.map((x) => x.name);
const outreachChecks = (channel, body, p, c) => [
  channel === "email" ? [/Unsubscribe/.test(body) && /Dallas, TX/.test(body), "Physical address and unsubscribe link included (CAN-SPAM)"] : null,
  channel === "call" || channel === "voicemail" ? [true, `${c.phone} is a business line and not on the do-not-call list (mock lookup)`] : null,
  [!/guarantee|100%|never fail/i.test(body), "No guarantees or absolute claims"],
  [!/competitor|worse than|bad company/i.test(body), "Doesn't disparage the incumbent"],
  [!sites_names().some((n) => body.includes(n)), "No client named without permission (references are anonymized)"],
  [body.length < (channel === "linkedin" ? 300 : 1200), channel === "linkedin" ? "Under LinkedIn's 300-character note limit" : "Short enough to read on a phone"],
].filter(Boolean);

function findSlots(p, meetings, dur = 1) {
  const { t, nowH } = salesWeek();
  const at = CITY_XY[p.city] || [0, 0];
  const morning = /morning|before 9|6 am/i.test(p.contacts[0].pref), afternoon = /afternoon|after 2/i.test(p.contacts[0].pref);
  const out = [];
  for (let day = t; day <= 4; day++) {
    const mine = meetings.filter((m) => m.day === day).sort((a, b) => a.start - b.start);
    for (let start = 8; start + dur <= 17.5; start += 0.5) {
      if (day === t && start < nowH + 2) continue;
      const end = start + dur;
      if (mine.some((m) => start < m.start + m.dur && end > m.start)) continue;
      const prev = [...mine].reverse().find((m) => m.start + m.dur <= start);
      const next = mine.find((m) => m.start >= end);
      const fromXY = prev ? CITY_XY[prev.where] || at : CITY_XY["Dallas HQ"];
      const dIn = prev?.where === "Phone" ? driveMin(CITY_XY["Dallas HQ"], at) : driveMin(fromXY, at);
      if ((prev ? prev.start + prev.dur : 7.5) + dIn / 60 > start) continue;
      const dOut = next && next.where !== "Phone" ? driveMin(at, CITY_XY[next.where] || at) : 0;
      if (next && end + dOut / 60 > next.start) continue;
      let score = 100 - (day - t) * 6 - dIn / 3 - dOut / 3;
      if (morning && start < 12) score += 15; if (afternoon && start >= 13) score += 15;
      if (morning && start >= 13) score -= 10; if (afternoon && start < 12) score -= 10;
      out.push({ day, start, dur, score, dIn, dOut, label: `${dayWord(day) === "today" ? "today" : DAYS[day]} at ${fmtHour(start)}`,
        why: [`${dIn} min drive from ${prev ? (prev.where === "Phone" ? "the office" : prev.where) : "the office"}`, next ? `${dOut ? `${dOut} min to` : "clear before"} your ${fmtHour(next.start)} ${next.title.split(":")[0].toLowerCase()}` : "nothing after it", (morning && start < 12) || (afternoon && start >= 13) ? `matches "${p.contacts[0].pref.toLowerCase()}"` : null].filter(Boolean) });
    }
  }
  const picked = [];
  out.sort((a, b) => b.score - a.score).forEach((s) => { if (picked.length < 3 && !picked.some((x) => x.day === s.day)) picked.push(s); });
  return picked.sort((a, b) => a.day - b.day || a.start - b.start);
}

function prepBrief(p, meeting, sites) {
  const pk = price(p.suggest);
  return [
    { h: "Goal", t: `Walk the site, confirm the problem (${lc1(p.signals[0])}) and agree on next steps toward a proposal by end of week.` },
    { h: "Who you're meeting", t: p.contacts.map((c) => `${c.name}, ${c.title}. ${c.pref}.`).join("\n") },
    { h: "Agenda (30 min)", t: "- 5 min: their goals and what's not working\n- 15 min: walk gates, docks, parking and blind spots\n- 5 min: demo the client portal on your phone\n- 5 min: agree on next steps" },
    { h: "Questions to ask", t: `- What happened with ${lc1(p.signals[0])}?\n- Who needs to approve a change, and by when?\n- What does the current setup cost per month?\n- What would make the first 30 days a success?` },
    { h: "Bring", t: `Case study: ${caseStudy(p, sites)}. Price range: ${moneyK(pk.annual * 0.9)}–${moneyK(pk.annual * 1.1)} a year.` },
    { h: "Logistics", t: meeting ? `${dayLabel(salesWeek().ws, meeting.day)} at ${fmtHour(meeting.start)}, ${meeting.where}. Leave ${driveMin(CITY_XY["Dallas HQ"], CITY_XY[p.city] || [0, 0])} min early from the office.` : "No meeting booked yet." },
  ];
}

function salesCopilot(q, s, sites) {
  const t = q.toLowerCase();
  const deal = s.deals.find((d) => t.includes(PROS[d.pid].name.toLowerCase().split(" ")[0]));
  const open = s.deals.filter((d) => d.stage !== "Won");
  if (/draft|write|email|follow.?up/.test(t) && deal) {
    const p = PROS[deal.pid], dft = draftOutreach(p, "email", "Consultative", 0, findSlots(p, s.meetings), sites, deal.stage);
    return { text: `Subject: ${dft.subject}\n\n${dft.body}`, items: [{ label: `Open ${p.name} outreach`, pid: p.id, sec: "outreach" }] };
  }
  if (/stall|stuck|no reply|haven.?t heard|gone quiet/.test(t)) {
    const st = open.filter((d) => d.touched >= 5);
    return { text: st.length ? `${st.length} deal${st.length > 1 ? "s have" : " has"} had no reply in 5+ days.` : "No stalled deals.", items: st.map((d) => ({ label: `${PROS[d.pid].name} · ${d.stage}`, sub: `Last touch ${d.touched} days ago`, pid: d.pid, sec: "outreach" })) };
  }
  if (/prep|next meeting|meeting/.test(t)) {
    const { t: td, nowH } = salesWeek();
    const m = s.meetings.filter((x) => x.pid && (x.day > td || (x.day === td && x.start > nowH))).sort((a, b) => a.day - b.day || a.start - b.start)[0];
    if (!m) return { text: "No customer meetings are booked this week." };
    return { text: prepBrief(PROS[m.pid], m, sites).map((x) => `${x.h}\n${x.t}`).join("\n\n"), items: [{ label: `Open ${PROS[m.pid].name}`, pid: m.pid, sec: "meetings" }] };
  }
  if (/forecast|pipeline|quota|value|worth/.test(t)) {
    const val = (d) => price(d.pkg || PROS[d.pid].suggest).annual;
    const total = open.reduce((n, d) => n + val(d), 0), weighted = open.reduce((n, d) => n + val(d) * STAGE_P[d.stage], 0);
    return { text: `Open pipeline: ${moneyK(total)} across ${open.length} deals. Weighted forecast: ${moneyK(weighted)}. Won this session: ${s.wins.length}.`, items: STAGES.filter((x) => x !== "Won").map((st) => ({ label: st, sub: `${open.filter((d) => d.stage === st).length} deals, ${moneyK(open.filter((d) => d.stage === st).reduce((n, d) => n + val(d), 0))}` })) };
  }
  if (/find|prospect|warehouse|industrial|medical|office|apartment|multifamily|construction|retail|hotel|storage|data center|cold/.test(t)) {
    const r = searchProspects(q, {});
    return { text: `${r.length} matching prospects, best fit first.`, items: r.slice(0, 5).map((p) => ({ label: `${p.name} · fit ${p.fit}`, sub: `${p.type}, ${p.city}. ${p.signals[0]}`, pid: p.id, sec: "research" })) };
  }
  if (/call|today|priorit|next|focus|should i/.test(t)) {
    const n = nextActions(s);
    return { text: `Your top ${Math.min(5, n.length)} moves today, most valuable first.`, items: n.slice(0, 5).map((a) => ({ label: PROS[a.pid].name, sub: a.text, pid: a.pid, sec: a.sec, channel: a.channel })) };
  }
  return { text: "I can find prospects (\"industrial sites in Irving\"), rank today's calls, flag stalled deals, prep your next meeting, forecast the pipeline, or draft a follow-up (\"draft a follow-up for Lakeview\")." };
}

function searchProspects(q, f) {
  const s = (q || "").toLowerCase().replace("cold storage", "cold");
  const types = { warehouse: ["Industrial", "Cold chain warehouse"], industrial: ["Industrial"], logistic: ["Industrial"], cold: ["Cold chain warehouse"], pharma: ["Cold chain warehouse"], medical: ["Medical office"], hospital: ["Medical office"], office: ["Class A office"], apartment: ["Multifamily"], multifamily: ["Multifamily"], residential: ["Multifamily"], construction: ["Construction site"], retail: ["Retail"], shopping: ["Retail"], hotel: ["Hospitality"], hospitality: ["Hospitality"], storage: ["Self storage"], "data center": ["Data center"] };
  const want = Object.entries(types).filter(([k]) => s.includes(k)).flatMap(([, v]) => v);
  const city = Object.keys(CITY_XY).filter((c) => c !== "Dallas HQ").find((c) => s.includes(c.toLowerCase().split(" ")[0].replace(",", "")));
  return PROSPECTS.filter((p) => p.type !== "Existing client" && (!want.length || want.includes(p.type)) && (!city || p.city === city) && (!f.type || f.type === "all" || p.type === f.type) && (!f.minFit || p.fit >= f.minFit) && (!/high.?risk|theft|crime/.test(s) || p.index >= 6) && (!/24\/7|around the clock/.test(s) || p.suggest.coverage === "24/7")).sort((a, b) => b.fit - a.fit);
}

/* ───────── sales UI ───────── */
const APP_AUTH = {
  portal: { title: "Dispatcher portal", sub: "Sign-in for operations and dispatch staff", icon: Monitor, email: "morgan.hayes@soa-demo.example", user: { name: "Morgan Hayes", title: "Night Shift Dispatcher" },
    grant: "alerts, dispatch, reports, roster, scheduling and live officer locations", deny: "the sales pipeline", note: "Dispatchers see every site but not sales data." },
  guard: { title: "Guard app", sub: "Officer sign-in", icon: Shield, email: "m.alvarez@soa-demo.example", user: { name: "M. Alvarez", title: "Officer G-214" },
    grant: "your shift, your site's SOPs and incident reporting", deny: "other sites, client data and dispatch tools", note: "Officers only see their own site." },
  client: { title: "Client portal", sub: "Sign-in for Security Of America clients", icon: Building2, email: "ray.dominguez@titanium-freight.example", user: { name: "Ray Dominguez", title: "Titanium Freight Group" }, siteId: "titanium",
    grant: "your site's live map, audited reports and service requests", deny: "other clients' data, officer details and internal operations", note: "Clients only see their own sites." },
  sales: { title: "Sales workspace", sub: "Separate sign-in for the sales and marketing team", icon: Briefcase, email: "jordan.reyes@soa-demo.example", user: { name: "Jordan Reyes", title: "Account Executive" },
    grant: "CRM, prospect research and outreach", deny: "officer locations, incident reports and client SOPs", note: "Sales users can't see officer locations, incident reports or client SOPs." },
};

function AppLogin({ app, onSignIn, compact }) {
  const { push } = useAi();
  const cfg = APP_AUTH[app];
  const I = cfg.icon;
  const [step, setStep] = useState("cred");
  const [email, setEmail] = useState(cfg.email);
  const [pw, setPw] = useState("demo-password");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const field = "mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none";
  const next = async () => {
    if (!/^\S+@\S+\.\S+$/.test(email) || !pw) { setErr("Enter your work email and password."); return; }
    setErr(""); setBusy(true); await sleep(600); setBusy(false); setStep("mfa");
    push(`${cfg.title} sign-in: password accepted for ${email}; MFA challenge sent`, "net");
  };
  const verify = async () => {
    if (!/^\d{6}$/.test(code)) { setErr("Enter the 6-digit code from your authenticator app."); return; }
    setErr(""); setBusy(true); await sleep(500); setBusy(false);
    push(`${cfg.title} sign-in complete: ${cfg.user.title}. Granted: ${cfg.grant}. Denied: ${cfg.deny}`, "ok");
    onSignIn({ ...cfg.user, email });
  };
  return (
    <div className={compact ? "flex flex-1 flex-col justify-center" : "flex justify-center pt-8"}>
      <div className={`w-full space-y-4 ${compact ? "" : "max-w-sm rounded-xl border border-zinc-800 bg-zinc-900 p-6"}`}>
        <div className="flex items-center gap-2"><I size={20} className="text-blue-400" /><div><p className="font-semibold text-zinc-100">{cfg.title}</p><p className="text-xs text-zinc-500">{cfg.sub}</p></div></div>
        {step === "cred" ? (
          <>
            <label className="block text-xs text-zinc-500">Work email<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" className={field} /></label>
            <label className="block text-xs text-zinc-500">Password<input value={pw} onChange={(e) => setPw(e.target.value)} type="password" autoComplete="current-password" onKeyDown={(e) => e.key === "Enter" && next()} className={field} /></label>
            {err && <p className="text-xs text-red-400">{err}</p>}
            <button onClick={next} disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60">{busy ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}Sign in</button>
            <button onClick={next} className="w-full rounded-md border border-zinc-700 py-2 text-sm text-zinc-300 hover:border-zinc-500">Sign in with company SSO</button>
            <p className="text-xs text-zinc-500">Demo account filled in. {cfg.note}</p>
          </>
        ) : (
          <>
            <p className="text-sm text-zinc-300">Enter the 6-digit code from your authenticator app.</p>
            <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" aria-label="Verification code" placeholder="123456" onKeyDown={(e) => e.key === "Enter" && verify()} className={`${field} text-center text-lg tracking-widest`} />
            <button onClick={() => setCode("482913")} className="text-xs text-blue-400 hover:text-blue-300">Fill demo code</button>
            {err && <p className="text-xs text-red-400">{err}</p>}
            <button onClick={verify} disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60">{busy && <Loader2 size={15} className="animate-spin" />}Verify</button>
            <button onClick={() => { setStep("cred"); setCode(""); setErr(""); }} className="w-full text-xs text-zinc-500 hover:text-zinc-300">Use a different account</button>
          </>
        )}
      </div>
    </div>
  );
}

function SessionBar({ app, user, onSignOut }) {
  const cfg = APP_AUTH[app];
  const I = cfg.icon;
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm">
      <span className="flex items-center gap-2 text-zinc-300"><I size={15} className="text-blue-400" />{cfg.title} · {user.name}, {user.title}</span>
      <span className="flex items-center gap-3"><span className="hidden text-xs text-zinc-500 md:inline">Access: {cfg.grant}</span><Btn onClick={onSignOut}><LogOut size={12} />Sign out</Btn></span>
    </div>
  );
}

function Gate({ app, children }) {
  const { push } = useAi();
  const [user, setUser] = useState(null);
  if (!user) return <AppLogin app={app} onSignIn={setUser} />;
  return children(user, () => { push(`${APP_AUTH[app].title}: ${user.email} signed out`, "net"); setUser(null); });
}

function Sec({ items }) {
  return <div className="space-y-2.5">{items.map((x) => <div key={x.h}><p className="text-xs text-zinc-500">{x.h}</p><p className="whitespace-pre-line leading-relaxed text-zinc-300">{x.t}</p></div>)}</div>;
}

function AccountView({ pid, sec, setSec, channel, s, setS, user }) {
  const { ai, push, sites, setSites } = useAi();
  const p = PROS[pid];
  const deal = s.deals.find((d) => d.pid === pid);
  const [brief, setBrief] = useState(null);
  const [busy, setBusy] = useState(null);
  const [ch, setCh] = useState(channel || "email");
  const [tone, setTone] = useState("Consultative");
  const [ci, setCi] = useState(0);
  const [draft, setDraft] = useState(null);
  const [slots, setSlots] = useState(null);
  const [prep, setPrep] = useState(null);
  const [pkg, setPkg] = useState(deal?.pkg || { ...p.suggest });
  const [propText, setPropText] = useState(null);
  useEffect(() => { if (channel) setCh(channel); }, [channel]);
  useEffect(() => { setBrief(null); setDraft(null); setSlots(null); setPrep(null); setPropText(null); setPkg(s.deals.find((d) => d.pid === pid)?.pkg || { ...PROS[pid].suggest }); setCi(0); }, [pid]); // eslint-disable-line react-hooks/exhaustive-deps
  const log = (text) => setS((x) => ({ ...x, activity: { ...x.activity, [pid]: [[text, "just now"], ...(x.activity[pid] || [])] } }));
  const setDeal = (patch) => setS((x) => ({ ...x, deals: x.deals.some((d) => d.pid === pid) ? x.deals.map((d) => (d.pid === pid ? { ...d, ...patch } : d)) : [...x.deals, { id: `D-${300 + x.deals.length}`, pid, stage: "Lead", touched: 0, opens: 0, ...patch }] }));
  const stageAt = (st) => !deal || STAGES.indexOf(deal.stage) < STAGES.indexOf(st);
  const pr = price(pkg);
  const meeting = s.meetings.filter((m) => m.pid === pid).sort((a, b) => a.day - b.day || a.start - b.start)[0];
  const ws = salesWeek().ws;
  const c = p.contacts[ci] || p.contacts[0];
  const run = async (key, label, fn, ms = 1200) => { setBusy(key); await ai(label, ms); fn(); setBusy(null); };
  const genDraft = () => run("draft", `Outreach draft for ${p.name}: ${ch}, ${tone.toLowerCase()} tone, grounded in research signals`, () => setDraft(draftOutreach(p, ch, tone, ci, findSlots(p, s.meetings), sites, deal?.stage)), 1000);
  const sendDraft = () => {
    const verb = { email: "Email sent to", call: "Call logged with", voicemail: "Voicemail left for", linkedin: "LinkedIn note sent to" }[ch];
    log(`${verb} ${c.name}: ${draft.subject}`);
    setDeal({ touched: 0, ...(stageAt("Contacted") ? { stage: "Contacted" } : {}) });
    push(`CRM: ${verb.toLowerCase()} ${c.name} (${p.name})`, "ok");
    if (ch === "email") setTimeout(() => { setS((x) => ({ ...x, deals: x.deals.map((d) => (d.pid === pid ? { ...d, opens: (d.opens || 0) + 1 } : d)), activity: { ...x.activity, [pid]: [[`${c.name} opened your email`, "just now"], ...(x.activity[pid] || [])] } })); }, 4000);
    setDraft(null);
  };
  const sequence = () => { log(`AI sequence started for ${c.name}: email today, call in 2 days, follow-up email in 5 days (stops on reply)`); setDeal({ touched: 0, ...(stageAt("Contacted") ? { stage: "Contacted" } : {}) }); push(`CRM: 3-step outreach sequence scheduled for ${c.name}`, "ok"); };
  const book = (sl) => {
    const m = { id: `M-${Date.now()}`, pid, title: `On-site meeting: ${p.name}`, day: sl.day, start: sl.start, dur: sl.dur, where: p.city };
    setS((x) => ({ ...x, meetings: [...x.meetings, m] }));
    setDeal({ touched: 0, ...(stageAt("Meeting set") ? { stage: "Meeting set" } : {}) });
    log(`Meeting booked with ${c.name}: ${dayLabel(ws, sl.day)} at ${fmtHour(sl.start)}, ${p.city}. Invite sent.`);
    push(`Calendar: meeting with ${c.name} booked for ${dayLabel(ws, sl.day)} ${fmtHour(sl.start)}; invite sent`, "ok");
    setSlots(null);
  };
  const genProposal = () => run("prop", `Proposal for ${p.name}: pricing, scope and terms`, () => {
    setPropText(`PROPOSAL: ${p.name}\nPrepared for ${p.contacts[0].name}, ${p.contacts[0].title}, ${p.owner}\n\nScope\n- ${pkg.posts ? `${pkg.posts} ${pkg.armed ? "armed" : "unarmed"} officer post${pkg.posts > 1 ? "s" : ""}, ${lc1(pkg.coverage)} (${pr.hours} hours a week)` : "No fixed post"}${pkg.supervisor ? ", with a field supervisor" : ""}\n${pkg.addons.map((a) => `- ${ADDONS[a].label}`).join("\n")}\n- GPS-verified patrols, AI-audited incident reports and same-night client reporting\n\nWhy it fits\n- ${p.signals.slice(0, 2).join("\n- ")}\n\nInvestment\n${money(pr.monthly)} a month (${money(pr.annual)} a year), ${pkg.term}-month term${pr.disc ? `, ${Math.round(pr.disc * 100)}% multi-year discount included` : ""}.\n\nTransition\n14-day onboarding with no coverage gap. Start date aligned to: ${lc1(p.renew)}.`);
    setDeal({ pkg, touched: 0, ...(stageAt("Proposal") ? { stage: "Proposal" } : {}) });
    log(`Proposal generated: ${money(pr.annual)} a year`);
  }, 1400);
  const sendSign = () => { setDeal({ pkg, stage: "Contract sent", touched: 0, proposal: { status: "sent", day: "today" } }); log(`Contract sent to ${p.contacts[0].name} for e-signature`); push(`E-signature: contract for ${p.name} sent to ${p.contacts[0].name}`, "ok"); };
  const sign = () => {
    const xy = CITY_XY[p.city] || [0, 0];
    const cx = xy[0] * MI * 0.35 + 600, cy = xy[1] * MI * 0.35 + 600;
    const w = /Industrial|Cold|Construction/.test(p.type) ? 260 : 140, h = w * 0.7;
    const siteId = `site-${p.id}`;
    const site = { id: siteId, contact: { name: p.contacts[0].name, title: p.contacts[0].title, email: p.contacts[0].email, phone: p.contacts[0].phone }, name: p.name.replace(/ \(.*\)$/, ""), client: p.owner, risk: p.index >= 7 ? "High" : p.index >= 5 ? "Elevated" : "Moderate", cadence: pkg.coverage === "24/7" ? 45 : 60,
      rules: `${pkg.posts ? `${pkg.posts} ${pkg.armed ? "armed" : "unarmed"} post${pkg.posts > 1 ? "s" : ""}, ${lc1(pkg.coverage)}` : "Mobile patrol only"}${pkg.addons.length ? `, ${pkg.addons.map((a) => ADDONS[a].label.toLowerCase()).join(", ")}` : ""}`, kpi: DEFAULT_KPI,
      pts: [[cx - w, cy - h], [cx + w, cy - h], [cx + w, cy + h], [cx - w, cy + h]] };
    if (p.type !== "Existing client") setSites((l) => (l.some((x) => x.id === siteId) ? l : [...l, site]));
    setDeal({ pkg, stage: "Won", touched: 0, proposal: { status: "signed", day: "today" } });
    setS((x) => ({ ...x, wins: [...x.wins, { pid, value: pr.annual, at: hhmm() }] }));
    log(`Contract signed by ${p.contacts[0].name}. ${p.type === "Existing client" ? "Expansion added to the existing account." : "Handed off to operations: site created for onboarding."}`);
    push(`E-signature complete: ${p.name} signed (${money(pr.annual)} a year). ${p.type === "Existing client" ? "Expansion added to the Titanium account" : "Operations handoff: site created in the dispatcher's Sites map; coverage still needs staffing"}`, "ok");
  };
  const tabs = [["research", "Research", Search], ["outreach", "Outreach", Mail], ["meetings", "Meetings", CalendarDays], ["proposal", "Proposal and contract", FileSignature], ["activity", "Activity", Activity]];
  const sel = "rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200";
  const won = deal?.stage === "Won";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
        <div className="min-w-0"><p className="font-medium text-zinc-100">{p.name}</p><p className="text-xs text-zinc-500">{p.type} · {p.city} · {p.owner} · {p.size}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={p.fit >= 85 ? "g" : p.fit >= 70 ? "b" : "a"}>AI fit {p.fit}</Pill>
          <Pill tone="z">{moneyK(price(deal?.pkg || p.suggest).annual)}/yr</Pill>
          {deal ? (
            <select value={deal.stage} onChange={(e) => { setDeal({ stage: e.target.value }); log(`Stage changed to ${e.target.value}`); }} aria-label="Deal stage" className={sel}>{STAGES.map((st) => <option key={st}>{st}</option>)}</select>
          ) : <Btn tone="g" onClick={() => { setDeal({ stage: "Lead" }); log("Added to pipeline"); }}><Plus size={12} />Add to pipeline</Btn>}
        </div>
      </div>
      <div className="flex gap-1 overflow-x-auto border-b border-zinc-800">
        {tabs.map(([k, l, I]) => <button key={k} onClick={() => setSec(k)} aria-current={sec === k ? "page" : undefined} className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${sec === k ? "border-blue-500 text-white" : "border-transparent text-zinc-400 hover:text-zinc-200"}`}><I size={14} />{l}</button>)}
      </div>
      {sec === "research" && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel title="AI research brief" icon={Sparkles} className="lg:col-span-2" right={brief && <span className="text-xs text-zinc-500">Generated {brief.at}</span>}>
            {!brief ? (
              <div className="space-y-3 text-sm"><p className="text-zinc-500">Pull property records, ownership, decision makers, security signals and timing into one brief, with a recommended package and talking points.</p>
                <AiBtn loading={busy === "brief"} onClick={() => run("brief", `Prospect research for ${p.name}: property records, ownership, contacts, incident data, incumbent and timing`, () => { setBrief({ items: researchBrief(p, sites), at: hhmm() }); log("Research brief generated"); if (stageAt("Researched")) setDeal({ stage: "Researched" }); }, 1600)}>Generate research brief</AiBtn></div>
            ) : (
              <div className="space-y-3 text-sm"><Sec items={brief.items} /><p className="flex items-center gap-1.5 text-xs text-blue-400"><Database size={12} />Demo sources: county property records, commercial listing data, local incident data, company website (all mock)</p></div>
            )}
          </Panel>
          <div className="space-y-4">
            <Panel title="Why this prospect" icon={Target}>
              <ul className="space-y-1.5 text-sm">{fitWhy(p).map((w) => <li key={w} className="flex gap-2 text-zinc-300"><Check size={14} className="mt-0.5 shrink-0 text-emerald-400" />{w}</li>)}</ul>
              <p className="mt-3 text-xs text-zinc-500">Area incident index {p.index}/10</p>
            </Panel>
            <Panel title="Contacts" icon={Users}>
              <ul className="space-y-2 text-sm">{p.contacts.map((x) => <li key={x.email}><p className="text-zinc-200">{x.name}</p><p className="text-xs text-zinc-500">{x.title}<br />{x.email} · {x.phone}<br />{x.pref}</p></li>)}</ul>
            </Panel>
          </div>
        </div>
      )}
      {sec === "outreach" && (
        <Panel title="AI outreach" icon={Mail}>
          <div className="flex flex-wrap items-end gap-2 text-sm">
            <div className="flex rounded-md border border-zinc-700 p-0.5">{[["email", "Email"], ["call", "Call script"], ["voicemail", "Voicemail"], ["linkedin", "LinkedIn"]].map(([k, l]) => <button key={k} onClick={() => { setCh(k); setDraft(null); }} aria-pressed={ch === k} className={`rounded px-2.5 py-1 text-xs ${ch === k ? "bg-zinc-800 text-white" : "text-zinc-400"}`}>{l}</button>)}</div>
            <select value={ci} onChange={(e) => { setCi(+e.target.value); setDraft(null); }} aria-label="Contact" className={sel}>{p.contacts.map((x, i) => <option key={x.email} value={i}>{x.name}, {x.title}</option>)}</select>
            <select value={tone} onChange={(e) => setTone(e.target.value)} aria-label="Tone" className={sel}>{["Consultative", "Direct", "Friendly"].map((x) => <option key={x}>{x}</option>)}</select>
            <AiBtn loading={busy === "draft"} onClick={genDraft}>{draft ? "Rewrite" : "Write with AI"}</AiBtn>
          </div>
          {!draft && <p className="mt-3 text-sm text-zinc-500">The draft uses this prospect's research signals, your proof points and open times on your calendar.</p>}
          {draft && (
            <div className="mt-3 grid gap-4 lg:grid-cols-3">
              <div className="space-y-2 lg:col-span-2">
                <input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} aria-label="Subject" className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none" />
                <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={13} aria-label="Message" className="w-full resize-y rounded-md border border-blue-500/20 bg-blue-500/5 p-3 text-sm leading-relaxed text-zinc-200 focus:border-blue-500 focus:outline-none" />
              </div>
              <div className="space-y-3 text-sm">
                <p className="text-xs text-zinc-500">Compliance check</p>
                <ul className="space-y-1.5">{outreachChecks(ch, draft.body, p, c).map(([okk, l]) => <li key={l} className={`flex gap-2 ${okk ? "text-zinc-300" : "text-amber-300"}`}>{okk ? <Check size={14} className="mt-0.5 shrink-0 text-emerald-400" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0" />}{l}</li>)}</ul>
                <Btn tone="g" onClick={sendDraft} className="w-full py-2"><Send size={12} />{ch === "email" ? `Send to ${c.name}` : ch === "linkedin" ? "Mark as sent" : "Log call"}</Btn>
                {ch === "email" && <Btn onClick={sequence} className="w-full py-2"><Sparkles size={12} />Start 3-step AI sequence</Btn>}
              </div>
            </div>
          )}
        </Panel>
      )}
      {sec === "meetings" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Book a meeting" icon={CalendarDays}>
            {meeting && <p className="mb-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 text-sm text-emerald-300">Booked: {dayLabel(ws, meeting.day)} at {fmtHour(meeting.start)}, {meeting.where}.</p>}
            <AiBtn loading={busy === "slots"} onClick={() => run("slots", `Appointment finder: your calendar, drive times from ${p.city} and ${p.contacts[0].name}'s preferences`, () => setSlots(findSlots(p, s.meetings)), 1000)}>{slots ? "Find other times" : "Find best times with AI"}</AiBtn>
            {slots && (slots.length === 0 ? <p className="mt-3 text-sm text-amber-300">No open time fits this week once drive time is counted. Offer next week.</p> : (
              <ul className="mt-3 space-y-2">{slots.map((sl) => (
                <li key={`${sl.day}-${sl.start}`} className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 p-2.5 text-sm">
                  <span className="min-w-0 flex-1"><span className="block text-zinc-100">{dayLabel(ws, sl.day)}, {fmtHour(sl.start)}–{fmtHour(sl.start + sl.dur)}</span><span className="block text-xs text-zinc-500">{sl.why.join(" · ")}</span></span>
                  <Btn tone="g" onClick={() => book(sl)}>Book and send invite</Btn>
                </li>))}</ul>
            ))}
          </Panel>
          <Panel title="Meeting prep brief" icon={ClipboardList}>
            {!prep ? <><p className="mb-3 text-sm text-zinc-500">Goal, agenda, questions, proof points and price range for this meeting.</p><AiBtn loading={busy === "prep"} onClick={() => run("prep", `Meeting prep for ${p.name}`, () => setPrep(prepBrief(p, meeting, sites)), 1100)}>Write prep brief</AiBtn></> : <div className="text-sm"><Sec items={prep} /></div>}
          </Panel>
        </div>
      )}
      {sec === "proposal" && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel title="Package and pricing" icon={DollarSign}>
            <div className="space-y-3 text-sm">
              <p className="flex items-center gap-1.5 text-xs text-blue-300"><Sparkles size={12} />Pre-filled from the AI's recommendation</p>
              <label className="block text-xs text-zinc-500">Officer posts<input type="number" min={0} max={6} value={pkg.posts} disabled={won} onChange={(e) => setPkg({ ...pkg, posts: Math.max(0, Math.min(6, +e.target.value || 0)) })} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-zinc-100" /></label>
              <label className="block text-xs text-zinc-500">Coverage<select value={pkg.coverage} disabled={won} onChange={(e) => setPkg({ ...pkg, coverage: e.target.value })} className={`${sel} mt-1 w-full`}>{Object.keys(COVER).map((k) => <option key={k}>{k}</option>)}</select></label>
              <label className="flex items-center gap-2 text-zinc-300"><input type="checkbox" checked={pkg.armed} disabled={won} onChange={(e) => setPkg({ ...pkg, armed: e.target.checked })} />Armed officers</label>
              <label className="flex items-center gap-2 text-zinc-300"><input type="checkbox" checked={pkg.supervisor} disabled={won} onChange={(e) => setPkg({ ...pkg, supervisor: e.target.checked })} />Field supervisor (+5%)</label>
              {Object.entries(ADDONS).map(([k, a]) => <label key={k} className="flex items-center gap-2 text-zinc-300"><input type="checkbox" checked={pkg.addons.includes(k)} disabled={won} onChange={(e) => setPkg({ ...pkg, addons: e.target.checked ? [...pkg.addons, k] : pkg.addons.filter((x) => x !== k) })} />{a.label}{a.mo ? ` (${money(a.mo)}/mo)` : " (included)"}</label>)}
              <label className="block text-xs text-zinc-500">Term<select value={pkg.term} disabled={won} onChange={(e) => setPkg({ ...pkg, term: +e.target.value })} className={`${sel} mt-1 w-full`}>{[12, 24, 36].map((t) => <option key={t} value={t}>{t} months</option>)}</select></label>
              <div className="rounded-md bg-zinc-950 p-3">
                <p className="text-2xl font-semibold tabular-nums text-zinc-100">{money(pr.monthly)}<span className="text-sm font-normal text-zinc-500"> /month</span></p>
                <p className="text-xs text-zinc-500">{money(pr.annual)} a year · {pr.hours} h/week at ${pr.rate.toFixed(2)}/h{pr.disc ? ` · ${Math.round(pr.disc * 100)}% term discount` : ""}</p>
              </div>
            </div>
          </Panel>
          <Panel title="Proposal and e-signature" icon={FileSignature} className="lg:col-span-2" right={deal?.proposal && <Pill tone={deal.proposal.status === "signed" ? "g" : "b"}>{deal.proposal.status === "signed" ? "Signed" : `Sent ${deal.proposal.day}`}</Pill>}>
            <div className="space-y-3 text-sm">
              {!won && <AiBtn loading={busy === "prop"} onClick={genProposal}>{propText ? "Regenerate proposal" : "Generate proposal"}</AiBtn>}
              {propText && <textarea value={propText} onChange={(e) => setPropText(e.target.value)} disabled={won} rows={14} aria-label="Proposal" className="w-full resize-y rounded-md border border-blue-500/20 bg-blue-500/5 p-3 text-sm leading-relaxed text-zinc-200 focus:border-blue-500 focus:outline-none" />}
              <ol className="flex flex-wrap gap-2 text-xs">{["Proposal", "Sent for signature", "Signed", "Handed to operations"].map((st, i) => { const lvl = won ? 4 : deal?.stage === "Contract sent" ? 2 : propText || deal?.stage === "Proposal" ? 1 : 0; return <li key={st}><Pill tone={i < lvl ? "g" : "z"}>{i < lvl && <Check size={10} />}{st}</Pill></li>; })}</ol>
              <div className="flex flex-wrap gap-2">
                {!won && deal?.stage !== "Contract sent" && <Btn tone="g" disabled={!propText} onClick={sendSign}><Send size={12} />Send for e-signature</Btn>}
                {!won && deal?.stage === "Contract sent" && <><Btn onClick={() => { log(`Reminder sent to ${p.contacts[0].name} to sign`); push(`E-signature reminder sent to ${p.contacts[0].name}`, "ok"); }}>Send reminder</Btn><Btn tone="g" onClick={sign}><FileSignature size={12} />Demo: simulate client signing</Btn></>}
              </div>
              {!propText && deal?.stage === "Contract sent" && <p className="text-xs text-zinc-500">The contract is with {p.contacts[0].name}. Signing is simulated in this demo.</p>}
              {won && <p className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-emerald-300"><Handshake size={14} className="mr-1.5 inline" />Signed. {p.type === "Existing client" ? "The expansion was added to the Titanium account." : `${p.name.replace(/ \(.*\)$/, "")} now appears in the dispatcher's Sites map and in Scheduling as a site that still needs coverage, so operations can start onboarding.`}</p>}
            </div>
          </Panel>
        </div>
      )}
      {sec === "activity" && (
        <Panel title="Activity" icon={Activity}>
          <ul className="space-y-2 text-sm">{(s.activity[pid] || []).map(([t, w], i) => <li key={i} className="flex justify-between gap-3 border-b border-zinc-800 pb-2 last:border-0"><span className="text-zinc-300">{t}</span><span className="shrink-0 text-xs text-zinc-500">{w}</span></li>)}{!(s.activity[pid] || []).length && <li className="text-zinc-500">No activity yet.</li>}</ul>
        </Panel>
      )}
    </div>
  );
}

function SalesCopilot({ open, onClose, s, openAcct }) {
  const { ai, sites } = useAi();
  const [msgs, setMsgs] = useState([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  useEffect(() => { if (open) setTimeout(() => ref.current?.focus(), 30); }, [open]);
  useEffect(() => { if (!open) return; const h = (e) => e.key === "Escape" && onClose(); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [open, onClose]);
  if (!open) return null;
  const ask = async (text) => {
    const t = (text ?? q).trim(); if (!t || busy) return;
    setQ(""); setBusy(true); setMsgs((m) => [...m, { r: "me", t }]);
    await ai("Sales AI: CRM pipeline, prospect index and calendar", 900);
    setMsgs((m) => [...m, { r: "ai", ...salesCopilot(t, s, sites) }]); setBusy(false);
  };
  const SUG = ["Who should I call today?", "Which deals are stalled?", "Prep me for my next meeting", "Find cold storage and industrial prospects", "What's my pipeline forecast?", "Draft a follow-up for Lakeview"];
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-20 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Sales AI" style={{ maxHeight: "75vh" }} className="flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <Sparkles size={16} className="text-blue-400" />
          <input ref={ref} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask()} placeholder="Ask about prospects, deals and meetings…" aria-label="Ask the Sales AI" className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none" />
          {busy && <Loader2 size={15} className="animate-spin text-zinc-500" />}
          <button onClick={onClose} aria-label="Close" className="rounded p-1 text-zinc-500 hover:bg-zinc-800"><X size={16} /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-sm">
          {!msgs.length && <div className="flex flex-wrap gap-1.5">{SUG.map((x) => <button key={x} onClick={() => ask(x)} className="rounded-full border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-blue-500/50 hover:text-blue-300">{x}</button>)}</div>}
          {msgs.map((m, i) => m.r === "me" ? <div key={i} className="flex justify-end"><p style={{ maxWidth: "85%" }} className="rounded-lg bg-zinc-800 px-3 py-2 text-zinc-100">{m.t}</p></div> : (
            <div key={i} className="space-y-2 rounded-lg border border-blue-500/20 bg-blue-500/5 p-3">
              <p className="whitespace-pre-line leading-relaxed text-zinc-200">{m.text}</p>
              {m.items?.length > 0 && <ul className="space-y-1.5">{m.items.map((it, j) => <li key={j} className="flex items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-2"><span className="min-w-0"><span className="block truncate text-zinc-200">{it.label}</span>{it.sub && <span className="block text-xs text-zinc-500">{it.sub}</span>}</span>{it.pid && <Btn onClick={() => { openAcct(it.pid, it.sec, it.channel); onClose(); }}>Open</Btn>}</li>)}</ul>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SalesApp({ active }) {
  const { ai, push } = useAi();
  const [user, setUser] = useState(null);
  const [s, setS] = useState(INIT_SALES);
  const [tab, setTabRaw] = useState("today");
  const [acct, setAcct] = useState({ pid: "meridian", sec: "research", channel: null, n: 0 });
  const [cp, setCp] = useState(false);
  const [q, setQ] = useState("");
  const [ftype, setFtype] = useState("all");
  const [results, setResults] = useState(() => searchProspects("", {}));
  const [sBusy, setSBusy] = useState(false);
  const closeCp = useCallback(() => setCp(false), []);
  const setTab = (t) => { setTabRaw(t); window.scrollTo(0, 0); };
  const openAcct = (pid, sec = "research", channel = null) => { setAcct({ pid, sec, channel, n: Date.now() }); setTab("account"); };
  useEffect(() => { if (!active) setCp(false); }, [active]);
  if (!user) return <AppLogin app="sales" onSignIn={setUser} />;
  const { ws, t, next: nextWeek } = salesWeek();
  const open = s.deals.filter((d) => d.stage !== "Won");
  const val = (d) => price(d.pkg || PROS[d.pid].suggest).annual;
  const total = open.reduce((n, d) => n + val(d), 0), weighted = open.reduce((n, d) => n + val(d) * STAGE_P[d.stage], 0);
  const wonVal = s.deals.filter((d) => d.stage === "Won").reduce((n, d) => n + val(d), 0);
  const acts = nextActions(s);
  const meetingsWeek = s.meetings.filter((m) => m.pid).length;
  const doSearch = async (text) => { const qq = text ?? q; setQ(qq); setSBusy(true); await ai(`Prospect search: "${qq || "all"}" across property records, listings and incident data`, 1100); setResults(searchProspects(qq, { type: ftype })); setSBusy(false); };
  const moveDeal = (d, dir) => { const i = STAGES.indexOf(d.stage) + dir; if (i < 0 || i >= STAGES.length - 1) return; setS((x) => ({ ...x, deals: x.deals.map((y) => (y.id === d.id ? { ...y, stage: STAGES[i], touched: 0 } : y)), activity: { ...x.activity, [d.pid]: [[`Stage changed to ${STAGES[i]}`, "just now"], ...(x.activity[d.pid] || [])] } })); };
  const tabs = [["today", "Today", LayoutDashboard], ["find", "Prospect finder", Target], ["pipeline", "Pipeline", Kanban], ["account", "Account", Building2], ["calendar", "Calendar", CalendarDays]];
  const types = [...new Set(PROSPECTS.filter((p) => p.type !== "Existing client").map((p) => p.type))];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm">
        <span className="flex items-center gap-2 text-zinc-300"><Briefcase size={15} className="text-blue-400" />Sales workspace · {user.name}, {user.title}</span>
        <span className="flex items-center gap-3"><span className="hidden text-xs text-zinc-500 md:inline">Role-limited: no access to officer locations or incident reports</span><Btn onClick={() => { setUser(null); push(`Sales user ${user.email} signed out`, "net"); }}><LogOut size={12} />Sign out</Btn></span>
      </div>
      <div className="flex flex-col gap-5 md:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto md:w-52 md:flex-col" aria-label="Sales sections">
          <button onClick={() => setCp(true)} className="mb-2 flex shrink-0 items-center gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-sm text-blue-200 hover:bg-blue-500/20"><Sparkles size={15} />Ask Sales AI</button>
          {tabs.map(([k, l, I]) => <button key={k} onClick={() => setTab(k)} aria-current={tab === k ? "page" : undefined} className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm ${tab === k ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-900"}`}><I size={15} />{l}{k === "today" && acts.length ? <span className="ml-auto rounded-full bg-blue-500/20 px-1.5 text-xs text-blue-300">{acts.length}</span> : null}</button>)}
        </nav>
        <div className="min-w-0 flex-1 space-y-4">
          {tab === "today" && (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label="Open pipeline" value={moneyK(total)} tone="b" sub={`${open.length} deals`} />
                <Stat label="Weighted forecast" value={moneyK(weighted)} tone="a" sub="By stage probability" />
                <Stat label={nextWeek ? "Customer meetings next week" : "Customer meetings this week"} value={meetingsWeek} tone="g" sub={`${s.meetings.filter((m) => m.pid && m.day >= t).length} still ahead`} />
                <Stat label="Won this session" value={moneyK(wonVal)} tone="g" sub={`${s.deals.filter((d) => d.stage === "Won").length} signed`} />
              </div>
              <div className="grid gap-4 lg:grid-cols-3">
                <Panel title="AI next best actions" icon={Sparkles} className="lg:col-span-2">
                  <ul className="space-y-2">{acts.map((a, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-800 px-3 py-2.5 text-sm">
                      <span className="min-w-0 flex-1"><span className="block font-medium text-zinc-100">{PROS[a.pid].name}</span><span className="block text-zinc-400">{a.text}</span></span>
                      <Btn tone={i < 2 ? "g" : "z"} onClick={() => openAcct(a.pid, a.sec, a.channel)}>{a.cta}</Btn>
                    </li>))}{!acts.length && <li className="text-sm text-zinc-500">You're caught up.</li>}</ul>
                </Panel>
                <Panel title={nextWeek ? "Monday's schedule" : "Today's schedule"} icon={CalendarDays}>
                  <ul className="space-y-2 text-sm">{s.meetings.filter((m) => m.day === t).sort((a, b) => a.start - b.start).map((m) => <li key={m.id} className="rounded-md border border-zinc-800 p-2"><p className="text-zinc-200">{fmtHour(m.start)} · {m.title}</p><p className="text-xs text-zinc-500">{m.where}</p></li>)}{!s.meetings.some((m) => m.day === t) && <li className="text-zinc-500">Nothing booked {nextWeek ? "Monday" : "today"}.</li>}</ul>
                </Panel>
              </div>
            </>
          )}
          {tab === "find" && (
            <>
              <Panel title="AI prospect finder" icon={Target}>
                <div className="flex flex-wrap gap-2">
                  <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && doSearch()} placeholder="Describe who you're looking for, e.g. warehouses in Irving with theft problems" aria-label="Describe prospects" className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none" style={{ minWidth: 220 }} />
                  <select value={ftype} onChange={(e) => setFtype(e.target.value)} aria-label="Property type" className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-zinc-200"><option value="all">All property types</option>{types.map((x) => <option key={x}>{x}</option>)}</select>
                  <AiBtn loading={sBusy} onClick={() => doSearch()}>Search</AiBtn>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">{["Industrial and logistics with theft problems", "Properties that need 24/7 coverage", "Medical and pharma", "Multifamily in Arlington", "Construction sites"].map((x) => <button key={x} onClick={() => doSearch(x)} className="rounded-full border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 hover:border-blue-500/50 hover:text-blue-300">{x}</button>)}</div>
              </Panel>
              {results && (results.length === 0 ? <p className="text-sm text-zinc-500">No prospects match. Try a broader description or another property type.</p> : (
                <div className="grid gap-3 md:grid-cols-2">{results.map((p) => { const inPipe = s.deals.find((d) => d.pid === p.id); return (
                  <div key={p.id} className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-sm">
                    <div className="flex items-start justify-between gap-2"><div><p className="font-medium text-zinc-100">{p.name}</p><p className="text-xs text-zinc-500">{p.type} · {p.city} · {p.size}</p></div><Pill tone={p.fit >= 85 ? "g" : p.fit >= 70 ? "b" : "a"}>Fit {p.fit}</Pill></div>
                    <ul className="space-y-0.5 text-xs text-zinc-400">{p.signals.slice(0, 2).map((x) => <li key={x}>- {x}</li>)}</ul>
                    <p className="flex flex-wrap gap-1">{fitWhy(p).map((w) => <Pill key={w} tone="z">{w}</Pill>)}</p>
                    <div className="flex items-center justify-between gap-2"><span className="text-xs text-zinc-500">Est. {moneyK(price(p.suggest).annual)}/yr</span>
                      <span className="flex gap-2">{inPipe ? <Pill tone="b">{inPipe.stage}</Pill> : <Btn tone="g" onClick={() => setS((x) => ({ ...x, deals: [...x.deals, { id: `D-${300 + x.deals.length}`, pid: p.id, stage: "Lead", touched: 0, opens: 0 }], activity: { ...x.activity, [p.id]: [["Added to pipeline from prospect finder", "just now"]] } }))}><Plus size={12} />Add to pipeline</Btn>}<Btn onClick={() => openAcct(p.id, "research")}>Research</Btn></span></div>
                  </div>); })}</div>
              ))}
            </>
          )}
          {tab === "pipeline" && (
            <div className="space-y-2">
              <p className="text-sm text-zinc-400">{open.length} open deals · {moneyK(total)} pipeline · {moneyK(weighted)} weighted</p>
              <div className="flex gap-3 overflow-x-auto pb-2">{STAGES.map((st) => { const ds = s.deals.filter((d) => d.stage === st); return (
                <div key={st} className="w-56 shrink-0 space-y-2 rounded-lg border border-zinc-800 bg-zinc-900 p-2.5">
                  <div className="flex items-center justify-between px-1 text-xs"><span className="font-medium text-zinc-300">{st}</span><span className="text-zinc-500">{ds.length} · {moneyK(ds.reduce((n, d) => n + val(d), 0))}</span></div>
                  {ds.map((d) => { const p = PROS[d.pid]; return (
                    <div key={d.id} className="space-y-1.5 rounded-md border border-zinc-700 bg-zinc-950 p-2 text-xs">
                      <button onClick={() => openAcct(p.id, st === "Won" ? "activity" : "research")} className="block text-left text-sm text-zinc-100 hover:text-blue-300">{p.name}</button>
                      <p className="text-zinc-500">{moneyK(val(d))}/yr · {d.touched ? `touched ${d.touched} d ago` : "touched today"}</p>
                      {d.touched >= 5 && st !== "Won" && <Pill tone="a">Stalled</Pill>}
                      {st !== "Won" && <div className="flex justify-between"><button onClick={() => moveDeal(d, -1)} disabled={st === "Lead"} aria-label={`Move ${p.name} back`} className="rounded border border-zinc-700 px-1.5 text-zinc-400 hover:text-zinc-200 disabled:opacity-30"><ChevronUp size={12} className="-rotate-90" /></button><button onClick={() => moveDeal(d, 1)} disabled={st === "Contract sent"} aria-label={`Move ${p.name} forward`} className="rounded border border-zinc-700 px-1.5 text-zinc-400 hover:text-zinc-200 disabled:opacity-30"><ChevronDown size={12} className="-rotate-90" /></button></div>}
                    </div>); })}
                  {!ds.length && <p className="px-1 text-xs text-zinc-600">Empty</p>}
                </div>); })}</div>
              <p className="text-xs text-zinc-500">Deals move to Won only through a signed contract on the account's Proposal tab.</p>
            </div>
          )}
          {tab === "account" && (
            <>
              <select value={acct.pid} onChange={(e) => setAcct({ pid: e.target.value, sec: "research", channel: null, n: Date.now() })} aria-label="Account" className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200">
                {PROSPECTS.map((p) => { const d = s.deals.find((x) => x.pid === p.id); return <option key={p.id} value={p.id}>{p.name}{d ? ` (${d.stage})` : " (not in pipeline)"}</option>; })}
              </select>
              <AccountView key={acct.pid} pid={acct.pid} sec={acct.sec} channel={acct.channel} setSec={(sec) => setAcct((a) => ({ ...a, sec }))} s={s} setS={setS} user={user} />
            </>
          )}
          {tab === "calendar" && (
            <Panel title={`${nextWeek ? "Next week" : "Your week"} · ${fmtDate(ws)} – ${fmtDate(ws + 4 * DAY_MS)}`} icon={CalendarDays} bodyClass="overflow-x-auto">
              <div style={{ minWidth: 640 }} className="grid grid-cols-6 text-xs">
                <div />
                {DAYS.slice(0, 5).map((d, i) => <div key={d} className={`pb-2 text-center ${!nextWeek && i === t ? "text-blue-300" : i < t ? "text-zinc-600" : "text-zinc-400"}`}>{dayLabel(ws, i)}{!nextWeek && i === t ? " · today" : ""}</div>)}
                <div className="relative" style={{ height: 10 * 44 }}>{Array.from({ length: 10 }, (_, h) => <div key={h} className="absolute right-2 text-zinc-600" style={{ top: h * 44 - 6 }}>{fmtHour(8 + h)}</div>)}</div>
                {DAYS.slice(0, 5).map((d, i) => (
                  <div key={d} className={`relative border-l border-zinc-800 ${i < t ? "opacity-50" : ""}`} style={{ height: 10 * 44 }}>
                    {Array.from({ length: 10 }, (_, h) => <div key={h} className="absolute inset-x-0 border-t border-zinc-800/60" style={{ top: h * 44 }} />)}
                    {s.meetings.filter((m) => m.day === i).map((m) => (
                      <button key={m.id} onClick={() => m.pid && openAcct(m.pid, "meetings")} title={`${m.title} · ${m.where}`} className={`absolute inset-x-1 overflow-hidden rounded border px-1.5 py-1 text-left ${m.pid ? "border-blue-500/40 bg-blue-500/15 text-blue-100 hover:border-blue-400" : "border-zinc-700 bg-zinc-800 text-zinc-300"}`} style={{ top: (m.start - 8) * 44 + 1, height: m.dur * 44 - 2 }}>
                        <span className="block truncate font-medium">{m.title}</span><span className="block truncate text-zinc-400">{fmtHour(m.start)} · {m.where}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-zinc-500">Customer meetings are blue. Book new ones from an account's Meetings tab: the AI fits them around drive time.</p>
            </Panel>
          )}
        </div>
      </div>
      <SalesCopilot open={cp} onClose={closeCp} s={s} openAcct={openAcct} />
    </div>
  );
}

