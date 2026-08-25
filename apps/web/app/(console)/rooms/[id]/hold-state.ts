/**
 * What a hold attempt came back as.
 *
 * Separate from `actions.ts` because a `'use server'` module may only export
 * async functions — an exported constant beside the action compiles, builds,
 * and then throws at runtime the moment a client component imports it.
 *
 * The three failure statuses stay distinct all the way to the screen because
 * they are three different things to tell a person. A 409 means somebody else
 * took the slot, which under concurrency is the expected answer for every
 * request but the first and is information rather than a fault. A 422 means the
 * request could never have been valid. `unreachable` means nothing was created
 * at all.
 */
export interface HoldState {
  status: 'idle' | 'conflict' | 'invalid' | 'unreachable' | 'error';
  message: string | null;
  issues: { path: string; message: string }[];
  /** Extra keys the API attaches to a 409: `reason`, `room_id`, `starts_at`. */
  detail: Record<string, unknown>;
}

export const EMPTY_HOLD_STATE: HoldState = {
  status: 'idle',
  message: null,
  issues: [],
  detail: {},
};

/**
 * Whether the equipment catalogue is readable from this screen, and why not.
 *
 * `unreadable` covers both a 403 and an API that did not answer: from the
 * booking panel's point of view they are the same fact — there is no catalogue
 * to show — and it offers the manual id field either way rather than dropping
 * equipment from the flow because one request failed.
 *
 * `other_venue` is separate because collapsing it into an empty picker would
 * tell a venue admin looking at another venue's room that the venue owns no
 * equipment. It owns plenty; this account cannot see it, which is tenant
 * isolation working rather than an empty inventory.
 */
export type EquipmentAccess = 'available' | 'unreadable' | 'other_venue';
