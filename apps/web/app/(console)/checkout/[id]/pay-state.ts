/**
 * What a charge attempt and a hold extension came back as.
 *
 * Separate from `actions.ts` for the same reason as everywhere else in this
 * console: a `'use server'` module may only export async functions, and a
 * constant exported beside an action fails at runtime rather than at build.
 */
import type { PaymentView } from '@/lib/types';

export type PayOutcome =
  | 'idle'
  | 'accepted'
  | 'replayed'
  | 'transient'
  | 'no_answer'
  | 'conflict'
  | 'error';

export interface PayState {
  outcome: PayOutcome;
  message: string | null;
  payment: PaymentView | null;
  detail: Record<string, unknown>;
}

export const EMPTY_PAY_STATE: PayState = {
  outcome: 'idle',
  message: null,
  payment: null,
  detail: {},
};

export interface ExtendState {
  message: string | null;
  ok: boolean;
}

export const EMPTY_EXTEND_STATE: ExtendState = { message: null, ok: false };
