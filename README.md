# Sequencer

**Regulation gives you four attempts to collect a failed auto-debit. Razorpay's documented
default spends them on a calendar. Sequencer spends them only where they can succeed — and
refuses to spend them where they can't.**

Submission for the [Razorpay AI Buildathon](https://razorpay.com/buildathon), Track 03 —
AI Revenue Recovery.

---

## The result

300 simulated failed subscriptions. Holdout cohort, seed `19980417`, never used for tuning.

```
at risk       ₹6,55,900   300 cases
recoverable   ₹5,12,385   215 cases   (78.1% of money, 71.7% of cases)
```

| Strategy  | Recovered | % money | % cases | Attempts | ₹/attempt | Messages |
| --------- | --------- | ------- | ------- | -------- | --------- | -------- |
| baseline  | ₹1,24,939 | 24.4%   | 28.4%   | 716      | ₹175      | 268      |
| agent     | ₹3,92,147 | 76.5%   | 71.2%   | **525**  | ₹747      | **84**   |
| agent+llm | ₹4,10,939 | 80.2%   | 74.9%   | 535      | ₹768      | **84**   |
| oracle    | ₹4,63,308 | 90.4%   | 89.3%   | 572      | ₹810      | 99       |

Every figure on this page is read from the run artifacts committed to `runs/` —
the same files the dashboard renders. `agent+llm` moves ±1 point between runs
because the model runs at temperature 0.2; the other three are deterministic.

### What each layer is worth

```
ceiling — recoverable at all           ₹5,12,385
Razorpay's documented default          ₹1,24,939     24.4%
+ reason-aware allocation              ₹3,92,147     76.5%   adds ₹2,67,208
+ reasoning layer on bare declines     ₹4,10,939     80.2%   adds  ₹18,792
+ perfect diagnosis (oracle)           ₹4,63,308     90.4%   adds  ₹52,369

still lost to diagnosis error   ₹52,369  (10.2%)
beyond any diagnosis, a policy limit   ₹49,077  (9.6%)
```

The two remainders point at different work. Diagnosis error is what a better reasoning
layer could still win. The policy limit is money no amount of correct diagnosis reaches.

### Restraint

| Strategy | Wasted attempts | Refused proposals | Hard-decline retries | No-consent messages | Delivered |
| -------- | --------------- | ----------------- | -------------------- | ------------------- | --------- |
| baseline | 81              | 161               | 91                   | 32                  | **0**     |
| agent    | 69              | 18                | **0**                | **0**               | **0**     |

Read that last pair carefully. The default _proposed_ 91 debits against declines that could
never approve and 32 messages to customers who had withdrawn consent. The compliance layer
refused all of them and **none were delivered**. The agent proposed neither. Nothing bad
happened in either case — the difference is that one of them needs the brakes.

### Does it survive a different cohort?

`npm run sensitivity` re-runs everything over three deliberately different compositions and
**exits non-zero** if the ordering breaks.

| Mix           | Ceiling   | Baseline | Agent | Oracle |
| ------------- | --------- | -------- | ----- | ------ |
| `balanced`    | ₹5,12,385 | 24.4%    | 76.5% | 90.4%  |
| `churn_heavy` | ₹3,97,334 | 19.4%    | 75.9% | 90.8%  |
| `funds_heavy` | ₹5,76,861 | 23.0%    | 81.2% | 90.0%  |

The magnitudes move, as they should — a churn-heavy cohort has less to win. The ordering
doesn't.

### Does it survive a different confidence floor?

`npm run floors` re-runs the agent at floors 0.50 / 0.70 / 0.90. The floor is the only
guardrail that is internal policy rather than a regulator's rule, so its effect is
measured rather than assumed.

| Floor  | Capture | Attempts | Floor refusals |
| ------ | ------- | -------- | -------------- |
| 0.50   | 76.5%   | 525      | 0              |
| 0.70\* | 76.5%   | 525      | 0              |
| 0.90   | 76.5%   | 525      | 0              |

Identical rows are the finding, not a bug: on this path the deterministic diagnoser claims
only 0.95 and 0.99, so the shipped default does no silent work and the conclusion cannot
depend on it. A fixed-confidence probe proves the option reaches compliance rather than
the zeros being an accident of a disconnected knob. `npm run floors -- --llm` measures the
regime where the floor does bind — model confidences span 0..1.

---

## Reproduce it

```bash
npm install
npm run harness       # the table above
npm run sensitivity   # the three-mix comparison
npm run floors        # the confidence-floor comparison
```

**No API key. No network. No database.** These deterministic benchmark commands exit
non-zero if an invariant fails. Every reported deterministic figure is read from their run
artifacts.

The reasoning layer is opt-in:

```bash
cp .env.example .env  # add OPENAI_API_KEY
npm run harness -- --llm
```

Roughly 60 model calls per run, about ₹15. It only sees failures the lookup table cannot
classify.

---

## Test Mode connector and durable mock loop

The connector is a separate, server-only demonstration path. It accepts signed Razorpay
**Test Mode** webhooks, persists an idempotent decision receipt, atomically queues only the
first compliance-permitted `wouldExecute` action, and records a mock execution outcome. It
does not debit money, call Razorpay's payment APIs, send a message, or contact a customer.

### Configure and migrate

Copy `.env.example` to `.env.local` and set `RAZORPAY_WEBHOOK_SECRET`, `DATABASE_URL`, and a
long random `CRON_SECRET`. Keep `RAZORPAY_MODE=test`, `TEST_MODE_EXECUTOR=mock`, and
`TEST_MODE_DATABASE=confirmed-non-production`; the routes and migration command fail closed
without those explicit assertions. They also reject Vercel production deployments and
non-Vercel `NODE_ENV=production` runtimes. These variables are server-only and must never use
a `NEXT_PUBLIC_` prefix. Use a dedicated disposable or non-production Postgres/Neon
database, not a database that could contain production workloads.

After confirming the target is safe to mutate, apply the queue schema:

```bash
npm run db:migrate
```

This applies `db/migrations/001_test_mode_action_queue.sql` as separate statements in one
Neon HTTP transaction. It creates durable webhook receipts, current action state, and
retained attempt history. The signed webhook returns `503` rather than falling back to
process memory when durable storage is unavailable.

### Signed webhook flow

Configure Razorpay Test Mode to send webhooks to `POST /api/razorpay/webhook`. For every
verified body the endpoint:

1. verifies the HMAC before parsing or capturing the body;
2. hashes the provider event ID into a stable receipt key and retains the body digest to
   detect a same-ID/different-body conflict;
3. claims the receipt, runs proposal → independent classification → compliance adjudication,
   and atomically finalizes the receipt with at most one permitted action;
4. returns `queuedAction: { id, status, dueAt }` when work was queued.

A redelivery of the same event returns the persisted status and action metadata with
`duplicate: true`; a body conflict returns `409`; active ownership or a retryable processing
failure returns `503` with `Retry-After`. Unsupported events are durably acknowledged but do
not create actions. The public playground remains read-only and never enqueues work.

A webhook alone cannot know consent state, attempt history, or notice records, so this path
uses the labelled demo projection shown in its response. That is a visible simulation
boundary, not merchant production state.

### Run due mock actions

Invoke the protected runner manually after replacing the placeholder with the exact
server-side `CRON_SECRET` value:

```bash
curl --request POST \
  --header 'Authorization: Bearer replace-with-CRON_SECRET' \
  http://localhost:3000/api/test-mode/actions/run
```

`GET` and `POST` are both supported for manual or cron invocation. Each call lease-claims up
to ten due rows with `FOR UPDATE SKIP LOCKED`, records an attempt, and marks it succeeded,
retryable with bounded backoff, or dead after the configured attempt limit. Lease-token and
unexpired-lease predicates prevent replaced or expired workers from committing outcomes.

Every outcome is explicitly simulated. In particular, `RETRY_SCHEDULED` records a
`mock_wake_for_reconsideration` event so policy and context can be checked again; it does
**not** claim a debit occurred. Request/update/notification actions only record mock intent
and do not send anything.

Set `RAZORPAY_CAPTURE_DIR` only when local fixture capture is useful. Captured files are not
the durable queue and may disappear on serverless filesystems. Replay a captured payload
locally through signature verification and adjudication with:

```bash
npm run replay -- runs/inbound/<captured>.json
```

---

## What it does

For every failed charge, four stages:

**Detect** — read the failure as the merchant sees it. Razorpay's documented error object:
`code`, `reason`, `source`, `step`, `description`.

**Diagnose** — classify into one of fourteen causes, and commit to a **recoverability
class** before choosing anything. Takes two inputs, because Razorpay's error taxonomy
carries no mandate information — that arrives by webhook.

| Recoverability    | Meaning                               | Right response        |
| ----------------- | ------------------------------------- | --------------------- |
| `RETRY_VIABLE`    | An attempt can succeed                | Spend one, timed      |
| `RETRY_FUTILE`    | No attempt can **ever** succeed       | Change the instrument |
| `RETRY_FORBIDDEN` | Retrying is a consent or risk problem | Stop                  |
| `WAIT`            | Resolves on its own                   | Do nothing            |
| `NEEDS_HUMAN`     | Genuinely unknowable                  | Escalate              |

**Intervene** — one action from nine. `WAIT` and `STOP` are first-class, not fallbacks: on a
paused mandate, waiting collects the money for free; on a revoked one, stopping is the only
correct move.

**Recover and learn** — observe, write to an append-only ledger, adjust.

### The gap this exploits

Razorpay's
[subscription retries doc](https://razorpay.com/docs/payments/subscriptions/payment-retries/)
opens by naming four distinct failure causes — expired card, blocked card, insufficient
balance, cancelled mandate — then applies **one policy to all four**: retry the following
day, shifted for bank holidays.

Those four don't have the same recoverability. One of them cannot be recovered by retrying
at all. Meanwhile
[NPCI permits one attempt plus three retries](https://ibsintelligence.com/ibsi-news/npci-tightens-upi-api-rules-to-boost-resilience-fraud-controls/),
so the budget spent on impossible outcomes is a budget gone.

**And where the default is right:** a daily transaction limit resets overnight, so
next-day retry is exactly correct for it. Stated because a critique claiming the incumbent
is always wrong invites someone to go looking for the counterexample.

---

## The claim, precisely

**Not** "Sequencer recovers three times more than Razorpay." Agent Studio ships a
Subscription Recovery agent today; a threefold gap over a production payments platform
would not be a plausible claim.

**The claim:** on a 300-case simulated cohort, reason-aware allocation of a four-attempt
regulatory budget recovers **76.5% of the achievable ceiling against 24.4% for the
documented default retry schedule**, on **27% fewer attempts**, without proposing a single
message to a withdrawn-consent customer, and the ordering holds across three cohort
compositions.

The baseline models the documented retry _schedule_ — faithfully, including the failure
email with a card-change link that Razorpay's docs describe. It is not a model of
Razorpay's full recovery capability.

---

## Honest limitations

- **Persona response rates are invented.** How likely a customer is to replace a dead card
  when asked is our assumption, not data. This is the softest input in the project and the
  reason the sensitivity analysis exists.
- **The NPCI four-attempt cap and Autopay windows trace to primary circular
  UPI/OC/223/2025-26 (21 May 2025)**, whose operative sentence we verify via verbatim
  quotation; the circular's own download is access-gated, so it has still not been read end
  to end. Each constant in `regulation.ts` carries a provenance grade: `PRIMARY`,
  `SECONDARY` or `UNVERIFIED`.
- **The RBI E-mandate Framework constants come from the KPMG summary** of the framework
  notified 21 April 2026 (24h notice and card-migration clauses confirmed verbatim there;
  the ₹15,000/₹1,00,000 ceilings predate it and remain the softest citations). The RBI PDF
  itself has not been read end to end.
- **`agent+llm` figures move between runs** — roughly 79–81% of ceiling — because the model
  runs at temperature 0.2. The three deterministic strategies are byte-identical run to run.
- **Money is concentrated.** One persona must exceed the ₹15,000 authentication ceiling by
  regulation, so it is inherently ~30x a typical subscription. Case counts are reported
  beside money throughout for exactly this reason.
- **No real money moves.** Deliberate: the bar asks for measured recovery across a batch,
  and you cannot measure a batch with live payments — only demo one.

---

## How the numbers are kept honest

Three guarantees, each a passing test rather than an assurance.

**No strategy can see the hidden truth.** Not via imports — a test reads every file in
`src/strategies/` and `src/diagnosis/` and fails on any `sim/` import. Not via the shared
input type, which has no field for it. Not via the prompt, tested separately for the words
that would leak it. The oracle is the one sanctioned exception, and a further test confirms
it _is_ still reading truth, so the ceiling can't quietly decay into a second agent run.

**No proposal becomes an action without adjudication.** Strategies return ranked candidates;
only the engine touches the world. There is no path where forgetting a call bypasses
compliance.

**Guardrails enforce on facts, not opinions.** The engine derives the enforcement cause
itself from observable signals. A strategy cannot escape a cause-based rule by staying
silent — which is what lets the non-diagnosing baseline be governed at all.

Plus **invariants that refuse to report**: a case over four attempts, money above the
charge, a strategy beating the oracle, a message reaching a withdrawn-consent customer.
The failure mode of a project like this isn't a crash, it's a believable wrong number.

288 tests. `npm run check`.

---

## Two findings worth reading

**A guardrail punished honesty.** The reasoning layer initially made recovery _worse_ —
better diagnosis accuracy, 88.0% against 86.3%, and less money. Measuring case by case
showed every loss was a plan upgrade whose retry never fired: once the customer
re-authorised, the cap rose, the classifier could no longer see the problem, and the model
honestly answered "ambiguous, 0.34 confidence" — at which point the confidence floor refused
the retry. The plain agent, having said nothing at all, sailed through. **A low-confidence
answer was strictly worse than no answer.** ([D20](DECISIONS.md))

**Timing anchored to `now` recedes for ever.** A six-hour retry delay recomputed on every
consultation never arrives. 38 bank outages never retried. Both bugs looked like policy
decisions and were arithmetic. ([D19](DECISIONS.md))

---

## Layout

```
src/
  domain/       the rules — pure, no clock, no randomness, no I/O
  sim/          the world — owns hidden truth, all dice rolled at generation
  strategies/   the deciders — propose only, one shared contract
  diagnosis/    lookup table, then a model on what it can't resolve
  harness/      engine, scoring, invariants, reports, CLI
```

| Document                                             | What's in it                                      |
| ---------------------------------------------------- | ------------------------------------------------- |
| [Idea.md](Idea.md)                                   | Full spec, measured results, scope                |
| [DECISIONS.md](DECISIONS.md)                         | 21 decisions, each with what was rejected and why |
| [docs/architecture.md](docs/architecture.md)         | Data provenance, pipeline, boundaries             |
| [docs/decline-taxonomy.md](docs/decline-taxonomy.md) | Every reason string, verified against the docs    |

---

## Positioning

Razorpay already ships subscription retries, and Agent Studio ships a Subscription Recovery
agent. This has to be addressed rather than dodged.

- **The built-in retry** is schedule-driven: next day, shifted for holidays, identical for
  all four causes its own docs enumerate.
- **Agent Studio's Subscription Recovery** applies retry logic and customer nudges.
- **Sequencer** is budget-driven. It treats the four NPCI-permitted attempts as a scarce
  resource, allocates them by cause, refuses to spend them where they cannot work, and
  proves the allocation on a measured batch against the documented default.

"Mandate retry sequencer" is one of Razorpay's own listed example directions for Track 03.
This is that, taken to measured depth.
