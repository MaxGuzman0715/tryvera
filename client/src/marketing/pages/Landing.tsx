import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { appHref, isMarketingHost } from "../../domains";
import "./Landing.css";

/**
 * Public marketing landing for TealBridge LLC — a US staffing firm based
 * in Texas and California. Two specialties: technology talent (engineers)
 * and customer-operations talent (sales, customer success, support).
 *
 * For US companies: vetted engineering hires and remote customer-facing
 * teams without burning months of recruiting cycles.
 *
 * For candidates: a direct line into US roles with prep and coaching
 * baked in so the first onsite isn't the rehearsal.
 *
 * Architecture note: the React Landing is rendered at `/` only on the
 * marketing host (`tealbridge.online`); on the app subdomain
 * (`app.tealbridge.online`) the same React app sends visitors straight
 * to `/login`. See `App.tsx` and `src/domains.ts`.
 */

const ASSET = {
  // Decorative phone-shape device mockups used in the hero. Not avatars or
  // real screenshots — kept because they read as "modern product surface"
  // without naming any brand. Replace with Tryvera-owned imagery when
  // available.
  heroPhone: "/disciple/aYFrsJhbI2Q1AN6kULPHhYl3aM.png",
  heroPhone2: "/disciple/7ywhlXuRAFjuJPZXGtKVzNlWsI.png",
};

/**
 * Cross-domain-aware login CTA. On the marketing host (`tealbridge.online`)
 * we cross to `app.tealbridge.online/login` with a real anchor; on dev /
 * app hosts we keep React Router's `<Link>` so navigation stays SPA-fast.
 */
