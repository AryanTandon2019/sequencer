/**
 * Tests for the decline taxonomy.
 *
 * The first test is the important one: it parses the mapping table out of
 * docs/decline-taxonomy.md and asserts the code agrees with it row for row.
 *
 * That makes the project's central factual claim - "these causes are mapped from
 * Razorpay's documented error taxonomy" - enforced rather than asserted. Edit the
 * document without the code, or the code without the document, and the build
 * breaks. Documentation drift is the usual way a claim like this quietly becomes
 * false.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { ALL_DECLINE_CAUSES, HARD_DECLINE_CAUSES, RECOVERABILITY } from './causes.js';
import {
  AFA_EXEMPT_CEILING_PAISE,
  AFA_EXEMPT_CEILING_HIGHER_PAISE,
} from './regulation.js';
import {
  OUT_OF_SCOPE_REASONS,
  REASON_TO_CAUSE,
  classify,
  type Classification,
} from './taxonomy.js';
import type { MandateState, ObservedFailure, Paise } from './types.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const TAXONOMY_DOC = 'docs/decline-taxonomy.md';

function failure(reason: string, overrides: Partial<ObservedFailure> = {}): ObservedFailure {
  return {
    code: 'BAD_REQUEST_ERROR',
    reason,
    source: 'bank',
    step: 'payment_authorization',
    description: `synthetic fixture for ${reason}`,
    at: 0,
    ...overrides,
  };
}

function mandate(overrides: Partial<MandateState> = {}): MandateState {
  return {
    authorisation: 'active',
    capPaise: 10_000_00,
    higherAfaCeiling: false,
    ...overrides,
  };
}

const NORMAL_AMOUNT: Paise = 499_00;

function classifyReason(
  reason: string,
  opts: { mandate?: MandateState; amountPaise?: Paise; step?: string } = {},
): Classification {
  return classify({
    failure: opts.step === undefined ? failure(reason) : failure(reason, { step: opts.step }),
    mandateState: opts.mandate ?? mandate(),
    amountPaise: opts.amountPaise ?? NORMAL_AMOUNT,
  });
}

/* ------------------------------------------------------------------ *
 * Documentation parsing
 * ------------------------------------------------------------------ */

interface DocRow {
  readonly reason: string;
  /** Backticked identifier, or null when the row points at §6 instead. */
  readonly cause: string | null;
  readonly recoverability: string | null;
  readonly relevant: DocRelevance;
}

/**
 * Permitted values in the doc's relevance column.
 *
 * Requiring the cell to be one of these does double duty: it validates the
 * document's own format, and it excludes the table header, whose first cell is
 * itself a backticked `reason` and would otherwise parse as a data row.
 */
const DOC_RELEVANCE_VALUES = ['yes', 'no', 'unverified'] as const;
type DocRelevance = (typeof DOC_RELEVANCE_VALUES)[number];

function asRelevance(cell: string): DocRelevance | null {
  return (DOC_RELEVANCE_VALUES as readonly string[]).includes(cell)
    ? (cell as DocRelevance)
    : null;
}

