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

**Consequence.** The interesting work is not discovering the cause. It is *acting
differently depending on the cause*, which Razorpay's built-in retry does not do — it sees
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
exactly as an issuer would. The simulator supplies the bank's *response*; it never supplies
information a real merchant would not have. That is what keeps the measurement honest rather
than circular — and it is enforced structurally in §5.

---

## 2. What the merchant gains

| Gain | Mechanism |
|---|---|
| **Subscribers kept** | An expired card today burns four retries and halts. Nobody asks the customer to update their card. Asking recovers a share of them. |
| **Manual work removed** | Razorpay documents that once a subscription is halted, invoices continue to be created but are not charged — the merchant must charge them by hand. |
| **More usable attempts** | Four attempts per mandate is a regulatory ceiling. Not spending them on impossible cases leaves them available where they work. |
| **Fewer network penalties** | Card networks charge for reattempting hard declines. |
| **Fewer complaints** | Customers who withdrew consent stop being debited. |

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
   ObservedFailure + MandateState
              │
              ▼
   ┌──────────────────────┐   reason-string lookup + step/source signals
   │  diagnosis/          │──▶ resolves the majority at zero cost
   │  deterministic.ts    │
   └──────────────────────┘
              │ null = unrecognised, never a guess
              ▼
   ┌──────────────────────┐   only the documented ambiguities reach a model
   │  diagnosis/llm.ts    │   returns cause + confidence + rationale
   └──────────────────────┘   zod-validated. never touches arithmetic.
              │
              ▼
        Diagnosis { cause, recoverability, confidence, reasoning, source }
              │
              ▼
   ┌──────────────────────┐   cause → recoverability → exactly one action
   │  domain/policy.ts    │   deterministic. no model in this path.
   └──────────────────────┘
              │
              ▼
        proposed Action
              │
              ▼
   ┌──────────────────────┐   8 rules, each carrying its source citation
   │ domain/compliance.ts │   permit, or refuse with a reason
   └──────────────────────┘
              │
      ┌───────┴────────┐
   permitted         refused
      │                │
      ▼                ▼
   sim/world.ts    triage queue
   (what really
    happened)
      │
      ▼
   ledger/ (append-only: trigger, diagnosis, proposal, ruling, outcome)
      │
      ▼
   harness/score.ts → baseline vs agent vs oracle
```

**The model never does arithmetic.** Attempt counting, budget maths, notice-window
calculation and date logic are all deterministic code. The model's sole output is a cause, a
confidence and a rationale.

---

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

## 7. What is deliberately absent

No database, no authentication, no HTTP API. The core is a CLI harness; the UI is three
read-only screens over its JSON output. Rationale in [../DECISIONS.md](../DECISIONS.md) D8.
