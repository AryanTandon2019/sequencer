# Sequencer — Simple Project Guide

## 1. What is Sequencer?

Sequencer is a **reason-aware recovery system for failed subscription payments**.

When a recurring payment fails, a normal recovery system may simply wait and retry again. Sequencer first asks:

> Why did this payment fail, and can another attempt actually succeed?

It then chooses the safest useful response:

- Retry now or later when a retry can work.
- Ask the customer to update an expired or blocked card.
- Ask the customer to reauthorize the mandate.
- Ask for additional authentication when required.
- Wait when the problem may resolve by itself.
- Stop when consent has been withdrawn.
- Send the case to a human when the reason is unknown.

The main idea is simple: **do not waste limited payment attempts on failures that another retry cannot fix.**

---

## 2. What problem does it solve?

Recurring payments fail for many different reasons. Each reason needs a different response.

| Failure reason | Useful response |
| --- | --- |
| Temporary bank outage | Retry later |
| Insufficient balance | Retry near the expected funding date |
| Daily payment limit reached | Retry the next day |
| Expired card | Ask for a new card |
| Charge above the mandate limit | Ask for mandate reauthorization |
| Additional authentication required | Ask the customer to authenticate |
| Paused mandate | Wait |
| Revoked mandate | Stop and do not contact the customer |
| Fraud-related decline | Stop |
| Bank gives no useful reason | Escalate to a human |

A fixed calendar retry treats these failures too similarly. That can waste attempts, annoy customers, create compliance risks, and miss recoverable payments.

Sequencer tries to use every retry only when evidence says it is worth spending.

---

## 3. How does Sequencer work?

The complete flow is:

```text
Payment fails
    ↓
Read the failure and mandate evidence
    ↓
Diagnose the likely cause
    ↓
Classify whether recovery is possible
    ↓
Propose actions in order of preference
    ↓
Check every action against compliance rules
    ↓
Choose the first permitted action
    ↓
Execute only inside the simulator
    ↓
Save the full decision in an audit ledger
```

A strategy cannot directly charge or message anyone. It can only propose actions. A separate compliance layer decides whether those actions are allowed.

---

## 4. Easy examples

### Temporary balance problem

```text
Payment fails because the balance is low
→ Sequencer classifies it as retryable
→ checks the customer’s previous funding pattern
→ schedules a retry near the likely funding date
→ compliance checks the notice and attempt budget
→ the synthetic retry may recover the payment
```

### Expired card

```text
Payment fails because the card expired
→ another identical retry cannot work
→ Sequencer does not waste a retry
→ asks the customer to update the card
→ considers retrying only after the card is updated
```

### Revoked mandate

```text
Payment fails
→ mandate data says consent was revoked
→ retry is refused
→ customer messages are also refused
→ Sequencer stops the case
```

### Unknown bank decline

```text
Payment fails but the bank gives no useful reason
→ Sequencer refuses to guess
→ sends the case to a human for review
```

---

## 5. The five recovery classes

Sequencer places each failure into one of five groups.

### `RETRY_VIABLE`

A retry may work if it happens at the correct time.

Examples:

- Insufficient funds
- Temporary bank outage
- Temporary daily limit

### `RETRY_FUTILE`

Repeating the same payment cannot solve the problem. Something must change first.

Examples:

- Expired or blocked card
- Card not enabled for recurring payments
- Wrong account
- Invalid UPI ID
- Mandate limit exceeded
- Additional authentication required

### `RETRY_FORBIDDEN`

Retrying creates a consent or risk problem.

Examples:

- Fraud-related decline
- Revoked mandate

### `WAIT`

The issue may resolve without intervention.

Example:

- Temporarily paused mandate

### `NEEDS_HUMAN`

The available evidence is not enough to decide safely.

Example:

- Unexplained bank decline

---

## 6. Actions Sequencer can propose

Sequencer supports these actions:

- Retry immediately
- Schedule a retry
- Request a card update
- Request mandate reauthorization
- Request additional authentication
- Send a pre-debit notification
- Wait
- Stop
- Escalate to the merchant

Only retry actions consume payment attempts. Customer-facing actions also pass through consent and confidence checks.

---

## 7. Safety and compliance

Every proposed action is independently checked before it can be selected.

The main checks are:

