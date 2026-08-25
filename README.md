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
| baseline  | ₹1,26,938 | 24.8%   | 28.8%   | 720      | ₹176      | 268      |
| agent     | ₹3,94,146 | 76.9%   | 71.6%   | **526**  | ₹749      | **84**   |
| agent+llm | ₹4,02,642 | 78.6%   | 73.5%   | 532      | ₹757      | 84       |
| oracle    | ₹4,65,307 | 90.8%   | 89.8%   | 573      | ₹812      | 99       |

### What each layer is worth

```
ceiling — recoverable at all           ₹5,12,385
Razorpay's documented default          ₹1,26,938     24.8%
+ reason-aware allocation              ₹3,94,146     76.9%   adds ₹2,67,208
+ reasoning layer on bare declines     ₹4,02,642     78.6%   adds     ₹8,496
+ perfect diagnosis (oracle)           ₹4,65,307     90.8%   adds    ₹62,665

still lost to diagnosis error   ₹62,665  (12.2%)
beyond any diagnosis, a policy limit   ₹47,078  (9.2%)
```

The two remainders point at different work. Diagnosis error is what a better reasoning
layer could still win. The policy limit is money no amount of correct diagnosis reaches.

### Restraint

| Strategy | Wasted attempts | Refused proposals | Hard-decline retries | No-consent messages | Delivered |
| -------- | --------------- | ----------------- | -------------------- | ------------------- | --------- |
| baseline | 81              | 159               | 91                   | 32                  | **0**     |
| agent    | 69              | 17                | **0**                | **0**               | **0**     |

Read that last pair carefully. The default _proposed_ 91 debits against declines that could
never approve and 32 messages to customers who had withdrawn consent. The compliance layer
refused all of them and **none were delivered**. The agent proposed neither. Nothing bad
happened in either case — the difference is that one of them needs the brakes.

### Does it survive a different cohort?

`npm run sensitivity` re-runs everything over three deliberately different compositions and
**exits non-zero** if the ordering breaks.

| Mix           | Ceiling   | Baseline | Agent | Oracle |
| ------------- | --------- | -------- | ----- | ------ |
| `balanced`    | ₹5,12,385 | 24.8%    | 76.9% | 90.8%  |
| `churn_heavy` | ₹3,97,334 | 19.9%    | 76.4% | 91.3%  |
| `funds_heavy` | ₹5,76,861 | 23.3%    | 81.5% | 90.3%  |

The magnitudes move, as they should — a churn-heavy cohort has less to win. The ordering
doesn't.

### Does it survive a different confidence floor?

`npm run floors` re-runs the agent at floors 0.50 / 0.70 / 0.90. The floor is the only
guardrail that is internal policy rather than a regulator's rule, so its effect is
measured rather than assumed.

| Floor | Capture | Attempts | Floor refusals |
| ----- | ------- | -------- | -------------- |
| 0.50  | 76.5%   | 525      | 0              |
| 0.70* | 76.5%   | 525      | 0              |
| 0.90  | 76.5%   | 525      | 0              |

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

**No API key. No network. No database.** Both commands are fully deterministic and exit
non-zero if any invariant fails. Every figure in this README comes from those two commands.

The reasoning layer is opt-in:

```bash
cp .env.example .env  # add OPENAI_API_KEY
npm run harness -- --llm
```

Roughly 60 model calls per run, about ₹15. It only sees failures the lookup table cannot
classify.

---

## The live connector

`POST /api/razorpay/webhook` accepts Razorpay's signed Test Mode webhooks and runs every
verified `payment.failed` through the same proposal → independent classification →
compliance adjudication path the simulator uses — shadow only, so nothing is debited or
sent. Set `RAZORPAY_CAPTURE_DIR` to also persist verified bodies to disk.

Replay any captured payload through the full pipeline locally:

```bash
npm run replay -- runs/inbound/<captured>.json
```

It recomputes the HMAC the way Razorpay signs, verifies it, prints the diagnosis, every
guardrail ruling with its citation, and what would execute. A webhook alone cannot know
consent state, attempt history, or notice records, so replay uses a labelled demo
projection — visible assumptions rather than an invisible gap.

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
regulatory budget recovers **76.9% of the achievable ceiling against 24.8% for the
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
- **The NPCI four-attempt cap and the RBI 24-hour notice come from secondary sources.** The
  primary circulars have not been read end to end. Each constant in `regulation.ts` carries
  a provenance grade: `PRIMARY`, `SECONDARY` or `UNVERIFIED`.
- **The NPCI Autopay execution windows are `SECONDARY`.** The boundaries (peak 10:00-13:00
  and 17:00-21:30 IST) are corroborated by five independent outlets, but the NPCI circular
  itself has not been read directly. An earlier version of the code had the evening window
  opening at 21:00, which permitted debits during the final half-hour of peak; that is
  fixed and pinned by a boundary test.
- **`agent+llm` figures move between runs** — roughly 78–80% of ceiling — because the model
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

235 tests. `npm run check`.---

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
