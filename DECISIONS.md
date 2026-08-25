# Decisions

Design decisions and, more importantly, the options rejected and why. Written as work
proceeds rather than reconstructed afterwards.

---

## D1 — Scope: one leakage type, not the whole track

**Decision.** Failed recurring-payment recovery only.

**Rejected: covering several leakage types.** Track 03 spans payment failures, checkout
abandonment and overdue receivables. Its instruction is to build _a bounded recovery
workflow_, singular, and its bar asks for money recovered across _a batch_, singular. Four
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
the timing is unsophisticated. The gap is that the _cause is never consulted_.

**Consequence for the pitch.** The headline is not "we recover more." It is: comparable
gross recovery on a fraction of a regulated budget, with zero contact to customers who
withdrew consent. Less flashy, survives scrutiny.

---

## D3 — Simulated ground truth, not real data

**Decision.** A cohort of simulated subscriptions, each with a hidden persona that determines
real outcomes. The agent sees only `ObservableSubscription`.

**Rejected: real or scraped merchant data.** Not available, but that is not the real reason.
With real outcome data you cannot measure a _decision_, only an outcome — there is no
counterfactual. If a subscription recovered, you cannot know whether a different action
would have recovered it sooner, cheaper, or at all. A simulator is the only way to score the
choice rather than the result.

**Anticipated objection.** "Your distribution is invented." Answer, in three parts: the
personas derive from causes Razorpay's own documentation enumerates; the claim is that the
decision logic is correct _given_ a cause, so the simulator tests logic rather than market
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
agent. The track asks for something that _executes_ a bounded workflow; gating everything is
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

**Decision.** The diagnoser receives the payment failure object _and_ the subscription/mandate
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

---

## D14 — Guardrails enforce on a cause they derive themselves

**Decision.** The compliance layer receives an `enforcementCause` computed by the engine
from observable signals, plus the acting strategy's confidence separately. It never
enforces against the strategy's own diagnosis.

**Reasoning.** Two problems with trusting the strategy. A platform enforces rules on
facts, not on an agent's opinion about them — an agent that decided a dead card was a
balance shortfall should not thereby earn permission to retry it. And the baseline
performs no diagnosis at all, so under the original design it could not be governed by
any cause-based rule. A strategy must not be able to escape a rule by staying silent.