1. **Attempt limit** — do not exceed one original charge plus three retries.
2. **Pre-debit notice** — do not debit before the required notice has matured.
3. **Hard-decline protection** — do not retry an expired or blocked card until the blocker is fixed.
4. **UPI execution window** — check whether a UPI Autopay debit falls in a permitted window.
5. **Mandate limit** — do not debit more than the customer authorized.
6. **Additional authentication** — do not silently debit above the applicable authentication threshold.
7. **Revoked consent** — do not debit or send dunning messages after consent is gone.
8. **Confidence floor** — do not autonomously touch money or contact a customer when diagnosis confidence is below `0.70`.

Every refused action is saved with:

- The rule that blocked it
- The rule’s citation
- A simple explanation

This makes the safety controls visible instead of merely claiming that the system is safe.

---

## 8. Strategies being compared

The same 300 synthetic failures are evaluated with three strategies.

### Calendar baseline

This models a narrow documented calendar-retry policy:

```text
Failure
→ send a card-change message
→ retry the next day
→ continue until attempts are exhausted
```

It is a comparison against one documented policy, not against every feature Razorpay provides.

### Sequencer agent

```text
Observe the failure
→ diagnose the cause
→ choose a reason-specific recovery plan
→ pass every action through compliance
```

### Perfect-diagnosis oracle

The oracle receives the correct hidden cause from the simulator.

It is not a real deployable strategy. It shows the highest result the same recovery policy could achieve if diagnosis were perfect.

---

## 9. The simulator

The current recovery outcomes are simulated. No real customer is charged or messaged.

The simulator creates 300 subscription failures with situations such as:

- Salary-cycle balance shortage
- Chronic shortage
- Expired or replaced card
- Silent churn
- Deliberate cancellation
- Temporary mandate pause
- Bank outage
- Plan upgrade above the mandate limit
- Additional-authentication requirement
- Fraud flag
- Unexplained decline

Some cases intentionally hide the real cause. The strategy only sees normal observable payment evidence, not the hidden answer.

Tests prevent strategy files from importing hidden simulator truth.

---

## 10. Why the simulation is reproducible

The simulator uses seeded randomness.

The tracked holdout uses:

```text
Seed: 19980417
Cases: 300
Mix: balanced
Duration: 45 simulated days
Clock step: one hour
```

Running the same code with the same seed produces the same cohort and results. This allows reviewers to verify the evidence instead of trusting screenshots.

---

## 11. Current tracked results

The tracked JSON result files are the source of truth.

### Shared cohort

```text
300 failed subscriptions
₹6,55,900 total money at risk
₹5,12,385 theoretically recoverable
215 recoverable cases
```

### Modeled calendar baseline

```text
₹1,24,939 recovered
61 cases recovered
24.38% of recoverable money
716 attempts used
81 wasted attempts
268 customer contacts
0 harmful contacts delivered
```

### Sequencer

```text
₹3,92,147 recovered
153 cases recovered
76.53% of recoverable money
525 attempts used
69 wasted attempts
84 customer contacts
0 harmful contacts delivered
```

### Perfect-diagnosis oracle

```text
₹4,63,308 recovered
192 cases recovered
90.42% of recoverable money
572 attempts used
0 harmful contacts delivered
```

### Simple comparison

Against the modeled calendar policy, Sequencer:

```text
Recovered ₹2,67,208 more
Used 191 fewer attempts
Used about 26.7% fewer attempts
Sent 184 fewer customer contacts
Delivered zero harmful contacts
```

These numbers are **simulated results**, not production performance or real merchant revenue.

---

## 12. What the web application shows

### Homepage `/`

The homepage explains the idea and shows:

- The tracked simulation results
- Razorpay Test Mode connector status
- A baseline-versus-Sequencer replay
- Recovery comparisons
- Links to the decision ledger

The animation replays saved results. It does not process live customers in the browser.

### Cases page `/cases`

This behaves like an operations queue. It allows users to:

- Search cases
- Switch between strategies
- Find recovered cases
- Find customer-action cases
- Find guardrail blocks
- Find missed recovery opportunities

### Case audit `/cases/[id]`

This page explains one synthetic subscription in detail:

- Payment attempts
- Diagnosis and confidence
- Proposed actions
- Compliance refusals
- Rule citations
- Final action
- Comparison between baseline, Sequencer and oracle

### Razorpay webhook `/api/razorpay/webhook`

- `GET` returns a public-safe connector status.
- `POST` receives signed Razorpay Test Mode events.

---

## 13. Razorpay Test Mode integration

The screenshots created during setup prove:

- Razorpay Test Mode was enabled.
- The Sequencer Vercel webhook was registered and enabled.
- A ₹1 Test Mode payment was intentionally failed.
- Razorpay produced a failure event and delivered it to Sequencer.
- No real ₹1 payment occurred.

