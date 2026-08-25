/**
 * What a cancellation came back as.
 *
 * Separate from `actions.ts`: a `'use server'` module may only export async
 * functions.
 */
import type { CancelResponse } from '@/lib/types';

export interface CancelState {
  status: 'idle' | 'done' | 'conflict' | 'unreachable' | 'error';
  message: string | null;
  result: CancelResponse | null;
}

export const EMPTY_CANCEL_STATE: CancelState = {
  status: 'idle',
  message: null,
  result: null,
};
