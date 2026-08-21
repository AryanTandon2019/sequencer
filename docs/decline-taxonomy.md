# Decline taxonomy

Reference sheet mapping Razorpay's documented payment failure reasons onto Sequencer's
internal cause buckets and recoverability classes.

**Sources**

- [Error object structure](https://razorpay.com/docs/errors/codes)
- [Card error codes](https://razorpay.com/docs/errors/payments/cards/)
- [UPI error codes](https://razorpay.com/docs/errors/payments/upi/)
- [List of payment errors](https://razorpay.com/docs/errors/payments/list/)
- [Subscription payment retries](https://razorpay.com/docs/payments/subscriptions/payment-retries/)

Every `reason` string in the tables below was read from the pages above. Rows marked
`unverified` in the relevance column indicate an open question about whether that failure
can occur on an unattended auto-debit, not doubt about the string itself.

---

## 1. The error object

Razorpay returns a JSON error object on failure. Documented fields:

| Field         | Meaning                                                                            |
| ------------- | ---------------------------------------------------------------------------------- |
| `code`        | Error type, e.g. `BAD_REQUEST_ERROR`                                               |
| `description` | Human-readable text                                                                |
| `field`       | Request parameter that caused the error, where applicable                          |
| `source`      | Where the failure originated: customer, business, Razorpay, bank, gateway, network |
| `step`        | Stage at which the transaction failed, e.g. `payment_authentication`               |
| `reason`      | The exact machine-handleable failure reason                                        |
| `metadata`    | `payment_id`, `order_id`                                                           |

Documented example: `code: BAD_REQUEST_ERROR`, `source: customer`,
`step: payment_authentication`, `reason: invalid_otp`.

`reason` is the field Sequencer classifies on. `step` and `source` are used as
disambiguating signals where `reason` alone is insufficient.

---

## 2. Card reason strings

| `reason`                            | Razorpay's description (paraphrased)                               |
| ----------------------------------- | ------------------------------------------------------------------ |
| `insufficient_funds`                | Account lacked the balance to complete the transaction             |
| `card_expired`                      | The card has expired                                               |
| `debit_instrument_blocked`          | Card blocked, by the customer or their bank                        |
| `debit_instrument_inactive`         | Card not activated or enabled for online transactions              |
| `card_not_enrolled`                 | Card not activated or enabled for online transactions              |
| `card_disabled_for_online_payments` | Card not activated or enabled for online transactions              |
| `card_declined`                     | Bank declined; no reason supplied to Razorpay                      |
| `payment_failed`                    | Bank declined; no reason supplied to Razorpay                      |
| `payment_risk_check_failed`         | Bank declined the payment as fraudulent                            |
| `transaction_limit_exceeded`        | Customer hit their daily card transaction limit                    |
| `bank_technical_error`              | Downtime at the customer's bank                                    |
| `gateway_technical_error`           | Downtime at the partner bank                                       |
| `authentication_failed`             | Incorrect OTP, or the customer abandoned authentication            |
| `incorrect_cvv`                     | Incorrect CVV entered                                              |
| `payment_timed_out`                 | Customer exceeded the processing time limit (typically 10 minutes) |
| `payment_cancelled`                 | Customer cancelled or pressed back during processing               |

## 3. UPI reason strings

| `reason`                          | Razorpay's description (paraphrased)                           |
| --------------------------------- | -------------------------------------------------------------- |
| `insufficient_funds`              | Account lacked the balance to complete the transaction         |
| `payment_declined`                | Funds could not be debited from the account                    |
| `credit_failed`                   | Customer used a different bank account than the one registered |
| `invalid_vpa`                     | Customer is not a valid user on the UPI app                    |
| `vpa_resolution_failed`           | Transaction could not be processed using the customer's UPI ID |
| `bank_technical_error`            | Downtime at the UPI provider                                   |
| `gateway_technical_error`         | Partner bank technical issues, or partner bank downtime        |
| `payment_timed_out`               | Customer exceeded the time limit, **or** partner bank downtime |
| `payment_collect_request_expired` | Customer exceeded the processing time limit                    |
| `payment_cancelled`               | Customer cancelled or pressed back during processing           |

---

## 4. Cause mapping

`Relevant` answers: can this failure occur on an unattended recurring debit, where no
human is present at a screen?

| `reason`                            | Cause                      | Recoverability    | Relevant   |
| ----------------------------------- | -------------------------- | ----------------- | ---------- |
| `insufficient_funds`                | `INSUFFICIENT_FUNDS`       | `RETRY_VIABLE`    | yes        |
| `payment_declined` (UPI)            | `INSUFFICIENT_FUNDS`       | `RETRY_VIABLE`    | yes        |
| `bank_technical_error`              | `BANK_UNAVAILABLE`         | `RETRY_VIABLE`    | yes        |
| `gateway_technical_error`           | `BANK_UNAVAILABLE`         | `RETRY_VIABLE`    | yes        |
| `transaction_limit_exceeded`        | `LIMIT_EXCEEDED_TEMPORARY` | `RETRY_VIABLE`    | yes        |
| `card_expired`                      | `CARD_EXPIRED`             | `RETRY_FUTILE`    | yes        |
| `debit_instrument_blocked`          | `INSTRUMENT_BLOCKED`       | `RETRY_FUTILE`    | yes        |
| `debit_instrument_inactive`         | `INSTRUMENT_NOT_ENABLED`   | `RETRY_FUTILE`    | yes        |
| `card_not_enrolled`                 | `INSTRUMENT_NOT_ENABLED`   | `RETRY_FUTILE`    | yes        |
| `card_disabled_for_online_payments` | `INSTRUMENT_NOT_ENABLED`   | `RETRY_FUTILE`    | yes        |
| `credit_failed`                     | `ACCOUNT_MISMATCH`         | `RETRY_FUTILE`    | yes        |
| `invalid_vpa`                       | `VPA_INVALID`              | `RETRY_FUTILE`    | yes        |
| `vpa_resolution_failed`             | `VPA_INVALID`              | `RETRY_FUTILE`    | yes        |
| `payment_risk_check_failed`         | `FRAUD_SUSPECTED`          | `RETRY_FORBIDDEN` | yes        |
| `card_declined`                     | `AMBIGUOUS_BANK_DECLINE`   | `NEEDS_HUMAN`     | yes        |
| `payment_failed`                    | `AMBIGUOUS_BANK_DECLINE`   | `NEEDS_HUMAN`     | yes        |
| `authentication_failed`             | see §6                     | —                 | unverified |
| `payment_cancelled`                 | see §6                     | —                 | unverified |
| `payment_timed_out`                 | see §6, §7                 | —                 | no         |
| `payment_collect_request_expired`   | see §6                     | —                 | no         |
| `incorrect_cvv`                     | see §6                     | —                 | no         |

Rows whose cause column is not a backticked identifier are **not** mapped to a cause.
They are recognised and excluded — see §6. `AUTH_REQUIRED_AFA` and
`AMOUNT_EXCEEDS_MANDATE` are reached from mandate state and charge amount rather than
from a reason string, so they appear in §5 rather than here.

### Recoverability classes

| Class             | Meaning                                     | Correct response                     |
| ----------------- | ------------------------------------------- | ------------------------------------ |
| `RETRY_VIABLE`    | An attempt can succeed                      | Spend an attempt, timed deliberately |
| `RETRY_FUTILE`    | No attempt can ever succeed                 | Change the instrument or the mandate |
| `RETRY_FORBIDDEN` | Retrying is a consent or risk problem       | Stop                                 |
| `WAIT`            | Resolves on its own                         | Do nothing                           |
| `NEEDS_HUMAN`     | Genuinely unknowable from available signals | Escalate                             |

---

## 5. Causes not derivable from the payment reason

**This is the most consequential finding in this document.**

Razorpay's error taxonomy carries no mandate information. There is no reason string for a
revoked mandate, a paused mandate, or a debit exceeding the authorised ceiling. The pages
above describe checkout failures — a human at a payment screen.

Yet the [subscription retries doc](https://razorpay.com/docs/payments/subscriptions/payment-retries/)
explicitly names "the customer has cancelled the mandate from their end" as one of four
causes of a failed recurring charge.

Therefore mandate state arrives through a different channel: subscription and mandate
state transitions, surfaced via webhooks such as `subscription.pending` and
`subscription.halted`.

**Design consequence:** diagnosis takes two inputs, not one — the payment failure object
_and_ the current subscription/mandate state. A classifier reading only `reason` cannot
distinguish a customer who cancelled from a customer whose bank was down.

| Cause                    | Recoverability    | Derived from                    |
| ------------------------ | ----------------- | ------------------------------- |
| `MANDATE_REVOKED`        | `RETRY_FORBIDDEN` | Subscription/mandate state      |
| `MANDATE_PAUSED`         | `WAIT`            | Subscription/mandate state      |
| `AMOUNT_EXCEEDS_MANDATE` | `RETRY_FUTILE`    | Charge amount vs authorised cap |
| `AUTH_REQUIRED_AFA`      | `RETRY_FUTILE`    | Charge amount vs AFA ceiling    |

---

## 6. Excluded: checkout-only failures

These require a human present and cannot arise from an unattended auto-debit. Sequencer
classifies them as out of scope rather than mapping them.

`payment_timed_out`, `payment_collect_request_expired`, `incorrect_cvv`

`payment_cancelled` is held as **unverified**: on the card and UPI pages it describes a
customer abandoning checkout, but whether Razorpay also emits it for a mandate
cancellation has not been confirmed. Until it is, it must not be treated as a
mandate-revocation signal.

`authentication_failed` is **unverified** for a different reason: an unattended debit
cannot fail an OTP prompt, but a recurring charge above the AFA ceiling does require
authentication, so the string may legitimately appear in a recurring context.

---

## 7. Documented ambiguities

Three cases where the same `reason` maps to materially different underlying situations, in
Razorpay's own documentation. These are the justification for a reasoning layer rather
than a lookup table alone.

**`payment_timed_out` (UPI)** — documented under two separate headings: the customer
exceeded the time limit, _or_ there was partner bank downtime. Opposite implications: one
is a dead end, the other is a transient failure worth retrying.

**`gateway_technical_error` (UPI)** — documented as both partner bank technical issues and
partner bank downtime, with different recommended next steps.

**`card_declined` and `payment_failed`** — both documented as a bank decline with no reason
supplied. Razorpay states it may not have access to the underlying cause. These are
genuinely unknowable from the payload and are classified `NEEDS_HUMAN` by construction,
never guessed at.

---

## 8. Where Razorpay's default retry is correct

Worth stating explicitly, because a critique that claims the existing system is always
wrong is less credible than one that identifies where it is right.

Razorpay's built-in behaviour retries the following day, shifted for bank holidays. For
`transaction_limit_exceeded` that is exactly correct: a daily card limit resets overnight,
so a next-day attempt is precisely the right move.

The same policy applied to `card_expired` or a revoked mandate spends a regulated attempt
on an outcome that was impossible from the outset.

---

## 9. Open verification items

- [ ] Confirm whether `payment_cancelled` is emitted for mandate cancellation, or only for
      checkout abandonment.
- [ ] Confirm which webhook or field carries mandate revocation and pause state.
- [ ] Confirm whether `authentication_failed` appears on recurring charges above the AFA
      ceiling.
- [ ] Check the netbanking, wallet and e-mandate error pages for reason strings specific to
      recurring debits that the card and UPI pages do not cover.
- [ ] Capture a real `payment.failed` payload in Razorpay test mode to confirm field shape
      against §1.