The webhook flow is:

```text
Razorpay Test Mode event
    ↓
Check that the connector is in Test Mode
    ↓
Enforce a 256 KiB request limit
    ↓
Read the exact raw request bytes
    ↓
Verify the HMAC-SHA256 signature
    ↓
Parse and validate the payload with Zod
    ↓
Normalize the supported event
    ↓
Check the process-local duplicate window
    ↓
Return ignored, duplicate, or needs_context
```

The connector understands:

- `payment.failed`
- `subscription.pending`

The test used a normal Payment Link rather than a recurring subscription. It proves secure provider-to-Sequencer delivery, but it does not provide the subscription, mandate, consent and billing history required for a complete recovery decision.

The safe behavior is:

```text
Signed event received
→ not enough recurring-subscription context
→ no action executed
```

---

## 14. Razorpay webhook security

The webhook includes these protections:

- Works only in Razorpay Test Mode.
- Reads exact raw bytes before parsing.
- Verifies HMAC-SHA256 signatures.
- Uses timing-safe signature comparison.
- Rejects oversized payloads.
- Rejects malformed signatures and invalid JSON.
- Validates payload structure using Zod.
- Safely ignores unsupported events.
- Never returns secret values in its status response.
- Contains no API that charges money or sends messages.

Duplicate event keys are remembered only inside one running server process, with a maximum of 1,000 entries. This is suitable for the current Test Mode demo, but not for Live Mode because the memory resets when Vercel restarts or redeploys.

The cancelled Neon database work is not part of the current application.

---

## 15. What is real and what is simulated?

### Real today

- Deployed Next.js application
- Razorpay Test Mode account
- Public HTTPS webhook
- Razorpay-generated Test Mode failure
- Webhook signature verification
- Request and payload validation
- Event normalization
- Recovery policy and compliance code
- Reproducible evaluation harness
- Decision audit interface

### Simulated today

- Customers and subscriptions
- Bank and payment outcomes
- Customer responses
- Retry execution
- Messages
- Recovered revenue
- Recovery percentages
- All 300-case outcomes

### Not currently included

- Razorpay Live Mode
- Real charges
- Real customer messages
- Merchant onboarding
- Authentication
- Multiple merchants or tenants
- Durable event database
- Production event storage
- Production payment executor
- Real merchant outcome data

Sequencer is currently a **strong technical prototype**, not a production SaaS platform.

---

## 16. Why could this help Razorpay?

### Better use of limited attempts

Sequencer spends attempts only when another debit may succeed.

### Higher potential recovery

Temporary failures receive reason-specific timing. Structural failures receive a repair request instead of another identical debit.

### Less waste

Expired cards, fraud-related declines and revoked mandates are not repeatedly charged.

### Better customer experience

The system avoids unnecessary messages and knows when waiting is better than acting.

### Better compliance

A separate policy layer can refuse unsafe actions even when the strategy proposes them.

### Better explainability

Merchants can see:

- Why a retry happened
- Why a retry was blocked
- Why a customer was contacted
- Why the system waited
- Why a case was escalated

The project demonstrates how Razorpay’s payment and mandate evidence could support a more reason-aware recovery layer. It does not yet prove production revenue improvement.

---

## 17. Exact technology stack

### Main language and runtime

| Technology | Version and purpose |
| --- | --- |
| TypeScript | `7.0.2`, strict application and domain typing |
| Node.js | Local environment uses `22.22.3` |
| ESM | Project uses JavaScript modules |
| TSX | `4.23.12`, runs TypeScript command-line tools |

### Web application

| Technology | Version and purpose |
| --- | --- |
| Next.js | `16.3.2`, App Router and server rendering |
| React | `19.2.8` |
| React DOM | `19.2.8` |
| Tailwind CSS | `4.3.3`, styling |
| PostCSS | `8.5.26` |
| `@tailwindcss/postcss` | `4.3.3` |

### Validation and AI

| Technology | Version and purpose |
| --- | --- |
| Zod | `4.4.3`, webhook and AI-output validation |
| OpenAI Node SDK | `7.5.0`, optional diagnosis for ambiguous failures |
| dotenv | `17.4.2`, local environment loading |
| Default AI model | `gpt-5.4-mini` |

### Testing and proof

| Technology | Purpose |
| --- | --- |
| Node built-in test runner | Unit and behavior tests |
| TypeScript compiler | Separate core and app type checks |
| Seeded simulator | Reproducible benchmark |
| JSON artifacts | Saved summaries and decision ledgers |
| Invariant checks | Reject impossible or unsafe results |

