import { Module } from '@nestjs/common';
import { BookingStateMachine } from './booking-state-machine.service';

/**
 * The state machine, on its own, so that both the booking core and the payment
 * path can depend on it without depending on each other.
 *
 * Without this split the graph is a cycle: payments need the state machine to
 * confirm a booking, and the booking core needs payments to settle a
 * cancellation refund. `forwardRef` would paper over that, at the cost of a
 * container that only resolves by luck of instantiation order. Extracting the
 * one thing both genuinely share is the honest fix, and it reinforces CLAUDE.md
 * hard rule 1: `bookings.status` has exactly one writer, and that writer is a
 * module of its own rather than a service borrowed from a feature.
 */
@Module({
  providers: [BookingStateMachine],
  exports: [BookingStateMachine],
})
export class StateMachineModule {}
