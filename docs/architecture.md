# Architecture

How Sequencer is put together, where its information comes from, and what the merchant
gains from it.

---

## 1. Where the information comes from

Sequencer does not detect, infer or predict why a payment failed. The bank says why, and
that answer is already in the payload by the time a merchant sees it.

```
Charge date arrives
        │
        ▼
Razorpay attempts the debit against the customer's card / account
        │
        ▼
The issuing bank responds with a decline code
   the bank knows the card is expired  — it is their card
   the bank knows the balance          — it is their account
        │
        ▼
Razorpay translates that into its error object
   { code, description, field, source, step, reason, metadata }
   e.g. reason: "card_expired"
        │
        ▼
Razorpay fires a webhook at the merchant  (payment.failed, subscription.pending)
        │
        ▼
Sequencer reads it
```

**Consequence.** The interesting work is not discovering the cause. It is _acting
differently depending on the cause_, which Razorpay's built-in retry does not do — it sees
a failure and schedules the next day, identically for every reason its own docs enumerate.

### What "diagnosis" means here

Deliberately narrow. Two jobs:

1. Translate a `reason` string into a recoverability class.
2. Combine it with mandate state, which the error object does not carry (see §3).

Genuine reasoning is required only inside a thin band of ambiguity that Razorpay documents
itself: `card_declined` and `payment_failed` both mean the bank declined without supplying a
cause, and `payment_timed_out` is documented under two different situations. Everything else
is a table lookup.

### How this works without a real bank

The simulator plays the bank's role. A persona holding an expired card emits `card_expired`,
exactly as an issuer would. The simulator supplies the bank's _response_; it never supplies
information a real merchant would not have. That is what keeps the measurement honest rather
than circular — and it is enforced structurally in §5.

---

## 2. What the merchant gains

| Gain                        | Mechanism                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Subscribers kept**        | An expired card today burns four retries and halts. Nobody asks the customer to update their card. Asking recovers a share of them.                 |
| **Manual work removed**     | Razorpay documents that once a subscription is halted, invoices continue to be created but are not charged — the merchant must charge them by hand. |
| **More usable attempts**    | Four attempts per mandate is a regulatory ceiling. Not spending them on impossible cases leaves them available where they work.                     |
| **Fewer network penalties** | Card networks charge for reattempting hard declines.                                                                                                |
| **Fewer complaints**        | Customers who withdrew consent stop being debited.                                                                                                  |

The harness produces the actual figures for a given cohort. No market statistics are asserted
anywhere in this project — every number in the README comes from a reproducible run.

---

## 3. Two inputs, not one

Razorpay's error taxonomy carries **no mandate information**. There is no reason string for a
revoked mandate, a paused mandate, or a debit above the authorised ceiling, because those
pages document checkout failures.

Yet the subscription retries doc names customer mandate cancellation as one of four causes of
a failed recurring charge. Mandate state therefore arrives through subscription state
transitions and webhooks, not through `reason`.

So the diagnoser takes two inputs:

```
ObservedFailure     ← the payment error object      (reason, step, source)
MandateState        ← subscription / mandate state   (active, paused, revoked, cap)
```

A classifier reading only `reason` cannot distinguish a customer who withdrew consent from a
customer whose bank was briefly unavailable — and those two have opposite correct responses.
Detail in [decline-taxonomy.md](decline-taxonomy.md) §5, rationale in
[../DECISIONS.md](../DECISIONS.md) D12.

---

## 4. The pipeline

```
ObservedFailure  +  MandateState
        │
        ▼
┌──────────────────────┐   reason-string lookup, step signal, mandate precedence
│ diagnosis/           │──▶ resolves the majority at zero cost
│ deterministic.ts     │    returns null on unrecognised reasons AND on unexplained
└──────────────────────┘    declines, because the latter is not a diagnosis either
        │ null
        ▼
┌──────────────────────┐   only genuine ambiguity reaches a model
│ diagnosis/llm.ts     │   zod-validated, cached per body of evidence
└──────────────────────┘   a malformed reply escalates; it is never repaired
        │
        ▼
   Diagnosis | null
        │
        ▼
┌──────────────────────┐   cause → recoverability → ranked candidates
│ domain/policy.ts     │   owns every branch, including the null-diagnosis one,
└──────────────────────┘   because a cleared blocker is retryable regardless of cause
        │
        ▼
   candidate actions, in preference order
        │
        ▼
┌──────────────────────┐   8 cited rules. Enforces on a cause the ENGINE derives
│ domain/compliance.ts │   from observable signals, never on the strategy's claim.
└──────────────────────┘   Refusals are returned, not thrown.
        │
   ┌────┴──────────┐
permitted        refused ──▶ next candidate, else the triage queue
   │
   ▼
sim/world.ts (what really happened)
   │
   ▼
ledger: trigger · diagnosis · enforcement cause · every ruling · outcome
   │
   ▼
harness/score.ts → invariants first, then baseline vs agent vs oracle
```

**The model never does arithmetic.** Attempt counting, budget maths, notice-window
calculation, funding-day arithmetic and every rupee are deterministic code. The model's
sole output is a cause, a confidence and a rationale.

### Three guarantees, enforced rather than intended

**1. No strategy can see hidden truth.** Not through imports — a test reads every file in
`src/strategies/` and `src/diagnosis/` and fails on any `sim/` import. Not through the
shared input type, which has no field for it. Not through the prompt, which is separately
tested for the words that would leak it. The oracle is the single sanctioned exception, and
a further test confirms it _is_ still reading truth, so the ceiling cannot quietly decay
into a second agent run.