### Hosting and integrations

| Technology | Purpose |
| --- | --- |
| Vercel | Next.js deployment |
| GitHub | Source repository |
| Razorpay | Signed Test Mode webhook |

There is currently no application database or ORM.

The restored process-local version previously passed:

```text
232 tests
61 suites
0 failures
```

A fresh test run after the database-code revert has not been performed because the focus changed to documentation only.

---

## 18. Main codebase folders

```text
app/
  Main Next.js pages, UI components and Razorpay API route

src/domain/
  Business types, causes, policy, actions and compliance rules

src/diagnosis/
  Deterministic diagnosis and optional AI diagnosis

src/strategies/
  Baseline, Sequencer agent and perfect-diagnosis oracle

src/sim/
  Synthetic customer personas, cohort generation and world behavior

src/harness/
  Simulation engine, scoring, invariants and artifacts

src/integrations/razorpay/
  Webhook security, parsing, normalization and shadow processing

runs/
  Tracked simulation summaries and full decision ledgers

docs/
  Failure taxonomy and supporting documentation
```

Important files:

```text
app/page.tsx
app/cases/page.tsx
app/cases/[id]/page.tsx
app/api/razorpay/webhook/route.ts

src/domain/types.ts
src/domain/taxonomy.ts
src/domain/policy.ts
src/domain/compliance.ts

src/diagnosis/deterministic.ts
src/diagnosis/llm.ts

src/strategies/baseline.ts
src/strategies/agent.ts
src/strategies/oracle.ts

src/sim/personas.ts
src/sim/cohort.ts
src/sim/world.ts

src/harness/engine.ts
src/harness/score.ts
src/harness/artifacts.ts

src/integrations/razorpay/webhook.ts
src/integrations/razorpay/shadow.ts
```

---

## 19. Why the architecture is strong

- Strategies cannot read hidden simulator truth.
- Strategies cannot execute actions directly.
- Compliance does not blindly trust the strategy’s diagnosis.
- Every rejected action is visible in the ledger.
- Scheduled retries are checked again before execution.
- Money is stored as integer paise, not floating-point rupees.
- Time is injected and deterministic.
- Baseline, agent and oracle see the same failures.
- The oracle provides an honest upper bound.
- Unsafe contacts remain zero in the tracked run.
- Webhook signatures are verified using exact raw bytes.
- Invalid AI output causes escalation rather than unsafe guessing.
- Real integration evidence is clearly separated from simulated outcomes.

---

## 20. Honest limitations

- Customers and response behavior are synthetic.
- Response probabilities are project assumptions, not merchant data.
- The baseline represents one documented retry policy, not all Razorpay functionality.
- Some regulatory constants use secondary sources.
- Bank holidays are not modeled.
- The optional AI layer is not responsible for the main deterministic results.
- Webhook duplicate protection is process-local, not durable.
- The route does not have complete merchant mandate, consent and billing history.
- The Payment Link test was not a recurring-subscription recovery decision.
- No real payment or customer-message execution exists.
- No real merchant performance has been measured.

These limitations should be stated openly during judging.

---

## 21. Simple judge explanation

### One sentence

> Sequencer uses the reason behind a failed recurring payment to decide whether a limited retry is worth spending, while an independent compliance layer can still refuse the action.

### Short pitch

> Sequencer is a reason-aware recovery controller for failed subscription payments. Instead of blindly retrying every failure, it decides whether the payment should be retried, repaired, paused, stopped or escalated. Every proposed action passes through independent compliance rules, and every decision or refusal is auditable. We measured it on the same seeded 300-case holdout against a modeled calendar policy and a perfect-diagnosis oracle. The results are simulated and reproducible. Separately, our Razorpay Test Mode webhook proves that signed provider events can reach Sequencer securely, while the system remains shadow-only and cannot charge or message anyone.

### Easiest explanation

> Razorpay tells us that a payment failed. Sequencer decides whether another attempt is worth spending—and compliance can still say no.

---

## 22. Final project status

The project currently has:

- A complete deterministic recovery simulator
- A reason-aware strategy
- A calendar baseline
- A perfect-diagnosis oracle
- Independent compliance rules
- Reproducible 300-case results
- Summary and decision-ledger artifacts
- A polished dashboard
- Operations queue and case audits
- A deployed Razorpay Test Mode webhook
- Proof of a provider-generated failed Test Mode payment
- No real money movement or customer contact

The next priority should be presentation quality, demo flow and honest submission messaging—not adding more infrastructure before judging.
