# Decisions

Design decisions and, more importantly, the options rejected and why. Written as work
proceeds rather than reconstructed afterwards.

---

## D1 — Scope: one leakage type, not the whole track

**Decision.** Failed recurring-payment recovery only.

**Rejected: covering several leakage types.** Track 03 spans payment failures, checkout
abandonment and overdue receivables. Its instruction is to build *a bounded recovery
workflow*, singular, and its bar asks for money recovered across *a batch*, singular. Four
leakage types at a quarter of the depth each produces exactly what the bar opens by
rejecting — problems identified, money not recovered.

**Rejected: checkout abandonment.** Razorpay ships two Abandoned Cart Conversion agents in
Agent Studio already. Its decision space is also thin: send a message, optionally with a
discount.

**Rejected: B2B receivables.** Genuinely uncovered by Agent Studio and a strong option, but
consumer-side recurring failure is where the track's example directions concentrate, and
"mandate retry sequencer" is one of them by name.

---

## D2 — The claim is allocation, not timing

**Decision.** The thesis is that four regulated attempts are a scarce resource and should be
allocated by cause.

**Rejected: "smarter retry timing" as the headline.** Timing intelligence is a weaker claim
and risks colliding with existing work. What Razorpay's
[subscription retries doc](https://razorpay.com/docs/payments/subscriptions/payment-retries/)
actually documents is next-day retry with a bank-holiday shift — a calendar, applied
identically to the four distinct causes it enumerates on the same page. The gap is not that
the timing is unsophisticated. The gap is that the *cause is never consulted*.

**Consequence for the pitch.** The headline is not "we recover more." It is: comparable
gross recovery on a fraction of a regulated budget, with zero contact to customers who
withdrew consent. Less flashy, survives scrutiny.

---

## D3 — Simulated ground truth, not real data

**Decision.** A cohort of simulated subscriptions, each with a hidden persona that determines
real outcomes. The agent sees only `ObservableSubscription`.

**Rejected: real or scraped merchant data.** Not available, but that is not the real reason.
With real outcome data you cannot measure a *decision*, only an outcome — there is no
counterfactual. If a subscription recovered, you cannot know whether a different action
would have recovered it sooner, cheaper, or at all. A simulator is the only way to score the
choice rather than the result.

**Anticipated objection.** "Your distribution is invented." Answer, in three parts: the
personas derive from causes Razorpay's own documentation enumerates; the claim is that the
decision logic is correct *given* a cause, so the simulator tests logic rather than market
composition; and a sensitivity analysis across three different persona mixes shows the
conclusion holds regardless of composition.

**Discipline.** Seeded RNG so runs reproduce. Tuning happens on one cohort, final numbers are
reported on a held-out cohort generated from a different seed.

---

## D4 — Tiered autonomy, not approval on everything

**Decision.** Inside a defined envelope — attempts remaining, valid pre-debit notice,
permitted execution window, confidence above floor — the agent executes autonomously.
Outside it, it escalates.

**Rejected: human approval before every action.** This was seriously considered and it is
wrong twice over. It makes a 300-case batch impossible to measure, since nobody hand-approves
300 decisions, and it therefore forfeits the bar's central requirement. It also isn't an
agent. The track asks for something that *executes* a bounded workflow; gating everything is
a suggestion queue.

---

## D5 — Deterministic first, model only for ambiguity

**Decision.** Reason-string lookup plus `step`/`source` signals resolve the majority of cases.
Only genuinely ambiguous failures reach the model.

**Rejected: sending every case to the model.** Three reasons. It costs roughly seven times
more, which matters against a $15 credit. It makes results non-reproducible for a reviewer
without an API key. And it is worse engineering: a deterministic mapping that is auditable
line by line beats a model call that happens to usually agree with it.

**Corollary — the model never does arithmetic.** Attempt counting, budget math, notice-window
calculation and date logic are code. The model's only output is a cause, a confidence and a
rationale.

---

## D6 — Guardrails in code, not in the prompt

**Decision.** Compliance rules are functions that permit or refuse a proposed action, each
carrying its source citation.

**Rejected: expressing constraints as prompt instructions.** A prompt is a request. Code is a
rule. For constraints derived from NPCI attempt caps, RBI notification requirements and card
network reattempt rules, "the model was told not to" is not an acceptable control.

**Detail.** Refusals are recorded, never thrown. The ledger shows what the agent wanted and
which cited rule stopped it, because a blocked attempt is a result worth seeing — and it is
the strongest single moment in the demo.

---

## D7 — `null` is a valid classification result

**Decision.** When a reason string is unrecognised, the classifier returns `null` rather than
a best guess. `null` routes to the model layer, and if still unresolved, to a human.

**Reasoning.** Razorpay documents `card_declined` and `payment_failed` as bank declines with
no reason supplied, and states it may not have access to the cause. Some failures are
genuinely unknowable from the payload. Manufacturing a confident answer for those would
undermine every honest number elsewhere in the report.

---

## D8 — No database, no auth, no API

**Decision.** JSON run artefacts on disk. No database. No authentication. No HTTP API. The
core is a CLI harness; the UI reads run files.

**Rejected: Supabase or Firebase.** Considered and reversed. At 300 records, one user, and no
writes from the UI, a database is setup cost for zero credibility gain. JSON files diff in
git and can be opened by a reviewer.

**Rejected: Clerk or any auth.** Authentication demonstrates nothing about payment recovery.
One hardcoded demo merchant.

**Constraint this protects.** `npm install && npm run harness` must reproduce the reported
numbers with no API key and no services. A reviewer triaging many submissions has a few
minutes; most repos they open will not run at all.

---

## D9 — Include an oracle strategy

**Decision.** Three strategies scored on the same cohort: baseline, agent, and an oracle with
perfect diagnosis.

**Reasoning.** The oracle establishes the achievable ceiling, which converts the headline from
"78% recovery rate" — a number with no reference point — into "captured 78% of what was
recoverable at all." It also cheaply exposes whether a shortfall came from diagnosis error or
from the policy itself.

**Cost.** Roughly an extra day. Judged worth it.

---

## D10 — Money is integer paise

**Decision.** All amounts are integers in paise. Every field suffixed `Paise`.

**Reasoning.** Floating point on currency is a defect waiting to surface, and in this project
the defect would appear as a wrong number in a submitted result rather than as a crash.

---

## D11 — Name: Sequencer

**Decision.** `Sequencer`.

**Rejected: RecoverAI.** The original name, and generic — it describes a category, not this
system. "Mandate retry sequencer" is one of Razorpay's own listed example directions for
Track 03, so the name maps the project onto their stated brief on sight.

**Rejected: Triage.** Better metaphor for a non-technical viewer — limited resources, decide
where they are worth spending — but weaker as a repo name. Retained as internal vocabulary:
cases are triaged, and the triage queue holds what needs a human.

---

## D12 — Diagnosis takes two inputs, not one

**Decision.** The diagnoser receives the payment failure object *and* the subscription/mandate
state.

**Reasoning.** Discovered while verifying reason strings against Razorpay's error pages: the
error taxonomy carries no mandate information at all. There is no reason string for a revoked
or paused mandate, because those pages document checkout failures. Yet the subscription
retries doc names customer mandate cancellation as a failure cause. Mandate state therefore
arrives through subscription state transitions and webhooks, not through `reason`.

A classifier reading only `reason` cannot tell a customer who withdrew consent from a customer
whose bank was briefly down — and those two cases have opposite correct responses. See
[docs/decline-taxonomy.md](docs/decline-taxonomy.md) §5.

---

## D13 — Name where the existing system is right

**Decision.** State explicitly that Razorpay's next-day retry is the correct response to
`transaction_limit_exceeded`.

**Reasoning.** A daily card limit resets overnight, so a next-day attempt is exactly right
there. A critique claiming the incumbent is always wrong invites the reviewer to look for the
counterexample. Naming it first makes the remaining cases harder to dismiss.
