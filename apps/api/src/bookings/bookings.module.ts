import { Module } from '@nestjs/common';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { BookingStateMachine } from './booking-state-machine.service';
import { HoldSweeper } from './hold-sweeper.service';
import { AvailabilityService } from '../rooms/availability.service';
import { RoomsController } from '../rooms/rooms.controller';
import { SearchController } from '../search/search.controller';
import { SearchService } from '../search/search.service';
import { StateMachineModule } from './state-machine.module';
import { PaymentsModule } from '../payments/payments.module';
import { DB, ENV_TOKEN } from '../app.tokens';
import type { Db } from '../db/client';
import type { Env } from '../config/env';

/**
 * The booking core.
 *
 * `Db` and `Env` are plain values rather than classes, so every service here is
 * constructed by a factory. That is more verbose than `@Inject()` decorators
 * but it keeps the services free of Nest-specific parameter metadata, which is
 * what lets the state machine be unit tested against a bare transaction handle
 * without standing up a container.
 */
@Module({
  // PaymentsModule for the cancellation refund; StateMachineModule because the
  // state machine is shared with it and neither may own the other.
  imports: [StateMachineModule, PaymentsModule],
  controllers: [BookingsController, RoomsController, SearchController],
  providers: [
    {
      provide: AvailabilityService,
      inject: [DB, ENV_TOKEN],
      useFactory: (db: Db, env: Env) => new AvailabilityService(db, env),
    },
    {
      provide: SearchService,
      inject: [DB, AvailabilityService],
      useFactory: (db: Db, availability: AvailabilityService) =>
        new SearchService(db, availability),
    },
    {
      provide: BookingsService,
      inject: [DB, BookingStateMachine, ENV_TOKEN],
      useFactory: (db: Db, sm: BookingStateMachine, env: Env) =>
        new BookingsService(db, sm, env),
    },
    {
      provide: HoldSweeper,
      inject: [DB, BookingStateMachine, ENV_TOKEN],
      useFactory: (db: Db, sm: BookingStateMachine, env: Env) =>
        new HoldSweeper(db, sm, env),
    },
  ],
  exports: [StateMachineModule, BookingsService, AvailabilityService],
})
export class BookingsModule {}
