import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Public, Roles, type AuthenticatedRequest } from '../auth/auth.js';
import { CatalogService } from './catalog.service.js';
import { ReservationService } from './reservation.service.js';
import { date, uuid } from './domain.js';
import { body, positive, query } from './validation.js';

@Public()
@Controller()
export class PublicController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}
  @Get('restaurants/current') current() { return this.catalog.current(); }
  @Get('restaurants/current/areas') areas() { return this.catalog.areas(true); }
  @Get('slots') slots(@Query() q: Record<string,unknown>) {
    query(q,['date']); return this.catalog.slots(date(q.date));
  }
  @Get('availability') availability(@Query() q: Record<string,unknown>) {
    query(q,['date','slotCode','partySize']); return this.catalog.availability(date(q.date),String(q.slotCode ?? ''),positive(q.partySize,undefined,12));
  }
}
@Roles('STAFF','MANAGER')
@Controller('operations')
export class OperationsController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(ReservationService) private readonly reservations: ReservationService) {}
  @Get('reservations') list(@Query() q: Record<string,unknown>) {
    query(q,['date','slotId','state','page','limit']); return this.reservations.list(q,positive(q.page,1,100000),positive(q.limit,20));
  }
  @Get('reservations/:id') detail(@Param('id') id: string) { return this.reservations.detail(uuid(id)); }
  @Post('reservations/:id/:action') @HttpCode(200)
  transition(@Param('id') id: string,@Param('action') action: string,@Body() input: unknown,@Req() req: AuthenticatedRequest) {
    return this.reservations.transition(uuid(id),action,body('TransitionInput',input),req.user!.id,String(req.headers['x-correlation-id']));
  }
  @Get('tables') tables() { return this.catalog.tables(); }
  @Post('tables') @Roles('MANAGER') addTable(@Body() input: unknown) { return this.catalog.mutate('tables',undefined,body('TableInput',input)); }
  @Patch('tables/:id') @Roles('MANAGER') editTable(@Param('id') id: string,@Body() input: unknown) { return this.catalog.mutate('tables',id,body('TablePatch',input,true)); }
  @Get('areas') areas() { return this.catalog.areas(); }
  @Post('areas') @Roles('MANAGER') addArea(@Body() input: unknown) { return this.catalog.mutate('areas',undefined,body('AreaInput',input)); }
  @Patch('areas/:id') @Roles('MANAGER') editArea(@Param('id') id: string,@Body() input: unknown) { return this.catalog.mutate('areas',id,body('AreaInput',input,true)); }
  @Get('slot-configs') configs() { return this.catalog.configs(); }
  @Post('slot-configs') @Roles('MANAGER') addConfig(@Body() input: unknown) { return this.catalog.mutate('slot-configs',undefined,body('SlotConfigInput',input)); }
  @Patch('slot-configs/:code') @Roles('MANAGER') editConfig(@Param('code') code: string,@Body() input: unknown) { return this.catalog.mutate('slot-configs',code,body('SlotConfigInput',input,true)); }
  @Get('stats/summary') @Roles('MANAGER') stats(@Query() q: Record<string,unknown>) { query(q,['date']); return this.reservations.stats(date(q.date)); }
}
