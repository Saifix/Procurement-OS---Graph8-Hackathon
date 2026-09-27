# Agentic Procurement OS — Nestlé Procurement Demo

A working procurement operating system: raise a material requirement, discover
suppliers through graph8, send RFQs, collect and compare quotations, record a
sourcing decision, and plan material cover from an editable production plan.

> **Fictionalised demonstration workspace.** Not an official Nestlé product and
> not connected to Nestlé's internal systems. All inventory, recipes, usage
> rates, demand, supplier quotes, costs and forecasts are illustrative sample
> data, not Nestlé's confidential information.

**Presentation:** https://canva.link/we84iy84ftpivj8

---

## Run it

```bash
cd app
docker compose up -d --wait
```

Open **http://localhost:8080** and pick a role.
The demo mail inbox is at **http://localhost:8025**.

```bash
docker compose logs -f app       # follow logs
docker compose down              # stop
docker compose up -d --build     # rebuild after a change
```

Port 8080 taken? Set `APP_PORT=9090` in `.env`.

Requirements, quotations and decisions persist in a Docker volume, so a restart
keeps your work. `POST /api/reset` clears the workspace.

---

## The four roles

Pick one at login; switch any time from the sidebar. Navigation adapts.

| Role | Starts on | Responsible for |
|---|---|---|
| Requirement Raiser | Raise requirement | Raising material requirements, tracking progress |
| Procurement Officer | Dashboard | Reviewing, sourcing, RFQs, verifying quotes, recommending |
| Procurement Head | Dashboard | Consolidated demand and risk, approve / reject / return |
| Inventory Planner | Inventory & planning | Stock cover, shortage warnings, reorder recommendations |

---

## Just ask

The fastest path is **one text box**. Type what you need in plain English:

> *"We're running low on tomato paste at Kabirwala — need about 50 tonnes before
> the end of November for the Q4 ketchup run, getting urgent"*

Press **Do it** and the agent parses it, creates the requirement, discovers
suppliers, shortlists the best three and drafts an RFQ for each — then shows you
exactly what it **assumed** versus what it **read**, with a confidence score.
If it cannot identify the material or quantity it blocks rather than guessing.

Parsing runs on an LLM skill hosted **in your graph8 organisation**
(`Procurement Intake Parser`, Claude Sonnet 4.6, `action_id`
`2730f9a5-a7ee-4159-9396-986bd1be7cfa`) whenever `GRAPH8_API_KEY` is set.
Without a key a built-in deterministic parser takes over — no network, no
credits — and the UI says which one ran.

The full form is still available under **Raise manually**.

## The journey

1. **Ask** (or raise manually) — submitting starts a supplier-discovery agent
   task **against those values**.
2. **Review** — edit quantity, date or spec; discovery re-runs on the new values.
3. **Supplier discovery** — graph8 results alongside the internal directory, each
   with why it matched and what is *not* known.
4. **RFQ** — one per supplier, built from this requirement. Editable, approval-gated.
5. **Quotations** — record supplier replies or enter them manually. Blank stays blank.
6. **Comparison** — side by side, with an agent recommendation that refuses to
   crown a winner without evidence.
7. **Approval** — the head records a decision with a reason and an audit trail.

Plus **Inventory & planning** (editable BOM, stock, lead times → live projections),
**Forward buying** (buy now / later / split), **Suppliers**, **Agent activity**,
and **Sell our products** — the other direction, where graph8 finds buyers for
what the plant makes, qualifies them, writes their outreach, and pushes the
qualified list back into the graph8 CRM.

---

## Three labels, everywhere

Every fact on screen says where it came from:

- 🟢 **graph8 live** — returned by a real graph8 query
- 🟣 **calculated** — computed by this app from those inputs
- 🟠 **illustrative** — demo content, never a real business fact

Quotations additionally distinguish **supplier provided** from **user entered**.

---

## What is actually real

**Real graph8 data.** 20 supplier companies and contacts harvested from live
`g8_find_contacts` queries on 2026-09-27 (`server/data/graph8-suppliers.json`),
with the query filters and match counts recorded. Victory Packaging, Green Bay
Packaging, Rohrer, Flavor Pic Tomato, Cacique Foods and the rest are real
companies with real contacts.

**Real calculations.** Stock projections, shortage dates, reorder quantities,
quote totals, feasibility checks and forward-buy scenarios are computed from
inputs you can edit. Nothing is a stored constant.

**Real workflow state.** Requirements, shortlists, RFQs, quotations, decisions
and agent tasks are records that persist.

**Real email.** The stack bundles a Mailpit SMTP server, so approving an RFQ
performs a genuine SMTP transaction and produces a real message id. Read what
was actually delivered at **http://localhost:8025**. Point `DEMO_SMTP_URL` at a
real relay and the same code path delivers externally.

**Real round trip.** The fictional approved vendors reply with a quotation a few
seconds later — a real email into the same inbox — which records a quotation and
re-runs the comparison on its own.

## What is not

**Mail does not leave the machine.** Mailpit accepts everything and forwards
nothing, which is what you want when the recipients are demo addresses standing
in for suppliers. graph8 masks real contact emails, so no message could reach a
real business even by accident.

**Only fictional vendors auto-reply.** Al-Noor, Sahiwal, Packwell and Cristal PET
are invented, so generating a quotation in their name costs nobody anything. A
graph8-discovered company is a real business and **never** auto-replies —
inventing a quotation in its name would be a fabrication wherever the mail landed.
Quotations that arrive this way are labelled `demo_reply`.

**Supplier capability is never inferred.** A graph8 result means a company
exists and someone works there. Food-grade status, certification, capacity and
willingness to supply are shown as *unknown* until verified.

**Prices are not forecasts.** Forward-buying scenarios are user-selected
assumptions. graph8 discovery and signals say nothing about commodity prices,
and the UI says so on the page.

**Inventory and recipes are illustrative.** The ketchup BOM, stock levels and
lead times are sample values. Edit them freely — the maths follows.

---

## Verify it

```bash
bash scripts/flow-test.sh 8080      # 20-step API workflow test
cd scripts && node shoot.mjs        # 34 screenshots + UI audit
```

The flow test asserts the things that matter: that validation rejects bad input,
that a different material returns different suppliers, that send status is
honest, that the cheapest quote is *not* auto-selected, that changing production
volume changes the projection, and that a reject without a reason is refused.

`shoot.mjs` drives real Chromium through every screen and fails on console
errors, HTTP ≥400, failed requests, horizontal overflow, elements bleeding out
of the viewport, stuck skeletons and `undefined` in the DOM.

---

## Layout

```
app/
├── docker-compose.yml       app + mail server, healthchecked, state volume
├── Dockerfile               multi-stage: vite build → node runtime
├── .env                     committed and working
├── server/
│   ├── src/index.js         API + static host
│   ├── src/store.js         persistent workspace state
│   ├── src/domain/
│   │   ├── intake.js        natural-language parsing (graph8 skill | local)
│   │   ├── mail.js          real SMTP delivery + demo supplier responder
│   │   ├── planning.js      stock projection, reorder, forward buy
│   │   ├── sourcing.js      supplier matching, RFQ, compare, recommend
│   │   └── agents.js        agent task runner
│   └── data/
│       ├── graph8-suppliers.json   harvested live graph8 results
│       └── workspace.json          Nestlé demo workspace (illustrative)
├── web/                     React + Vite + Framer Motion, light theme
└── scripts/                 flow-test.sh, shoot.mjs
```