/** Extract the body of a numbered section, up to the next `## ` heading. */
function section(doc: string, headingStartsWith: string): string {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## ${headingStartsWith}`));
  assert.notEqual(start, -1, `section "${headingStartsWith}" not found in ${TAXONOMY_DOC}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

const BACKTICKED = /^`([a-z0-9_]+)`$/i;

function parseMappingTable(body: string): DocRow[] {
  const rows: DocRow[] = [];

  for (const line of body.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;

    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());

    // The mapping table has four columns. Skip headers and separator rows.
    if (cells.length !== 4) continue;

    const [reasonCell, causeCell, recovCell, relevantCell] = cells as [
      string,
      string,
      string,
      string,
    ];

    // Excludes the header row and the |---| separator.
    const relevant = asRelevance(relevantCell);
    if (relevant === null) continue;

    const reasonMatch = BACKTICKED.exec(reasonCell);
    if (reasonMatch?.[1] === undefined) continue;

    const causeMatch = BACKTICKED.exec(causeCell);
    const recovMatch = BACKTICKED.exec(recovCell);

    rows.push({
      reason: reasonMatch[1],
      cause: causeMatch?.[1] ?? null,
      recoverability: recovMatch?.[1] ?? null,
      relevant,
    });
  }

  return rows;
}

const docRows = parseMappingTable(section(readFileSync(TAXONOMY_DOC, 'utf8'), '4. Cause mapping'));

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe('documentation and code agree', () => {
  it('parses a non-trivial mapping table out of the doc', () => {
    // Guards against the parser silently matching nothing and the suite passing
    // vacuously, which would be worse than a failing test.
    assert.ok(
      docRows.length >= 15,
      `expected at least 15 mapping rows in ${TAXONOMY_DOC} §4, parsed ${docRows.length}`,
    );
  });

  it('maps every documented reason string to the documented cause', () => {
    for (const row of docRows) {
      if (row.cause === null) continue;

      const result = classifyReason(row.reason);
      assert.equal(
        result.kind,
        'resolved',
        `${row.reason}: doc says ${row.cause}, code returned "${result.kind}"`,
      );
      assert.equal(
        result.kind === 'resolved' ? result.cause : undefined,
        row.cause,
        `${row.reason}: doc and code disagree on cause`,
      );
    }
  });

  it('assigns every documented reason the documented recoverability', () => {
    for (const row of docRows) {
      if (row.cause === null || row.recoverability === null) continue;

      const result = classifyReason(row.reason);
      assert.equal(
        result.kind === 'resolved' ? result.recoverability : undefined,
        row.recoverability,
        `${row.reason}: doc says ${row.recoverability}`,
      );
    }
  });

  it('excludes every reason the doc declines to map', () => {
    for (const row of docRows) {
      if (row.cause !== null) continue;

      const result = classifyReason(row.reason);
      assert.equal(
        result.kind,
        'out_of_scope',
        `${row.reason}: doc maps it to no cause, so code must exclude it explicitly`,
      );
    }
  });
});

describe('the cause table is total', () => {
  it('classifies every cause exactly once', () => {
    const keys = Object.keys(RECOVERABILITY);
    assert.equal(new Set(keys).size, keys.length, 'duplicate key in RECOVERABILITY');
    assert.equal(ALL_DECLINE_CAUSES.length, keys.length);
  });

  it('only marks real causes as hard declines', () => {
    for (const cause of HARD_DECLINE_CAUSES) {
      assert.ok(
        ALL_DECLINE_CAUSES.includes(cause),
        `${cause} is listed as a hard decline but is not a known cause`,
      );
    }
  });

  it('never assigns RETRY_VIABLE to a hard decline', () => {
    // The two ideas would contradict each other: a hard decline cannot approve,
    // so an attempt spent on one is guaranteed waste and chargeable besides.
    for (const cause of HARD_DECLINE_CAUSES) {
      assert.notEqual(
        RECOVERABILITY[cause],
        'RETRY_VIABLE',
        `${cause} is a hard decline and must not be retry-viable`,
      );
    }
  });
});

describe('unknown reasons are never guessed at', () => {
  it('returns unrecognised for a string it has never seen', () => {
    const result = classifyReason('some_reason_razorpay_added_last_tuesday');
    assert.equal(result.kind, 'unrecognised');
  });

  it('does not map an unknown reason via the reason table', () => {
    assert.equal(REASON_TO_CAUSE['some_reason_razorpay_added_last_tuesday'], undefined);
  });

  it('uses step as a last signal before giving up', () => {
    const result = classifyReason('totally_unknown_reason', { step: 'payment_authentication' });
    assert.equal(result.kind, 'resolved');
    assert.equal(result.kind === 'resolved' ? result.cause : undefined, 'AUTH_REQUIRED_AFA');
    assert.equal(result.kind === 'resolved' ? result.basis : undefined, 'step_signal');
  });
});

describe('mandate state overrides the payment reason', () => {
  it('treats a revoked mandate as revoked even when the bank reported low funds', () => {
    // This is the case a reason-only classifier gets wrong, and it is the one
    // where getting it wrong means debiting someone who withdrew consent.
    const result = classifyReason('insufficient_funds', {
      mandate: mandate({ authorisation: 'revoked' }),
    });
    assert.equal(result.kind, 'resolved');
    assert.equal(result.kind === 'resolved' ? result.cause : undefined, 'MANDATE_REVOKED');
    assert.equal(result.kind === 'resolved' ? result.basis : undefined, 'mandate_state');
  });

  it('treats a paused mandate as wait, not as a retry opportunity', () => {
    const result = classifyReason('insufficient_funds', {
      mandate: mandate({ authorisation: 'paused' }),
    });
    assert.equal(result.kind === 'resolved' ? result.recoverability : undefined, 'WAIT');
  });

  it('treats a lapsed mandate as withdrawn authorisation', () => {
    const result = classifyReason('insufficient_funds', {
      mandate: mandate({ authorisation: 'expired' }),
    });
    assert.equal(result.kind === 'resolved' ? result.cause : undefined, 'MANDATE_REVOKED');
  });
});

describe('consent boundaries', () => {
  it('flags a charge above the authorised mandate cap', () => {
    const result = classifyReason('insufficient_funds', {
      mandate: mandate({ capPaise: 100_00 }),
      amountPaise: 500_00,
    });
    assert.equal(result.kind === 'resolved' ? result.cause : undefined, 'AMOUNT_EXCEEDS_MANDATE');
  });

  it('flags a charge above the AFA exemption ceiling', () => {
    const result = classifyReason('insufficient_funds', {
      mandate: mandate({ capPaise: 50_000_00 }),
      amountPaise: AFA_EXEMPT_CEILING_PAISE + 1,
    });
    assert.equal(result.kind === 'resolved' ? result.cause : undefined, 'AUTH_REQUIRED_AFA');
  });

  it('permits the same charge under the higher category ceiling', () => {
    const result = classifyReason('insufficient_funds', {
      mandate: mandate({
        capPaise: 50_000_00,
        higherAfaCeiling: true,
      }),
      amountPaise: AFA_EXEMPT_CEILING_PAISE + 1,
    });
    assert.equal(result.kind === 'resolved' ? result.cause : undefined, 'INSUFFICIENT_FUNDS');
  });

  it('still flags a charge above even the higher ceiling', () => {
    const result = classifyReason('insufficient_funds', {
      mandate: mandate({
        capPaise: 99_00_000_00,
        higherAfaCeiling: true,
      }),
      amountPaise: AFA_EXEMPT_CEILING_HIGHER_PAISE + 1,
    });
    assert.equal(result.kind === 'resolved' ? result.cause : undefined, 'AUTH_REQUIRED_AFA');
  });
});

describe('checkout-only failures', () => {
  it('excludes them rather than forcing them into a cause', () => {
    for (const reason of Object.keys(OUT_OF_SCOPE_REASONS)) {
      const result = classifyReason(reason);
      assert.equal(result.kind, 'out_of_scope', `${reason} should be out of scope`);
    }
  });

  it('records why each one is excluded', () => {
    for (const [reason, note] of Object.entries(OUT_OF_SCOPE_REASONS)) {
      assert.ok(note.length > 20, `${reason} needs a real explanation, not a stub`);
    }
  });
});
