import type { Actor } from '../bookings/booking-state-machine.service';

/**
 * The provider, as an audit actor.
 *
 * A confirmation caused by a webhook was not performed by the customer who
 * pressed Pay — it may land minutes later, on a different replica, after that
 * customer has closed the tab. Attributing it to them would make the audit
 * trail read as though a user confirmed a booking they never saw confirm.
 * `actor_id` is NULL because Paygate is not a row in `users`.
 */
export const PAYGATE_ACTOR: Actor = { type: 'PAYGATE', id: null };