**Consequence.** `Decision` carries both `diagnosis` (nullable, the strategy's view) and
`enforcementCause` (the platform's). Only the confidence floor consults the former.

---

## D15 — Strategies propose; they never execute

**Decision.** `Strategy.propose()` returns candidate actions in preference order. The
engine adjudicates them and executes the first one permitted.

**Rejected: letting strategies act and calling the guardrails themselves.** There would
then exist a code path where forgetting a call bypasses compliance. As written there is
no such path — a strategy has no way to reach the world. That is a stronger guarantee
than a convention, and it costs nothing.

**Side benefit.** Refused candidates are retained, so the ledger shows what the agent
wanted and which cited rule stopped it. That is the most informative thing in the whole
output.

---

## D16 — The pre-debit notice is platform infrastructure

**Decision.** The engine issues the RBI-required 24-hour notice when a case enters
recovery. Policies schedule around its maturity rather than sending it.

**Rejected: making the strategy responsible for it.** Tried first, and wrong twice over.
Razorpay's documented retry does not expose notice control to a retry policy, so holding
the baseline responsible for something it has no mechanism to do measured the wrong
thing — it escalated all 300 cases immediately. Worse, publishing that comparison would
have implied the shipped default violates RBI rules. It does not, and implying it in a
submission to Razorpay would be both false and a serious own goal.

**Bug this caused before the fix.** The agent proposed a retry, was refused for want of
notice, sent a notice — resetting the clock — and repeated every twelve hours. 5,161
contacts, 4,996 refusals, zero recoveries.

---

## D17 — Some personas conceal their cause

**Decision.** Two personas emit a bare decline that does not name their real problem: a
genuine balance shortfall reported as `payment_failed`, and a dead card reported as
`card_declined`.

**Reasoning.** Without them the deterministic classifier was always right, the oracle was
identical to the agent to the rupee, the confusion matrix was an identity matrix, and a
reasoning layer had nothing to contribute. **A benchmark that cannot be got wrong measures
nothing.** Razorpay documents that it may not have access to the cause behind exactly
those two reason strings, so the masking is faithful rather than contrived.

**Guarded by a test.** One assertion checks the classifier reaches the declared cause for
every unmasked persona; another checks it _fails_ to for every masked one. If a mask
stopped masking, the benchmark would quietly lose its ability to distinguish good
diagnosis from luck.

---

## D18 — An unexplained decline is not a diagnosis

**Decision.** The deterministic diagnoser returns null for `AMBIGUOUS_BANK_DECLINE`
rather than reporting it as a resolved classification.

**Reasoning.** "The bank declined and told nobody why" records what the payload says
without establishing anything about the customer. Returning it as settled also closed the
door on the layer that exists for precisely these cases: the model was never consulted,
because a lookup table had already declared the matter resolved. The cause itself stays
meaningful — a model may conclude ambiguity after weighing the history, and the oracle
uses it for customers whose decline genuinely has no determinable cause. Only the lookup
layer abstains.

---

## D19 — Retry timing anchors to the failure, never to now

**Decision.** Every retry delay is computed from the moment of failure or the fixed charge
date, never from the current time.

**Reasoning.** A delay measured from now is recomputed on every consultation, so waking at
the scheduled moment produces a fresh delay and the retry recedes for ever. This produced
two separate bugs: 38 bank outages that never retried because the six-hour delay kept
renewing, and salary-cycle cases that searched for the next _future_ funding day and so
jumped a month ahead each time they woke. Both looked like policy decisions and were
arithmetic.

---

## D20 — A guardrail must not punish honesty

**Decision.** The confidence floor does not refuse an action justified by a remedy the
customer has already completed.

**How this was found.** The reasoning layer initially made recovery _worse_ — better
diagnosis accuracy, 88.0% against 86.3%, and ₹3,699 less money. Measuring case by case
showed every loss was a plan upgrade whose retry never fired.

The chain: a plan upgrade is caught deterministically by the mandate-cap check. The
customer re-authorises, the cap rises, and now the classifier cannot see the problem
because the signal that identified it is gone. It falls through to the stale
`payment_failed` and abstains, so the model is consulted and honestly answers
`AMBIGUOUS_BANK_DECLINE` at 0.34 confidence — and the floor refuses the retry. The plain
agent, having said nothing at all, had the floor abstain and proceeded.

**A low-confidence answer was strictly worse than no answer.** The floor exists to stop an
agent acting on a diagnosis it does not trust; it must not also block an action that does
not rest on one. After the exemption the reasoning layer adds ₹17,291 instead of losing
₹3,699.

**Worth keeping in mind generally.** Diagnosis accuracy and recovered money are different
objectives, and optimising the first can move the second the wrong way.

---

## D21 — The claim is bounded to the documented default

**Decision.** The baseline models Razorpay's documented subscription retry schedule. Every
statement of the result says so explicitly.

**Reasoning.** A threefold improvement over a production payments system is not a
plausible claim, and asserting it would invite the obvious reply: Agent Studio ships a
Subscription Recovery agent today, with retry logic and targeted nudges. The comparison
here is against the next-day retry schedule described in the subscriptions
documentation — a real and fair target, but a narrower one than "Razorpay's recovery
capability".

**The defensible sentence.** On a 300-case simulated cohort, reason-aware allocation of a
four-attempt regulatory budget recovers 76.9% of the achievable ceiling against 24.8% for
the documented default, on 27% fewer attempts, without proposing a single message to a
customer who withdrew consent, and the ordering holds across three cohort compositions.

**Related care.** The restraint figures must be stated precisely. The default _proposed_
32 messages to withdrawn-consent customers and the guardrail blocked all 32; none were
delivered. Phrasing that as Razorpay debiting or dunning people who cancelled would be
false.

---

## D22 — The confidence floor is a measured knob, not a constant

**Decision.** The internal confidence floor is configured per run rather than welded into
the guardrail, and `npm run floors` measures the headline result at 0.50, 0.70 and 0.90.
A fixed-confidence probe adjudicated through the same entry point as the engine proves
the option reaches compliance; if it did not, every zero in the table would be
indistinguishable from a disconnected knob.

**Reasoning.** The floor is the one guardrail with no external citation — every other rule
is a regulator's or a network's law, this one is ours. An unexamined internal choice
standing between a diagnosis and money is exactly what a reviewer should ask about, and
"sensitivity worth reporting" in a code comment is not reporting.

**Finding.** On the deterministic path the floor never fires: the lookup diagnoser claims
only 0.95 and 0.99 on this cohort (its one low-confidence basis requires an unrecognised
reason at the authentication step, which no persona produces). Identical rows across all
three floors are therefore a result, not a bug — the conclusion cannot depend on the
threshold because the threshold never binds there. It binds against the reasoning layer,
whose confidences span 0..1; `--llm` measures that regime.

**Rejected.** Hardcoding the constant and asserting its value in a unit test — that proves
the number exists, not that anything survives it.