**2. No proposal becomes an action without adjudication.** `Strategy.propose()` returns
candidates. Only the engine touches the world. There is no code path by which forgetting a
call bypasses compliance — a stronger guarantee than a convention.

**3. Guardrails enforce on facts, not opinions.** The engine derives `enforcementCause`
itself from observable signals and passes the strategy's confidence separately. So a
strategy cannot escape a cause-based rule by staying silent, which is what allows the
non-diagnosing baseline to be governed at all. Only the internal confidence floor consults
the strategy's own claim.

### Timing anchors to the failure, never to now

Every retry delay is computed from the moment of failure or the fixed charge date. A delay
measured from now is recomputed on each consultation, so waking at the scheduled moment
produces a fresh delay and the retry recedes for ever. This caused two separate bugs — 38
bank outages that never retried, and salary-cycle cases that jumped a month ahead each time
they woke. Both looked like decisions and were arithmetic. See ../DECISIONS.md D19.

### The pre-debit notice is infrastructure

The engine issues the RBI-required 24-hour notice when a case enters recovery, identically
for every strategy. It is not a policy choice: Razorpay's documented retry does not expose
notice control to a retry policy, so holding a strategy responsible for it would measure
the wrong thing and would imply the shipped default is non-compliant. Policies schedule
around its maturity. See ../DECISIONS.md D16.

## 5. Layout and boundaries

```
src/
  config.ts                 seeds, thresholds, cohort sizes

  domain/                   WHAT IS TRUE — pure. no I/O, no clock, no randomness.
    types.ts                Paise, ObservedFailure, ObservableSubscription, Action, Diagnosis
    causes.ts               DeclineCause + Recoverability + the mapping
    taxonomy.ts             reason string → cause (mirrors decline-taxonomy.md)
    policy.ts               cause → action
    compliance.ts           the 8 cited guardrails

  sim/                      THE WORLD — owns hidden truth
    rng.ts                  seeded PRNG
    personas.ts             hidden personalities + outcome functions
    cohort.ts               generate N subscriptions
    world.ts                apply an action, return what really happened

  strategies/               THE DECIDERS — one shared interface
    strategy.ts             the interface
    baseline.ts             Razorpay-default calendar retry
    agent.ts                reason-aware allocation
    oracle.ts               perfect diagnosis — the only file permitted to read truth

  diagnosis/
    deterministic.ts        table lookup
    llm.ts                  OpenAI + zod, ambiguous cases only

  ledger/ledger.ts          append-only decision log

  harness/
    run.ts                  CLI entry
    engine.ts               tick loop
    score.ts                metrics + confusion matrix
    report.ts               terminal tables
```

### Rule 1 — the leakage boundary is a folder boundary

`strategies/` must never import from `sim/`. If a strategy could read a persona, every
reported number is void.

Enforced by a test that reads each strategy source file and asserts no import of `../sim`
exists. The central claim of the project is therefore a passing test rather than an assurance.

`oracle.ts` is the deliberate, single exception: it reads truth on purpose, because its job is
to establish the achievable ceiling, not to compete.

### Rule 2 — `domain/` is pure

No file access, no `Date.now()`, no randomness. Time is always a parameter. Every rule is
testable in isolation and identical inputs always produce identical outputs.

### Rule 3 — one strategy interface, so comparison is structural

```ts
interface Strategy {
  readonly name: string;
  decide(input: {
    sub: ObservableSubscription;
    failure: ObservedFailure;
    mandateState: MandateState;
    now: Millis;
  }): Promise<Decision>;
}
```

The harness cannot give one strategy an advantage, because it only knows this shape. Fair
comparison is a property of the types, not a promise in the README.

### Rule 4 — dependencies point one way

Everything may import `domain/`. `domain/` imports nothing from above it. The rules stay
auditable in isolation.

---

## 6. Reproducibility

`npm install && npm run harness` reproduces every reported number with **no API key and no
external services**, using the deterministic diagnoser. The LLM layer is additive and is
measured against that baseline rather than required by it.

Seeded RNG throughout. Tuning happens on one cohort; final figures are reported on a held-out
cohort generated from a different seed.

---

## 7. Two planes, one decision core

The deterministic benchmark remains a CLI over committed JSON artifacts. It requires no
database, API key or external service, which keeps every reported deterministic result
reproducible with `npm run harness`.

The Next.js demonstration plane reuses the same proposal → independent classification →
compliance adjudication core through three deliberately separated entry points:

```
Interactive Playground
  └─ POST /api/demo/adjudicate
       └─ shadow decision only — no persistence, queue or execution

Signed Razorpay Test Mode webhook
  └─ verify exact raw-body HMAC
       └─ durable Postgres event receipt
            └─ shadow decision + first permitted action
                 └─ atomic mock-action enqueue
                      └─ bearer-protected leased runner
                           └─ retained simulated outcome
```

The durable path uses a dedicated non-production Postgres/Neon database and fails closed
outside development/Vercel Preview or without explicit database confirmation. Signed
ingestion additionally requires Test Mode and its HMAC secret; the protected runner
additionally requires the `mock` executor and its bearer secret. It provides idempotency,
lease fencing, bounded retries and attempt history, but it does not call Razorpay payment
APIs, send customer messages or move money. There is still no merchant authentication
product, multi-tenancy or live-action adapter; those remain outside the submission boundary.
The original service-free benchmark decision and its later connector isolation are recorded
in [../DECISIONS.md](../DECISIONS.md) D8.
