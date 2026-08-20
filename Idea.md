# Sequencer

**A decline-reason-aware recovery agent for failed recurring payments.**

Submission for the [Razorpay AI Buildathon](https://razorpay.com/buildathon), Track 03 — AI Revenue Recovery.
Deadline 5 September 2026. Target submission 4 September.

> Named after "Mandate retry sequencer", one of Razorpay's own listed example
> directions for this track. Internal vocabulary borrows from triage: cases are
> triaged by cause, and the triage queue holds what needs a human.

---

## 1. One-line pitch

Regulation gives you exactly four attempts to collect a failed auto-debit. Razorpay's
built-in retry spends them on a calendar. Sequencer spends them only where they can
actually succeed, and refuses to spend them at all where they can't.

---

## 2. The problem

Subscription businesses charge a customer automatically every cycle. Sometimes the
charge fails. When it does, the merchant is holding a scarce, regulated budget of
recovery attempts and almost no information about how to spend it.

Razorpay's own [subscription payment retries documentation](https://razorpay.com/docs/payments/subscriptions/payment-retries/)
opens by naming four distinct reasons a recurring charge fails:

- the card has expired
- the bank has blocked the card
- the customer's account has insufficient balance
- the customer has cancelled the mandate from their end

It then applies **one policy to all four**: move the subscription to `pending`, retry
the following day, shift the charge date backwards if it lands on a bank holiday, and
after retries are exhausted move to `halted`.

Those four causes do not have the same recoverability.

- Insufficient balance _can_ be recovered by a retry, but only if it lands after money arrives.
- An expired card can _never_ be recovered by a retry. The instrument has to change.
- A cancelled mandate is withdrawn consent. Retrying it is not a wasted attempt, it's a
  debit against an authorisation the customer revoked.

So the default behaviour burns a regulated budget on outcomes that were impossible from
the first millisecond, and keeps pushing at customers who deliberately left.

---

## 3. The insight this is built on

Three facts, each from a published source, that together define the whole problem:

1. **The budget is four.** NPCI permits one original debit attempt plus a maximum of
   three retries per mandate — four total — in force since 1 August 2025.
   ([IBS Intelligence](https://ibsintelligence.com/ibsi-news/npci-tightens-upi-api-rules-to-boost-resilience-fraud-controls/),
   [Economic Times](https://economictimes.indiatimes.com/wealth/save/big-changes-to-upi-from-august-1-daily-limits-api-rules-and-penalties-introduced/fixed-time-windows-for-auto-debits-mandate-execution-limit/slideshow/123118019.cms))

2. **Wasting it is chargeable.** Visa's excessive reattempts programme permits no
   reattempts on hard declines and charges per-transaction fees for exceeding reattempt
   limits. ([PayPal](https://www.paypal.com/us/brc/article/avoid-excessive-retries-penalties),
   [Visa Processing Integrity](https://developers.getevolved.com/enterprise/docs/visas-processing-integrity-fee-program))

3. **Each attempt has preconditions.** Under RBI's consolidated Digital Payments —
   E-mandate Framework, 2026 (notified 21 April 2026, effective immediately), the customer
   must be notified at least 24 hours before a debit, a confirmation must follow it,
   authentication is required above ₹15,000 (₹1,00,000 for categories such as insurance
   premiums, SIPs and credit card bills), and — directly relevant here — an existing
   mandate may be mapped to a reissued card.
   ([RBI](https://website.rbi.org.in/documents/87730/39710850/Processing+of+e-mandates+for+recurring+transactions.pdf),
   [KPMG summary](https://kpmg.com/in/en/insights/2026/06/reserve-bank-of-india-rbi-digital-payments-e-mandate-framework-2026.html))

Therefore: **recovery is a constrained allocation problem, not a retry loop.** The only
question that matters per failure is whether spending one of four attempts can possibly
work — and if not, which non-retry intervention can.

That last point in fact 3 is why the expired-card case is recoverable at all: the
compliant path is mandate migration, not repetition.

---

## 4. What it actually does

For every failed charge the agent runs four stages. Each stage has a visible output, and
it cannot skip to acting.

### Stage 1 — Detect

Ingest the failure as a merchant observes it. The failure object mirrors Razorpay's
documented error payload: `code`, `reason`, `source`, `step`, `description`
([error codes reference](https://razorpay.com/docs/errors/codes)).

### Stage 2 — Diagnose

Classify into one of nine internal causes, and commit to a **recoverability class** with
a confidence score, _before_ choosing an action.

| Cause                    | Recoverability    | Meaning                                             |
| ------------------------ | ----------------- | --------------------------------------------------- |
| `INSUFFICIENT_FUNDS`     | `RETRY_VIABLE`    | An attempt can work. Timing is everything.          |
| `BANK_UNAVAILABLE`       | `RETRY_VIABLE`    | Transient. Cheapest win on the board.               |
| `CARD_EXPIRED`           | `RETRY_FUTILE`    | No retry ever succeeds. Migrate the mandate.        |
| `CARD_BLOCKED`           | `RETRY_FUTILE`    | Issuer-side. Needs customer or bank action.         |
| `AMOUNT_EXCEEDS_MANDATE` | `RETRY_FUTILE`    | Above authorised ceiling. Needs re-auth.            |
| `AUTH_REQUIRED`          | `RETRY_FUTILE`    | A silent retry can't supply a second factor.        |
| `MANDATE_REVOKED`        | `RETRY_FORBIDDEN` | Consent withdrawn. Hard stop.                       |
| `MANDATE_PAUSED`         | `WAIT`            | Suspended, not withdrawn. Doing nothing is correct. |
| `TECHNICAL_UNKNOWN`      | `NEEDS_HUMAN`     | Never guess with someone's money.                   |

An unrecognised reason string returns `null` rather than a guess. `null` is a real answer:
it routes to the LLM layer, and if still unresolved, to a human.

### Stage 3 — Intervene

Pick one action. Nine are available: `RETRY_NOW`, `RETRY_SCHEDULED`,
`REQUEST_CARD_UPDATE`, `REQUEST_MANDATE_REAUTH`, `REQUEST_AFA`,
`SEND_PRE_DEBIT_NOTIFICATION`, `WAIT`, `STOP`, `ESCALATE_TO_MERCHANT`.

`WAIT` and `STOP` are first-class actions, not fallbacks. On a paused mandate, waiting
recovers the money for free. On a revoked one, stopping is the only correct move.

### Stage 4 — Recover and learn

Observe the outcome, write it to the ledger, and update what's known about the customer.

### The guardrails

Eight hard gates, each citing its source, evaluated **after** the agent proposes and
**before** anything executes. They live in code, not in the prompt, because a prompt is a
request and code is a rule.

| Rule                                 | Source                                                  |
| ------------------------------------ | ------------------------------------------------------- |
| `NPCI_ATTEMPT_CAP`                   | 1 original + 3 retries maximum                          |
| `RBI_PRE_DEBIT_NOTIFICATION`         | 24h notice required before any debit                    |
| `CARD_NETWORK_NO_HARD_DECLINE_RETRY` | Visa: no reattempts on hard declines                    |
| `NPCI_EXECUTION_WINDOW`              | Autopay execution restricted to non-peak windows        |
| `MANDATE_CAP`                        | Debit above authorised ceiling isn't covered by consent |
| `AFA_REQUIRED_ABOVE_CEILING`         | Above ₹15,000 needs authentication each time            |
| `REVOKED_CONSENT_NO_CONTACT`         | Revoked mandate: no debit _and_ no dunning              |
| `CONFIDENCE_FLOOR`                   | No autonomous money action below 0.7 confidence         |

A rejection is recorded, never thrown. The ledger shows both what the agent wanted and
why it was stopped, because a blocked attempt is a result worth seeing.

### Autonomy model

Tiered, deliberately not human-approve-everything. Inside the envelope — valid notice,
attempts remaining, permitted window, confidence above floor — the agent executes on its
own. Outside it, it escalates. Gating every action would make the batch measurement in
§5 impossible and would make this a suggestion queue rather than an agent.

---

## 5. How we prove it works

The bar for Track 03 is explicit: measured money recovered across a batch, with compliant
escalation, stopping rules, and an audit trail. A dashboard is not a measurement, so the
evaluation harness is the primary artefact, not the UI.

### Hidden ground truth

300 simulated subscriptions. Each gets a **secret persona** that decides what actually
happens. The agent never sees it — it sees only `ObservableSubscription`, and if a field
isn't on that interface the agent cannot read it.

| Persona                | Observed cause     | Truth                                  |
| ---------------------- | ------------------ | -------------------------------------- |
| Salary-cycle shortfall | insufficient funds | Succeeds if retried after funds land   |
| Chronic shortfall      | insufficient funds | Low odds whenever you try; poor value  |
| Reissued card          | card expired       | Retry never works; card update does    |
| Silent churner         | card expired       | Nothing works; they're gone            |
| Deliberate canceller   | mandate revoked    | Nothing works, **and contact is harm** |
| Temporary pause        | mandate paused     | Resumes free if you just wait          |
| Bank outage            | gateway/network    | Retry works within hours               |
| Plan upgrade over cap  | exceeds mandate    | Needs re-authorisation                 |
| AFA threshold          | auth required      | Needs authentication flow              |
| Contested charge       | generic failure    | Human only                             |

Because we authored the personas, we know the correct answer for all 300 cases. That makes
the metrics honest by construction rather than by assertion. Seeded RNG, so every run
reproduces.

### Three strategies, same cohort

- **Baseline** — Razorpay-default-style: next-day retry, bank-holiday shift, identical for every cause.
- **Agent** — reason-aware allocation.
- **Oracle** — perfect diagnosis. Establishes the ceiling, so we can report how much of the
  achievable recovery the agent captured instead of quoting a bare percentage.

### Metrics

- ₹ recovered, and ₹ recovered as a share of ₹ _recoverable_ (oracle-defined)
- Attempts spent, and **attempts wasted** — spent on causes that were never retry-recoverable
- Compliance violations attempted vs blocked, and leaked (must be zero)
- Contacts sent to deliberate cancellers — the restraint metric
- Diagnosis confusion matrix: predicted cause vs true cause
- Estimated fine exposure avoided
- **Net**: ₹ recovered minus wasted-attempt cost minus fine exposure

### The expected result

The baseline will likely recover a comparable gross amount — it carpet-bombs, so it
stumbles into some wins. It will also burn attempts on dead cards, push at customers who
cancelled on purpose, and trip gates it should never approach. The agent should reach
similar gross on materially fewer attempts, with zero violations and zero contact to
cancellers.

**The claim is not "we recover more." It's "we recover comparably on a fraction of a
regulated budget, without touching people who asked us to stop."**

---

## 6. Architecture

```
Failure event (Razorpay-shaped payload)
        │
        ▼
┌───────────────────┐   deterministic first: reason-string lookup + step signal
│ Stage 2: Diagnose │──▶ resolves ~80-85% with zero API spend
└───────────────────┘   only ambiguous cases reach the LLM
        │                        │
        │                        ▼
        │              ┌──────────────────┐  cause + confidence + reasoning
        │              │   LLM diagnoser  │  (never touches arithmetic)
        │              └──────────────────┘
        ▼
┌───────────────────┐
│ Stage 3: Policy   │  cause → recoverability → one proposed action
└───────────────────┘  deterministic. No model in this path.
        │
        ▼
┌───────────────────┐  8 cited rules. Permit or refuse.
│    Guardrails     │  Refusals recorded, not thrown.
└───────────────────┘
        │
        ├── permitted ──▶ execute against the simulated world
        └── refused   ──▶ escalation queue
        │
        ▼
┌───────────────────┐  append-only. Trigger, options weighed, choice,
│      Ledger       │  permission result, outcome.
└───────────────────┘
        │
        ▼
   Scoreboard: agent vs baseline vs oracle
```

**The model never does arithmetic.** Attempt counting, budget math, notice-window
calculation and date logic are deterministic code. The LLM's only job is reading an
ambiguous failure and proposing a cause with a confidence. This is both the cheaper
architecture and the defensible one.

---

## 7. Tech stack

| Layer      | Choice                                                   | Why                                                    |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------ |
| Language   | TypeScript (strict)                                      | One language across harness and UI                     |
| Runner     | `tsx` CLI                                                | Batch harness needs no server                          |
| AI         | OpenAI `gpt-5.4-mini`                                    | Diagnosis only, on the ambiguous minority              |
| Validation | `zod`                                                    | Structured model output, validated not trusted         |
| UI         | Next.js                                                  | Three read-only screens                                |
| Storage    | JSON run artefacts, Supabase Postgres if the UI needs it | Ledger wants relational queries                        |
| Auth       | **None**                                                 | Auth proves nothing here. One hardcoded demo merchant. |

Money is integer paise everywhere. Never floats, never rupee decimals. Every amount field
is suffixed `Paise` so misuse is visible at the call site.

### Budget

`gpt-5.4-mini` is $0.75 per million input tokens and $4.50 per million output
([pricing](https://openai.com/API/pricing/)). At roughly 1,200 in / 400 out per call
that's about a quarter of a cent per diagnosis.

- Naive (LLM every record, 300 cases): ~$0.80/run → the $15 credit dies in ~18 runs
- Deterministic-first (LLM on ~15%): ~$0.12/run → ~120 runs
- Dev loop on 40-case cohorts: under a cent

The cheap architecture and the impressive one are the same architecture.

---

## 8. Scope

**In:**
Failed recurring-payment recovery, one leakage type, all four stages, 300-case batch,
three strategies, guardrails in code, append-only ledger, confusion matrix, three-screen
read-only UI, one documented failure case.

**Explicitly out** — so the demo is one clean loop rather than five broken ones:
no real email/SMS/WhatsApp sending (mocked at the boundary), no live money movement,
no voice agent, no auth or multi-tenancy, no cart abandonment, no B2B receivables,
no payment-degradation root-cause analysis.

Cart abandonment and subscription recovery are the two agents Razorpay
[already shipped in Agent Studio](https://razorpay.com/blog/agent-studio-ai-agents-by-razorpay/).
Building either generically would be handing them a thinner copy of their own product.

---

## 9. Positioning

Razorpay ships subscription retries today, and Agent Studio ships a Subscription Recovery
agent. This has to be addressed on camera, not dodged.

- **Their built-in retry** is schedule-driven: next day, shifted for bank holidays,
  identical for all four causes its own docs enumerate.
- **Agent Studio's Subscription Recovery** applies retry logic and customer nudges.
- **Sequencer** is budget-driven. It treats the four NPCI-permitted attempts as a scarce
  resource, allocates them by cause, refuses to spend them where they cannot work, and
  proves the allocation on a measured batch against the shipped default.

"Mandate retry sequencer" is one of Razorpay's own listed example directions for Track 03.
This is that, taken to measured depth.

---

## 10. Build plan (16 days)

| Dates     | Work                                                          |
| --------- | ------------------------------------------------------------- |
| Aug 20    | ✅ Scaffold, domain types, decline taxonomy, compliance layer |
| Aug 21–22 | Simulator: personas, generator, world model, seeded RNG       |
| Aug 23–24 | Baseline strategy + scoring harness + confusion matrix        |
| Aug 25–26 | Agent with deterministic stub diagnoser; oracle bound         |
| Aug 27–28 | LLM diagnosis layer; measure against stub                     |
| Aug 29    | Ledger + escalation queue                                     |
| Aug 30–31 | Three-screen dashboard                                        |
| Sep 1     | Freeze. Full runs, final numbers                              |
| Sep 2–3   | README, architecture diagram, video                           |
| Sep 4     | Submit                                                        |

Never submit on deadline day.

---

## 11. The 5-minute video

1. **0:00–0:30** — The problem. Razorpay's own doc names four causes and treats them alike.
2. **0:30–1:30** — One subscription end to end: failure in, diagnosis with confidence,
   action chosen, outcome, ledger entry.
3. **1:30–2:30** — Guardrails. Show the agent proposing a retry and a cited rule refusing it.
4. **2:30–4:00** — Scoreboard. 300 cases. Baseline vs agent vs oracle. Gross, attempts,
   waste, violations, net.
5. **4:00–4:40** — One case it got wrong, and why the confidence calibration failed.
6. **4:40–5:00** — What's next, and what deliberately isn't built.

Item 5 is the one most people would cut. It stays.

---

## 12. Open items to resolve before submission

- [ ] **Confirm the deadline and eligibility** from the apply form. Students only,
      in-person Bangalore from September.
- [ ] Promote every entry in `RAZORPAY_REASON_MAP` from `inferred` to `verified` by
      reading [list](https://razorpay.com/docs/errors/payments/list/),
      [cards](https://razorpay.com/docs/errors/payments/cards/) and
      [UPI](https://razorpay.com/docs/errors/payments/upi/) error pages. Correct strings
      that differ. **Do this by hand** — being able to defend this table line by line is
      the whole edge.
- [ ] Reconcile `AUTOPAY_EXECUTION_WINDOWS` against the actual NPCI circular. The rule's
      existence is well established; the exact hours in the code are a working assumption
      and are flagged as such.
- [ ] Read the RBI E-mandate Framework 2026 primary document rather than relying on the
      KPMG summary.
- [ ] Check whether Razorpay documents salary-cycle-aware retry timing anywhere outside
      the subscriptions retry doc. It is **not** in that doc — which is checked — but if it
      exists elsewhere, timing intelligence must not be claimed as novel.
- [ ] Decide whether to wire real Razorpay test-mode APIs for payload shape fidelity.

---

## 13. What this is not

Not an autonomous finance department. Not a revenue forecaster. Not a churn predictor.
Not a WhatsApp blaster. One loop, one leakage type, measured honestly, with the brakes
visible.

The earlier version of this document was a vision statement listing everything a revenue
agent could eventually do. That version would have lost, because Track 03's bar opens by
rejecting exactly that: identifying problems without recovering money.
