# Sequencer

**A decline-reason-aware recovery agent for failed recurring payments.**

Submission for the [Razorpay AI Buildathon](https://razorpay.com/buildathon), Track 03 — AI Revenue Recovery.
Deadline 5 September 2026. Target submission 4 September.

> **Status: historical design brief.** This file records how the scope evolved. For current
> setup, runtime boundaries and the durable Test Mode architecture, use [README.md](README.md)
> and [docs/architecture.md](docs/architecture.md).

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

Takes **two inputs**, not one: the payment failure _and_ the mandate state. Razorpay's
error taxonomy carries no mandate information at all, so a classifier reading only
`reason` cannot tell a customer who withdrew consent from one whose bank was briefly
down — and those have opposite correct responses. See `docs/decline-taxonomy.md` §5.

Classify into one of fourteen causes and commit to a **recoverability class** with a
confidence score, _before_ choosing an action. The list grew from nine after verifying
Razorpay's real error pages, which surfaced causes that had been missed entirely.

| Cause                      | Recoverability    | Meaning                                                          |
| -------------------------- | ----------------- | ---------------------------------------------------------------- |
| `INSUFFICIENT_FUNDS`       | `RETRY_VIABLE`    | An attempt can work. Timing is everything.                       |
| `BANK_UNAVAILABLE`         | `RETRY_VIABLE`    | Transient. Cheapest win on the board.                            |
| `LIMIT_EXCEEDED_TEMPORARY` | `RETRY_VIABLE`    | Daily cap; resets overnight. **The one case the default nails.** |
| `CARD_EXPIRED`             | `RETRY_FUTILE`    | No retry ever succeeds. Migrate the mandate.                     |
| `INSTRUMENT_BLOCKED`       | `RETRY_FUTILE`    | Blocked by the customer or their bank.                           |
| `INSTRUMENT_NOT_ENABLED`   | `RETRY_FUTILE`    | Never enabled for online or recurring use.                       |
| `ACCOUNT_MISMATCH`         | `RETRY_FUTILE`    | Paid from an account other than the registered one.              |
| `VPA_INVALID`              | `RETRY_FUTILE`    | UPI handle invalid or unresolvable.                              |
| `AMOUNT_EXCEEDS_MANDATE`   | `RETRY_FUTILE`    | Above the authorised ceiling. Needs re-authorisation.            |
| `AUTH_REQUIRED_AFA`        | `RETRY_FUTILE`    | A silent retry cannot supply a second factor.                    |
| `FRAUD_SUSPECTED`          | `RETRY_FORBIDDEN` | Issuer called it fraud. Not ours to overrule.                    |
| `MANDATE_REVOKED`          | `RETRY_FORBIDDEN` | Consent withdrawn. Hard stop, messages included.                 |
| `MANDATE_PAUSED`           | `WAIT`            | Suspended, not withdrawn. Doing nothing is correct.              |
| `AMBIGUOUS_BANK_DECLINE`   | `NEEDS_HUMAN`     | The bank gave no reason. Never guess.                            |

Two things return `null` rather than a guess: an unrecognised reason string, and
`AMBIGUOUS_BANK_DECLINE` itself. Null is a real answer — it routes to the model layer, and
if still unresolved, to a human. Reporting an unexplained decline as _resolved_ would also
have meant the model was never consulted about the only cases it can help with
(`DECISIONS.md` D18).

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
happens. The agent never sees it — it sees only `ObservableSubscription`, and a test
asserts no file in `src/strategies/` imports from `src/sim/`. The oracle is the single
sanctioned exception, and a test also confirms it _does_ still read truth, so the ceiling
cannot silently degrade into a second agent run.

Thirteen personas. Two of them **conceal their cause**: a genuine balance shortfall
reported as a bare `payment_failed`, and a dead card reported as `card_declined`. Those
exist because without them the lookup table was always right, the oracle was identical to
the agent to the rupee, and a reasoning layer had nothing to contribute. A benchmark that
cannot be got wrong measures nothing (`DECISIONS.md` D17).

| Persona                | Observed cause     | Truth                                                   |
| ---------------------- | ------------------ | ------------------------------------------------------- |
| Salary-cycle shortfall | insufficient funds | Succeeds if retried on the advertised funding day       |
| Chronic shortfall      | insufficient funds | Low odds whenever you try; poor value                   |
| Reissued card          | card expired       | Retry never works; a card update does                   |
| Silent churner         | card expired       | Nothing works; they are gone                            |
| Deliberate canceller   | mandate revoked    | Nothing works, **and contact is harm**                  |
| Temporary pause        | mandate paused     | Resumes free if you simply wait                         |
| Bank outage            | bank/gateway error | Retry works within hours                                |
| Plan upgrade over cap  | above mandate cap  | Needs re-authorisation                                  |
| Above the AFA ceiling  | auth required      | Needs an authentication flow                            |
| Fraud-flagged          | risk check failed  | Unrecoverable; reattempting is chargeable               |
| Unexplained decline    | bare decline       | Sometimes a human can fix it, often not                 |
| **Masked shortfall**   | bare decline       | Really a funding-cycle problem — inferable from history |
| **Masked dead card**   | bare decline       | Really a dead card — the payload never says so          |

Because we authored the personas, the correct answer is known for all 300 cases. That
makes the metrics honest by construction rather than by assertion. Seeded RNG throughout,
so every run reproduces to the rupee.

All randomness happens at generation time. The world model that resolves outcomes is a
pure function of hidden state and the clock, which is what keeps runs reproducible and the
resolution logic testable.

### Four strategies, same cohort

- **Baseline** — Razorpay-default-style: next-day retry, bank-holiday shift, identical for every cause.
- **Agent** — reason-aware allocation.
- **Agent + LLM** — the same policy with model-assisted diagnosis for genuinely ambiguous declines.
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

### Measured results

Holdout cohort, seed 19980417, 300 cases. Reproduce with `npm run harness`. Every figure
below is read from the artifacts committed to `runs/` — the same files the dashboard
renders.

```
at risk       ₹6,55,900   300 cases
recoverable   ₹5,12,385   215 cases   (78.1% of money, 71.7% of cases)

STRATEGY       RECOVERED  % MONEY  % CASES  ATTEMPTS  ₹/ATTEMPT  CONTACTS
baseline       ₹1,24,939    24.4%    28.4%       716       ₹175       268
agent          ₹3,92,147    76.5%    71.2%       525       ₹747        84
agent+llm      ₹4,10,939    80.2%    74.9%       535       ₹768        84
oracle         ₹4,63,308    90.4%    89.3%       572       ₹810        99

WHAT EACH LAYER IS WORTH
  ceiling — recoverable at all           ₹5,12,385
  Razorpay's documented default          ₹1,24,939     24.4%
  + reason-aware allocation              ₹3,92,147     76.5%   adds ₹2,67,208
  + reasoning layer on bare declines     ₹4,10,939     80.2%   adds  ₹18,792
  + perfect diagnosis (oracle)           ₹4,63,308     90.4%   adds  ₹52,369
```

**Restraint.** The default proposed 91 debits against hard declines and 32 messages to
customers who had withdrawn consent; the compliance layer refused all of them and none
were delivered. The agent proposed none of either. Nothing bad happened in either case —
the difference is that one of them needs the brakes and the other does not.

**Sensitivity.** `npm run sensitivity` runs the same comparison over three deliberately
different compositions and exits non-zero if the ordering fails.

| Mix         | Ceiling   | Baseline | Agent | Oracle |
| ----------- | --------- | -------- | ----- | ------ |
| balanced    | ₹5,12,385 | 24.4%    | 76.5% | 90.4%  |
| churn_heavy | ₹3,97,334 | 19.4%    | 75.9% | 90.8%  |
| funds_heavy | ₹5,76,861 | 23.0%    | 81.2% | 90.0%  |

The magnitudes move with the composition, as they should — a churn-heavy cohort simply has
less to win. The ordering does not.

**Floor sensitivity.** `npm run floors` re-runs the agent at confidence floors 0.50, 0.70
and 0.90. The floor is the one guardrail that is internal policy rather than a regulator's
rule, so its effect is measured rather than assumed. On this path it never fires — the
deterministic diagnoser claims only 0.95 and 0.99 on this cohort — so all three rows are
identical at 76.5%, which is itself the finding: the conclusion is independent of the
internal threshold because the threshold never binds there. A fixed-confidence probe
adjudicated through the engine's own entry point verifies the option actually reaches
compliance (`DECISIONS.md` D22). With `--llm` the floor does bind, and the rupee cost of
strictness becomes measurable.

### What the claim is, and is not

**Not** "Sequencer recovers three times more than Razorpay." Agent Studio ships a
Subscription Recovery agent today; a threefold gap over a production payments platform
would not be a plausible claim.

**The claim:** on a 300-case simulated cohort, reason-aware allocation of a four-attempt
regulatory budget recovers 76.5% of the achievable ceiling against 24.4% for the
**documented default retry schedule**, on 27% fewer attempts, without proposing a single
message to a withdrawn-consent customer, and the ordering holds across three cohort
compositions. See `DECISIONS.md` D21.

### Honest limitations

- Persona **response rates are invented**. How likely a customer is to replace a dead card
  when asked is our assumption, not data. This is the softest input in the project and the
  reason the sensitivity analysis exists.
- The NPCI four-attempt cap and the RBI notice requirement are **secondary sources**; the
  primary circulars have not been read end to end.
- The NPCI Autopay execution windows in `regulation.ts` are **unverified** as to their
  exact hours. The rule's existence is well established; the boundaries are a working
  assumption and flagged as such in the code.
- The `agent+llm` figures move slightly between runs because the model runs at temperature
  0.2. The three deterministic strategies are byte-identical run to run.
- Money is concentrated: one persona must exceed the ₹15,000 authentication ceiling by
  regulation, so it is inherently ~30x a typical subscription. Case counts are reported
  alongside money for exactly this reason.

## 6. Architecture

```
Failure event (Razorpay-shaped)  +  mandate state (webhook, not the error object)
        │
        ▼
┌───────────────────────┐   reason-string lookup + step signal + mandate precedence
│ diagnosis/            │──▶ resolves the majority with zero API spend
│ deterministic.ts      │    returns null on unrecognised AND on unexplained declines
└───────────────────────┘
        │ null
        ▼
┌───────────────────────┐   only genuine ambiguity gets here. zod-validated.
│ diagnosis/llm.ts      │   cached per body of evidence. never touches arithmetic.
└───────────────────────┘   a bad reply escalates rather than being repaired.
        │
        ▼
┌───────────────────────┐   cause → recoverability → ranked candidate actions
│ domain/policy.ts      │   deterministic. owns the null-diagnosis branch too.
└───────────────────────┘
        │  proposes; never executes
        ▼
┌───────────────────────┐   8 cited rules. Enforces on a cause IT derives,
│ domain/compliance.ts  │   not on the strategy's claim. Refusals recorded.
└───────────────────────┘
        │
   ┌────┴─────┐
permitted   refused ──▶ next candidate, or the triage queue
   │
   ▼
sim/world.ts  ──▶ ledger (trigger, diagnosis, enforcement cause, every ruling, outcome)
   │
   ▼
harness/score.ts  ──▶ invariants, then the comparison
```

**Three structural guarantees, each enforced rather than intended:**

1. **No strategy can see hidden truth.** Not via imports (tested), not via the shared
   input type (no field exists), and not via the prompt (tested). The oracle is the one
   sanctioned exception and is confirmed to still be reading truth.
2. **No proposal becomes an action without adjudication.** Strategies return candidates;
   only the engine touches the world. There is no path to bypass compliance.
3. **The guardrails enforce on facts, not opinions.** The engine derives the enforcement
   cause independently, so a strategy cannot escape a rule by staying silent — which is
   what lets the non-diagnosing baseline be governed at all.

**The model never does arithmetic.** Attempt counting, notice windows, funding-day maths
and every rupee are deterministic code. The model returns a cause, a confidence and a
sentence.

**A run refuses to report** if any invariant fails: a case over four attempts, money above
the charge, a strategy beating the oracle, or a message reaching a withdrawn-consent
customer. The failure mode here is not a crash, it is a believable wrong number.

## 7. Tech stack

| Layer      | Choice                                                        | Why                                                        |
| ---------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| Language   | TypeScript (strict)                                           | One language across harness and UI                         |
| Runner     | `tsx` CLI                                                     | Batch harness needs no server                              |
| AI         | OpenAI `gpt-5.4-mini`                                         | Diagnosis only, on the ambiguous minority                  |
| Validation | `zod`                                                         | Structured model output, validated not trusted             |
| UI         | Next.js                                                       | Dashboard, recovery ledger and shadow-only Playground      |
| Storage    | Committed JSON; non-production Postgres for durable Test Mode | Reproducible evidence separated from mock queue state      |
| Auth       | No merchant auth; bearer-protected mock runner                | Auth product remains out of scope; privileged runner gated |

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
four scored strategies including the opt-in reasoning layer, guardrails in code, append-only
benchmark ledger, confusion matrix, dashboard/recovery views, an interactive non-persistent
Playground, and a durable mock-only Test Mode connector.

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

## 10. Build plan

| Dates     | Work                                                                         | Status |
| --------- | ---------------------------------------------------------------------------- | ------ |
| Aug 20    | Spec, docs, verified decline taxonomy, architecture, decisions log           | ✅     |
| Aug 21    | Domain layer: types, regulation, causes, taxonomy, policy, compliance, state | ✅     |
| Aug 21    | Simulator: seeded rng, 13 personas, cohort generator, world model            | ✅     |
| Aug 21    | Strategies: contract, baseline, agent, oracle, leakage test                  | ✅     |
| Aug 21    | Engine, scoring with invariants, terminal report, CLI                        | ✅     |
| Aug 21    | Reasoning layer with caching and validation                                  | ✅     |
| Aug 21    | Engine and scorer tests; sensitivity analysis                                | ✅     |
| Aug 22    | Docs reconciled with the code                                                | ✅     |
| Aug 22–23 | README leading with results                                                  | ✅     |
| Aug 24–25 | Dashboard, recovery ledger and interactive shadow Playground                 | ✅     |
| Aug 26    | Freeze, final runs, figures locked                                           | ✅     |
| Aug 27–30 | Video preparation and recording                                              | Active |
| Sep 4     | Submit                                                                       | —      |

Ran roughly five days ahead of the original schedule. The slack went into fixing bugs the
tests found rather than into scope.

Never submit on deadline day.

## 11. The 5-minute video

1. **0:00–0:30** — The problem. Razorpay's own doc names four failure causes on one page
   and applies a single next-day retry to all of them. NPCI permits four attempts total.
2. **0:30–1:30** — One subscription end to end: dead card, futile-retry recognised, card
   update requested, customer responds, retry succeeds on attempt 2 of 4.
3. **1:30–2:30** — The brakes. A cause-blind retry against a dead card, refused with the
   card-network rule printed beside it. Then the leakage test failing when a `sim/` import
   is deliberately injected.
4. **2:30–3:45** — The ladder. What each layer is worth in rupees, plus the sensitivity
   table showing the ordering survives three compositions.
5. **3:45–4:30** — What went wrong. The confidence floor that punished the model for
   honestly reporting 0.34, costing five recoveries; found by measuring case by case, not
   by reading the code. And that diagnosis accuracy rose while money fell.
6. **4:30–5:00** — The bounded claim, and what is deliberately not built.

Item 5 is the one most people would cut. It stays.

## 12. Known external validation limits

The implementation is complete for its documented Test Mode scope. These external or
production-scope questions remain intentionally visible rather than being represented as
finished product work:

- [x] Confirm deadline and eligibility — 5 Sept, B.Tech 3rd year, can relocate
- [x] Verify Razorpay reason strings against the live error pages
- [x] Reconcile the docs with the code
- [ ] Confirm the college permits a 6 or 12 month off-campus internship from September
- [ ] Read the RBI E-mandate Framework 2026 primary document rather than the KPMG summary
      (attempted 26 Aug: RBI URL serves an HTML gate to automated fetch; KPMG summary
      verified to state the 24h-notice and card-migration clauses verbatim. Needs a
      manual read of the PDF.)
- [x] Reconcile `AUTOPAY_EXECUTION_WINDOWS` — corroborated by five outlets; found and fixed
      an off-by-half-hour that permitted debits during peak. Primary circular still unread.
- [ ] Confirm which webhook carries mandate revocation and pause state
- [ ] Confirm whether `payment_cancelled` is ever emitted for a mandate cancellation
- [ ] Decide whether to capture one real `payment.failed` payload in test mode for shape
      fidelity

## 13. What this is not

Not an autonomous finance department. Not a revenue forecaster. Not a churn predictor.
Not a WhatsApp blaster. One loop, one leakage type, measured honestly, with the brakes
visible.

The earlier version of this document was a vision statement listing everything a revenue
agent could eventually do. That version would have lost, because Track 03's bar opens by
rejecting exactly that: identifying problems without recovering money.