function LoginCta({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  if (isMarketingHost()) {
    return (
      <a href={appHref("/login")} className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link to="/login" className={className}>
      {children}
    </Link>
  );
}

type TabId = "engineering" | "success" | "sales" | "ops";

type Tab = {
  id: TabId;
  label: string;
  heading: string;
  body: string;
  bullets: string[];
};

const TABS: Tab[] = [
  {
    id: "engineering",
    label: "Engineering",
    heading: "Engineering placements that fit your stack.",
    body:
      "Backend, frontend, full-stack, ML, platform, and DevOps. Mid-career to staff. We screen for the work, not just the resume — every introduction comes pre-vetted on the technical bar your team actually hires at.",
    bullets: [
      "Backend & full-stack: Node, Python, Go, Java, Ruby",
      "ML & platform: model serving, MLOps, infra, data plumbing",
      "Frontend & mobile: React, TypeScript, native iOS / Android",
    ],
  },
  {
    id: "success",
    label: "Customer Success",
    heading: "Customer-success teams that hit retention numbers.",
    body:
      "From front-line CSMs to onboarding leads to retention managers — we place the people who keep your accounts paying. Most placements are remote, US-based, with experience at SaaS companies in your stage.",
    bullets: [
      "Customer Success Managers — SMB through enterprise",
      "Onboarding leads & implementation specialists",
      "Renewals managers and retention analysts",
    ],
  },
  {
    id: "sales",
    label: "Sales",
    heading: "Sales hires from BDR to GTM lead.",
    body:
      "Inside sales, account executives, sales engineers, and senior GTM roles. We screen for tenure-credible reps with quota attainment that holds up to a reference call — not just a polished LinkedIn.",
    bullets: [
      "BDRs & SDRs — pipeline-builder bench",
      "Account Executives — SMB, mid-market, enterprise",
      "Sales engineers & GTM leads",
    ],
  },
  {
    id: "ops",
    label: "Operations & Support",
    heading: "Operations and support backbone for growing teams.",
    body:
      "RevOps, BizOps, support engineers, and the kind of operations talent that quietly makes the rest of the company faster. Remote-first, US-based, oriented to the systems your team already runs.",
    bullets: [
      "RevOps & BizOps analysts and leads",
      "Customer-support engineers and team leads",
      "Compliance, finance ops, and people ops",
    ],
  },
];

/**
 * CSS-only phone mockup (fixed-size frame + a notch + an interior that
 * varies per tab). Replaces image-based mockups so the multi-tab stage
 * doesn't reflow when you switch tabs and the on-screen content is real
 * Tryvera copy keyed to each talent specialty.
 */
function PhoneMockup({ tabId }: { tabId: TabId }) {
  const StatusBar = (
    <div className="tb-phone-status">
      <span>9:41</span>
      <span aria-hidden="true">●●●</span>
    </div>
  );
  const TabBar = (
    <div className="tb-phone-tabbar" aria-hidden="true">
      <span className="is-active" />
      <span />
      <span />
      <span />
      <span />
    </div>
  );
  const Brand = (
    <div className="tb-phone-brandbar">
      <span className="tb-brand-mark" aria-hidden="true" />
      <strong>Tryvera</strong>
    </div>
  );

  if (tabId === "engineering") {
    return (
      <div className="tb-phone" key={tabId}>
        <div className="tb-phone-screen">
          {StatusBar}
          <div className="tb-phone-body">
            {Brand}
            <p className="tb-phone-eyebrow">Open engineering roles</p>
            <div className="tb-phone-card tb-phone-card--teal">
              <span className="tb-phone-card-title">Senior Backend Engineer</span>
              <span className="tb-phone-card-meta">Series B SaaS · remote · $180k–$220k</span>
            </div>
            <div className="tb-phone-card tb-phone-card--coral">
              <span className="tb-phone-card-title">ML Platform Engineer</span>
              <span className="tb-phone-card-meta">AI startup · Bay Area / remote</span>
            </div>
            <div className="tb-phone-card tb-phone-card--amber">
              <span className="tb-phone-card-title">DevOps / SRE</span>
              <span className="tb-phone-card-meta">Fintech · contract-to-hire</span>
            </div>
            <div className="tb-phone-row" style={{ marginTop: "8px" }}>
              <span className="tb-phone-pill">Direct hire</span>
              <span className="tb-phone-pill tb-phone-pill--coral">Contract</span>
              <span className="tb-phone-pill tb-phone-pill--amber">C2H</span>
            </div>
          </div>
          {TabBar}
        </div>
      </div>
    );
  }

  if (tabId === "success") {
    return (
      <div className="tb-phone" key={tabId}>
        <div className="tb-phone-screen">
          {StatusBar}
          <div className="tb-phone-body">
            {Brand}
            <p className="tb-phone-eyebrow">Customer success bench</p>
            <div className="tb-phone-card tb-phone-card--teal">
              <span className="tb-phone-card-title">Senior CSM (Enterprise)</span>
              <span className="tb-phone-card-meta">SaaS · remote · 7+ yrs</span>
            </div>
            <div className="tb-phone-card tb-phone-card--mint">
              <span className="tb-phone-card-title">Onboarding Lead</span>
              <span className="tb-phone-card-meta">Vertical SaaS · remote</span>
            </div>
            <div className="tb-phone-card tb-phone-card--coral">
              <span className="tb-phone-card-title">Renewals Manager</span>
              <span className="tb-phone-card-meta">Mid-market · CST</span>
            </div>
            <div className="tb-phone-row" style={{ marginTop: "8px" }}>
              <span className="tb-phone-pill">SMB</span>
              <span className="tb-phone-pill tb-phone-pill--coral">Mid-market</span>
              <span className="tb-phone-pill tb-phone-pill--amber">Enterprise</span>
            </div>
          </div>
          {TabBar}
        </div>
      </div>
    );
  }

  if (tabId === "sales") {
    return (
      <div className="tb-phone" key={tabId}>
        <div className="tb-phone-screen">
          {StatusBar}
          <div className="tb-phone-body">
            {Brand}
            <p className="tb-phone-eyebrow">Sales hiring</p>
            <div className="tb-phone-card tb-phone-card--teal">
              <span className="tb-phone-card-title">Account Executive — Mid-market</span>
              <span className="tb-phone-card-meta">SaaS · 110% quota · remote</span>
            </div>
            <div className="tb-phone-card tb-phone-card--coral">
              <span className="tb-phone-card-title">BDR / SDR</span>
              <span className="tb-phone-card-meta">Pipeline-builder bench · US-wide</span>
            </div>
            <div className="tb-phone-card tb-phone-card--amber">
              <span className="tb-phone-card-title">Sales Engineer</span>
              <span className="tb-phone-card-meta">Technical AE · contract-to-hire</span>
            </div>
            <div className="tb-phone-row" style={{ marginTop: "8px" }}>
              <span className="tb-phone-pill">Inside</span>
              <span className="tb-phone-pill tb-phone-pill--coral">AE</span>
              <span className="tb-phone-pill tb-phone-pill--amber">GTM lead</span>
            </div>
          </div>
          {TabBar}
        </div>
      </div>
    );
  }

  // ops
  return (
    <div className="tb-phone" key={tabId}>
      <div className="tb-phone-screen">
        {StatusBar}
        <div className="tb-phone-body">
          {Brand}
          <p className="tb-phone-eyebrow">Operations &amp; support</p>
          <div className="tb-phone-card tb-phone-card--teal">
            <span className="tb-phone-card-title">RevOps Lead</span>
            <span className="tb-phone-card-meta">Salesforce · HubSpot · remote</span>
          </div>
          <div className="tb-phone-card tb-phone-card--mint">
            <span className="tb-phone-card-title">Senior Support Engineer</span>
            <span className="tb-phone-card-meta">B2B SaaS · 24/5 coverage</span>
          </div>
          <div className="tb-phone-card tb-phone-card--coral">
            <span className="tb-phone-card-title">BizOps Analyst</span>
            <span className="tb-phone-card-meta">Series A · remote · CT/EST</span>
          </div>
          <div className="tb-phone-row" style={{ marginTop: "8px" }}>
            <span className="tb-phone-pill">RevOps</span>
            <span className="tb-phone-pill tb-phone-pill--coral">Support</span>
            <span className="tb-phone-pill tb-phone-pill--amber">Compliance</span>
          </div>
        </div>
        {TabBar}
      </div>
    </div>
  );
}

const PILLARS: Array<{
  num: string;
  title: string;
  body: string;
  badge?: string;
}> = [
  {
    num: "01",
    title: "Engineering Talent",
    body: "Backend, frontend, full-stack, ML, platform, DevOps. Mid-career through staff. Pre-vetted against your stack and your interview bar before any introduction.",
    badge: "Specialty",
  },
  {
    num: "02",
    title: "Customer-Operations Talent",
    body: "Sales, customer success, support, RevOps. Remote-first US-based candidates with experience at companies in your stage and price point.",
    badge: "Specialty",
  },
  {
    num: "03",
    title: "Vetted Shortlists in Days",
    body: "Brief in, three to five vetted candidates back inside a week. We screen — you decide. No resume firehose, no time-wasting first-rounds.",
  },
  {
    num: "04",
    title: "Direct hire, Contract, or Contract-to-hire",
    body: "Whatever the role calls for. Direct hire for permanent seats, contract for project work, contract-to-hire when you want a try-before-you-buy.",
  },
  {
    num: "05",
    title: "Candidate Coaching & Prep",
    body: "Free interview prep, resume reviews, and role-fit guidance for every candidate in our pool. By the time they're in front of you, they've already practiced.",
  },
  {
    num: "06",
    title: "US-Native Operations",
    body: "Texas and California offices. We know how US companies hire, pay, and onboard — W-2, 1099, equity bands, state tax wrinkles, the works.",
  },
];

const STATS: Array<{ value: string; label: string }> = [
  { value: "TX + CA", label: "US offices, US-based talent operations" },
  { value: "Two specialties", label: "Engineering + customer-operations focus" },
  { value: "Days, not months", label: "From brief to vetted candidate" },
  { value: "W-2 or 1099", label: "Direct-hire, contract, or contract-to-hire" },
];

const ENGAGEMENT: Array<{
  phase: string;
  title: string;
  body: string;
  bullets: string[];
}> = [
  {
    phase: "Step 1 — Brief",
    title: "30-minute intake call",
    body: "We get on a call to understand the role, the team, the comp band, and the must-haves. You walk away with a written brief we both work from.",
    bullets: [
      "Role spec, level, and must-have skills",
      "Comp band, equity range, location / remote policy",
      "Interview process and timeline expectations",
    ],
  },
  {
    phase: "Step 2 — Shortlist",
    title: "Vetted candidates within a week",
    body: "We screen our pool, source where needed, and hand you 3–5 candidates we'd hire ourselves. Each comes with a written summary, rationale, and answers to your must-haves.",
    bullets: [
      "Pre-screened on technical bar and culture fit",
      "Written candidate brief for each intro",
      "Scheduling done — you just show up",
    ],
  },
  {
    phase: "Step 3 — Hire",
    title: "Offer, sign, onboard",
    body: "We support your interview panel, brief the candidate before each round, run offer negotiation, and check in at 30 / 60 / 90 days so the placement actually sticks.",
    bullets: [
      "Panel briefing and candidate prep before each round",
      "Offer negotiation and counter-offer support",
      "30 / 60 / 90-day check-ins post-hire",
    ],
  },
];

const OUTCOMES: Array<{
  tag: string;
  time: string;
  title: string;
  body: string;
  metrics: Array<{ value: string; label: string }>;
}> = [
  {
    tag: "Engineering",
    time: "Within a week",
    title: "Senior backend engineer — vetted in 48 hours",
    body: "Brief came in Monday morning, three vetted candidates in the client's calendar by Wednesday, signed offer the following week. The pattern repeats for backend, ML, and platform roles.",
    metrics: [
      { value: "48h", label: "Brief to first intro" },
      { value: "3", label: "Vetted candidates" },
      { value: "<2w", label: "Brief to signed offer" },
    ],
  },
  {
    tag: "Customer Success",
    time: "Single sprint",
    title: "CS team scale-up — multiple hires at once",
    body: "Series-B SaaS needed to grow CS substantially in one quarter. We embedded as their CS recruiting bench, ran the process end-to-end, delivered signed CSMs inside a sprint.",
    metrics: [
      { value: "Multiple", label: "CSMs hired" },
      { value: "1 sprint", label: "Brief to all-signed" },
      { value: "Retained", label: "All in seat at 6 mo." },
    ],
  },
  {
    tag: "Sales",
    time: "~2 weeks",
    title: "Sales engineer placement",
    body: "Mid-market SaaS needed a hybrid AE / SE who could carry quota and run a technical demo. We surfaced two candidates from our bench; one signed the following Friday.",
    metrics: [
      { value: "2", label: "Vetted candidates" },
      { value: "<2w", label: "Brief to signed" },
      { value: "Quota+", label: "Hit Q1 number" },
    ],
  },
  {
    tag: "Engineering",
    time: "5 days",
    title: "Embedded engineering team — staff augmentation",
    body: "Series-A team needed contract engineers to ship a Q4 launch. We delivered backend, frontend, and DevOps contractors inside five business days; all converted to full-time.",
    metrics: [
      { value: "3", label: "Contractors placed" },
      { value: "5 days", label: "Brief to first contributor" },
      { value: "All", label: "Converted to FTE" },
    ],
  },
  {
    tag: "Operations",
    time: "12 days",
    title: "RevOps lead — coaching to placed",
    body: "Strong operator with the right experience but rough interview skills. Two coaching sessions and a resume rewrite later — multiple offers from companies in our network.",
    metrics: [
      { value: "2", label: "Coaching sessions" },
      { value: "Multiple", label: "Competing offers" },
      { value: "12d", label: "Coaching start to signed" },
    ],
  },
  {
    tag: "Engineering",
    time: "Same week",
    title: "Project rescue — engineering crisis support",
    body: "A client's payments integration broke a week before launch. We placed a senior backend engineer on contract within two business days; ship date held.",
    metrics: [
      { value: "2 days", label: "Brief to engineer onsite" },
      { value: "0", label: "Slip on launch date" },
      { value: "Held", label: "Critical path delivered" },
    ],
  },
];

type TapeItem =
  | { kind: "text"; label: string; variant?: "mono" | "upper" | "italic" | "serif" }
  | { kind: "mark"; letter: string; square?: boolean };

/**
 * Industry / talent-category labels for the marquee. Replaces fictional
 * brand marks (which read as "trusted by" claims we can't substantiate)
 * with the kinds of companies and roles Tryvera places.
 */
const TAPE_LOGOS: TapeItem[] = [
  { kind: "text", label: "SaaS", variant: "upper" },
  { kind: "mark", letter: "F" },
  { kind: "text", label: "Fintech", variant: "italic" },
  { kind: "text", label: "Healthtech", variant: "serif" },
  { kind: "mark", letter: "AI", square: true },
  { kind: "text", label: "AI / ML", variant: "upper" },
  { kind: "text", label: "B2B sales", variant: "mono" },
  { kind: "mark", letter: "C" },
  { kind: "text", label: "Customer Success", variant: "italic" },
  { kind: "text", label: "REVOPS", variant: "upper" },
  { kind: "text", label: "Support", variant: "serif" },
  { kind: "mark", letter: "L", square: true },
  { kind: "text", label: "Logistics", variant: "upper" },
];

export default function Landing() {
  const [activeTab, setActiveTab] = useState<TabId>("engineering");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactInterest, setContactInterest] = useState("");
  const [contactMessage, setContactMessage] = useState("");
  const [contactSent, setContactSent] = useState(false);

  function handleContactSubmit(e: FormEvent) {
    e.preventDefault();
    // No public submission endpoint yet — surface an acknowledgement only.
    // Wire to an inbox (or the existing Express server) before launch.
    setContactSent(true);
    window.setTimeout(() => setContactSent(false), 4000);
    setContactName("");
    setContactEmail("");
    setContactInterest("");
    setContactMessage("");
  }

  const tab = TABS.find((t) => t.id === activeTab) ?? TABS[0];

  return (
    <div className="tb-landing">
      <header className="tb-nav">
        <div className="tb-nav-inner">
          <a href="#top" className="tb-brand" aria-label="Tryvera home">
            <span className="tb-brand-mark" aria-hidden="true" />
            <span className="tb-brand-name">Tryvera</span>
          </a>
          <nav className="tb-nav-links" aria-label="Primary">
            <a href="#what">What we staff</a>
            <a href="#how-we-work">How we work</a>
            <a href="#pillars">Service</a>
            <a href="#outcomes">Outcomes</a>
            <a href="#contact">Contact</a>
          </nav>
          <LoginCta className="tb-btn tb-btn-primary tb-nav-cta">Sign in</LoginCta>
        </div>
      </header>

      <main id="top">
        {/* Hero */}
        <section className="tb-hero">
          <div className="tb-section-inner tb-hero-inner">
            <div>
              <p className="tb-eyebrow">US technology &amp; customer-operations staffing</p>
              <h1 className="tb-hero-title">
                We staff the people <em>US teams</em> ship with.
              </h1>
              <p className="tb-hero-sub">
                TealBridge LLC is a US staffing firm based in Texas and California.
                We place vetted engineers and remote customer-facing professionals
                into the companies that need them — and help qualified candidates
                land roles where they can do their best work.
              </p>
              <div className="tb-hero-ctas">
                <a href="#contact" className="tb-btn tb-btn-primary tb-btn-lg">
                  Talk to us
                </a>
                <a href="#how-we-work" className="tb-btn tb-btn-ghost tb-btn-lg">
                  How we work
                </a>
              </div>
              <p className="tb-hero-trust">
                <strong>Texas &amp; California</strong> · Remote-first placements
                <strong style={{ marginLeft: "0.4rem" }}>·</strong> W-2, 1099, or contract-to-hire
              </p>
            </div>
            <div className="tb-hero-visual" aria-hidden="true">
              <img className="tb-hero-phone" src={ASSET.heroPhone} alt="" loading="eager" />
              <img className="tb-hero-phone-2" src={ASSET.heroPhone2} alt="" loading="eager" />
            </div>
          </div>
        </section>

        {/* Marquee — categories Tryvera serves */}
        <section className="tb-tape" aria-label="Verticals and roles Tryvera places">
          <div className="tb-tape-window">
            <div className="tb-tape-track">
              {[...TAPE_LOGOS, ...TAPE_LOGOS].map((item, idx) => {
                if (item.kind === "mark") {
                  return (
                    <span
                      key={idx}
                      className={`tb-tape-mark${item.square ? " tb-tape-mark--square" : ""}`}
                      aria-hidden="true"
                    >
                      {item.letter}
                    </span>
                  );
                }
                return (
                  <span
                    key={idx}
                    className={`tb-tape-logo${item.variant ? ` tb-tape-logo--${item.variant}` : ""}`}
                  >
                    {item.label}
                  </span>
                );
              })}
            </div>
          </div>
        </section>

        {/* Capability statements (no fabricated metrics) */}
        <section className="tb-stats">
          <div className="tb-section-inner">
            <ul className="tb-stat-grid">
              {STATS.map((s) => (
                <li key={s.label} className="tb-stat">
                  <span className="tb-stat-value">{s.value}</span>
                  <span className="tb-stat-label">{s.label}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Multi-tab "What we staff" */}
        <section className="tb-section tb-tabs-section" id="what">
          <div className="tb-section-inner">
            <p className="tb-eyebrow">What we staff</p>
            <h2 className="tb-section-title">Two specialties. Deep bench in each.</h2>
            <p className="tb-section-lede">
              Tryvera focuses narrowly on the two functions US companies
              most often struggle to staff well: technology and customer
              operations. Pick a specialty to see the kinds of roles we
              place every week.
            </p>
            <div className="tb-tabs-grid">
              <div className="tb-tabs-stage">
                <PhoneMockup tabId={tab.id} />
              </div>
              <div className="tb-tabs-side">
                <div role="tablist" aria-label="Talent specialties" className="tb-tabs-list">
                  {TABS.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      aria-selected={activeTab === t.id}
                      aria-controls={`tb-tab-panel-${t.id}`}
                      id={`tb-tab-${t.id}`}
                      className={`tb-tab-btn${activeTab === t.id ? " is-active" : ""}`}
                      onClick={() => setActiveTab(t.id)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <div
                  className="tb-tab-panel"
                  role="tabpanel"
                  id={`tb-tab-panel-${tab.id}`}
                  aria-labelledby={`tb-tab-${tab.id}`}
                >
                  <h3>{tab.heading}</h3>
                  <p>{tab.body}</p>
                  <ul className="tb-tab-bullets">
                    {tab.bullets.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Pillars — service summary */}
        <section id="pillars" className="tb-section tb-pillars">
          <div className="tb-section-inner">
            <p className="tb-eyebrow">What we offer</p>
            <h2 className="tb-section-title">
              Six pillars. One staffing partner you can call when you need to hire.
            </h2>
            <p className="tb-section-lede">
              Tryvera isn't a job board, an ATS, or a course platform.
              We're a US staffing firm — we do the work end-to-end so your
              hiring manager can stay focused on the team they already have.
            </p>
            <ol className="tb-pillar-grid">
              {PILLARS.map((p) => (
                <li key={p.num} className="tb-pillar-card">
                  <div className="tb-pillar-head">
                    <span className="tb-pillar-num">{p.num}</span>
                    {p.badge && <span className="tb-pillar-badge">{p.badge}</span>}
                  </div>
                  <h3>{p.title}</h3>
                  <p>{p.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Engagement model — three steps */}
        <section id="how-we-work" className="tb-section tb-roadmap">
          <div className="tb-section-inner">
            <p className="tb-eyebrow">How we work</p>
            <h2 className="tb-section-title">
              Three steps from "we need to hire" to "they signed."
            </h2>
            <p className="tb-section-lede">
              Same shape whether it's one engineer or a four-person CS team.
              We brief, we shortlist, we close — and we stay on through
              onboarding so the placement actually sticks.
            </p>
            <ol className="tb-roadmap-grid">
              {ENGAGEMENT.map((p) => (
                <li key={p.phase} className="tb-roadmap-card">
                  <p className="tb-roadmap-phase">{p.phase}</p>
                  <h3>{p.title}</h3>
                  <p>{p.body}</p>
                  <ul>
                    {p.bullets.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Outcomes — anonymous, capability-led */}
        <section id="outcomes" className="tb-section tb-outcomes">
          <div className="tb-section-inner">
            <p className="tb-eyebrow">Outcomes</p>
            <h2 className="tb-section-title">
              The kinds of placements we do, week in and week out.
            </h2>
            <p className="tb-section-lede">
              These describe categories of work we run on repeat. Named,
              signed-off case studies will live here as we publish them.
            </p>
            <ul className="tb-outcome-grid">
              {OUTCOMES.map((o) => (
                <li key={o.title} className="tb-outcome-card">
                  <div className="tb-outcome-head">
                    <span className="tb-outcome-tag">{o.tag}</span>
                    <span className="tb-outcome-time">{o.time}</span>
                  </div>
                  <h3>{o.title}</h3>
                  <p>{o.body}</p>
                  <ul className="tb-outcome-metrics">
                    {o.metrics.map((m) => (
                      <li key={m.label}>
                        <strong>{m.value}</strong>
                        <em>{m.label}</em>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            <p
              className="tb-section-lede"
              style={{ marginTop: "2rem", fontSize: "0.9rem", opacity: 0.75 }}
            >
              Illustrative — these describe real categories of work, not specific
              clients. Named case studies will be added as we publish them.
            </p>
          </div>
        </section>

        {/* Final CTA band */}
        <section className="tb-ctaband tb-on-dark">
          <div className="tb-section-inner">
            <p className="tb-eyebrow">Ready to make your next hire?</p>
            <h2>Brief us today; meet candidates this week.</h2>
            <p>
              TealBridge LLC partners with US companies hiring engineers and
              customer-operations talent. One thirty-minute intake call and
              we're off — vetted candidates land in your calendar inside a
              week.
            </p>
            <div className="tb-ctaband-actions">
              <a href="#contact" className="tb-btn tb-btn-primary tb-btn-lg">
                Talk to us
              </a>
              <a href="mailto:hr@tealbridge.online" className="tb-btn tb-btn-ghost tb-btn-lg">
                Email us
              </a>
            </div>
          </div>
        </section>

        {/* Contact */}
        <section id="contact" className="tb-section tb-contact">
          <div className="tb-section-inner tb-two-col">
            <div>
              <p className="tb-eyebrow">Get in touch</p>
              <h2 className="tb-section-title">Tell us what you're hiring for.</h2>
              <p className="tb-section-lede">
                Hiring manager, recruiter, founder, or candidate — we reply within
                one business day. If it's urgent, mention it in the message and
                we'll move faster.
              </p>
              <ul className="tb-contact-list">
                <li>
                  <strong>Email</strong>
                  <a href="mailto:hr@tealbridge.online">hr@tealbridge.online</a>
                  <em>Response within 1 business day</em>
                </li>
                <li>
                  <strong>Phone</strong>
                  <a href="tel:+16504165015">+1 (650) 416-5015</a>
                  <em>Mon–Fri, 9am–6pm PT</em>
                </li>
                <li>
                  <strong>Texas (HQ)</strong>
                  <span>TealBridge LLC — Texas operations</span>
                </li>
                <li>
                  <strong>California</strong>
                  <span>TealBridge LLC — California operations</span>
                </li>
              </ul>
            </div>
            <form className="tb-form" onSubmit={handleContactSubmit}>
              <p className="tb-form-hint">
                Hiring? Looking for your next role? Either way — tell us what you
                need most.
              </p>
              <label htmlFor="tb-name">Name</label>
              <input
                id="tb-name"
                type="text"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                required
              />
              <label htmlFor="tb-email">Email</label>
              <input
                id="tb-email"
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                required
              />
              <label htmlFor="tb-interest">I'm reaching out about</label>
              <input
                id="tb-interest"
                type="text"
                placeholder="e.g. hiring an engineer, hiring a CSM, looking for a role"
                value={contactInterest}
                onChange={(e) => setContactInterest(e.target.value)}
              />
              <label htmlFor="tb-message">Message</label>
              <textarea
                id="tb-message"
                rows={5}
                value={contactMessage}
                onChange={(e) => setContactMessage(e.target.value)}
                required
              />
              <button type="submit" className="tb-btn tb-btn-primary">
                {contactSent ? "Thanks — we'll be in touch" : "Send message"}
              </button>
            </form>
          </div>
        </section>
      </main>

      <footer className="tb-footer">
        <div className="tb-section-inner tb-footer-grid">
          <div className="tb-footer-brand">
            <span className="tb-brand">
              <span className="tb-brand-mark" aria-hidden="true" />
              <span className="tb-brand-name">Tryvera</span>
            </span>
            <p>
              TealBridge LLC — a US staffing firm based in Texas and California.
              We connect US companies with vetted engineering and customer-operations
              talent.
            </p>
            <p className="tb-footer-contact">
              <a href="mailto:hr@tealbridge.online">hr@tealbridge.online</a>
              <a href="tel:+16504165015">+1 (650) 416-5015</a>
            </p>
          </div>
          <div>
            <h4>For Companies</h4>
            <ul>
              <li><a href="#what">Engineering hires</a></li>
              <li><a href="#what">Customer-ops hires</a></li>
              <li><a href="#how-we-work">How we work</a></li>
              <li><a href="#contact">Brief us</a></li>
            </ul>
          </div>
          <div>
            <h4>For Candidates</h4>
            <ul>
              <li><a href="#pillars">Coaching &amp; prep</a></li>
              <li><a href="#what">Open roles</a></li>
              <li><a href="#contact">Get in touch</a></li>
            </ul>
          </div>
          <div>
            <h4>Company</h4>
            <ul>
              <li><a href="#how-we-work">How we work</a></li>
              <li><a href="#outcomes">Outcomes</a></li>
              <li><a href="#contact">Contact</a></li>
            </ul>
          </div>
        </div>
        <p className="tb-footer-legal">
          © {new Date().getFullYear()} TealBridge LLC. All rights reserved.
        </p>
      </footer>
    </div>
  );
}
