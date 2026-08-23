import { Controller, Get, Query } from '@nestjs/common';
import { SearchService } from './search.service';
import { SearchSchema, type SearchQuery } from '../bookings/bookings.schemas';
import { zodBody } from '../common/pipes/zod-validation.pipe';

@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  /**
   * Cross-venue room search. Every filter is combinable and every filter is
   * optional; `filters_applied` in the response names the ones that actually
   * took effect, so a caller can tell "no results" from "my parameter was
   * ignored".
   */
  @Get()
  find(@Query(zodBody(SearchSchema)) query: SearchQuery) {
    return this.search.search(query);
  }
}
