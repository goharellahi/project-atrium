import { describe, expect, it } from 'vitest';
import { LEGAL_TRANSITIONS, isLegalTransition } from './booking-state-machine.service';
import { bookingStatus, type BookingStatus } from '../db/schema';

/**
 * The transition table, tested as data.
 *
 * This is the half of the state machine that needs no database: the table says
 * which arrows exist, and every arrow that does not exist must be a 409 rather
 * than a 500. Being asked for an illegal transition is the NORMAL case under
 * concurrency — two clients racing to confirm one hold, a webhook arriving
 * after expiry — so the assertion below is exhaustive over the full N x N
 * product rather than over a handful of interesting pairs.
 *
 * The rest of the machine — the row lock, the single audit row per transition,
 * the 409 body — is exercised end to end by the concurrency proof and by the
 * INV-6 suite, both of which need a real Postgres.
 */
const ALL = bookingStatus.enumValues;

const EXPECTED: Record<BookingStatus, BookingStatus[]> = {
  DRAFT: ['HELD'],
  HELD: ['PENDING_PAYMENT', 'EXPIRED', 'CANCELLED'],
  PENDING_PAYMENT: ['CONFIRMED', 'FAILED', 'EXPIRED'],
  CONFIRMED: ['CANCELLED', 'COMPLETED'],
  COMPLETED: [],
  EXPIRED: [],
  FAILED: [],
  CANCELLED: ['REFUNDED'],
  REFUNDED: [],
};

describe('the legal transition table', () => {
  it('covers every status, with no status missing an entry', () => {
    // A status added to the enum without a row here would make
    // LEGAL_TRANSITIONS[from] undefined and turn the legality check into a
    // TypeError — a 500 on the exact path that must never 500.
    expect(Object.keys(LEGAL_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  it('allows exactly the arrows that should exist, and no others', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        expect(
          isLegalTransition(from, to),
          `${from} -> ${to} should be ${EXPECTED[from].includes(to) ? 'legal' : 'illegal'}`,
        ).toBe(EXPECTED[from].includes(to));
      }
    }
  });

  it('has four terminal states and they are genuinely terminal', () => {
    // Money and slots both depend on this. A resurrectable EXPIRED would let a
    // late payment reclaim a slot someone else already holds, which is INV-4
    // failing; a resurrectable REFUNDED would let a booking be confirmed after
    // its money went back.
    for (const terminal of ['COMPLETED', 'EXPIRED', 'FAILED', 'REFUNDED'] as const) {
      expect(LEGAL_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it('has no self-transitions', () => {
    // A status change to the state it is already in is not a transition; the
    // side-effect path (recordSideEffect) exists for the cases that need one.
    for (const status of ALL) {
      expect(isLegalTransition(status, status)).toBe(false);
    }
  });

  it('makes DRAFT unreachable — it names an origin, not a state rows sit in', () => {
    for (const from of ALL) {
      expect(isLegalTransition(from, 'DRAFT')).toBe(false);
    }
  });

  it('routes a payment failure to FAILED and never back to HELD', () => {
    expect(isLegalTransition('PENDING_PAYMENT', 'FAILED')).toBe(true);
    expect(isLegalTransition('PENDING_PAYMENT', 'HELD')).toBe(false);
  });

  it('refuses to confirm an expired hold — the INV-4 arrow that must not exist', () => {
    expect(isLegalTransition('EXPIRED', 'CONFIRMED')).toBe(false);
    expect(isLegalTransition('CANCELLED', 'CONFIRMED')).toBe(false);
  });
});
