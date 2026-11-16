import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { Clock, areaDto, calendar, configDto, date, fail, lockCatalog, restaurant, slotParts, tableDto, type Row } from './domain.js';

@Injectable()
export class CatalogService {
  constructor(@Inject(DataSource) private readonly db: DataSource, @Inject(Clock) private readonly clock: Clock) {}
  async current() {
    const r = await restaurant(this.db.manager);
    return { id:r.id, name:r.name, timezone:r.timezone, address:r.address, ...(r.phone ? {phone:r.phone}:{}),
      cancelBeforeMinutes:r.cancel_before_minutes, checkinEarlyMinutes:r.checkin_early_minutes, noShowAfterMinutes:r.no_show_after_minutes };
  }
  async areas(publicOnly = false) {
    return (await this.db.query(`SELECT * FROM operations.dining_areas ${publicOnly ? 'WHERE active' : ''} ORDER BY id`)).map(areaDto);
  }
  async tables() { return (await this.db.query('SELECT * FROM operations.dining_tables ORDER BY id')).map(tableDto); }
  async configs() { return (await this.db.query('SELECT * FROM operations.service_slot_configs ORDER BY starts_at_local')).map(configDto); }
  async slots(day: string) {
    date(day);
    const configs = await this.db.query('SELECT code FROM operations.service_slot_configs WHERE active ORDER BY starts_at_local');
    return Promise.all(configs.map(async ({code}: Row) => {
      const c = await calendar(this.db.manager, `${day}-${code}`);
      return {code, date:day, startsAt:c.start.toISO(), endsAt:c.end.toISO(), bookingOpen:c.start.toMillis() > this.clock.now().getTime()};
    }));
  }
  async availability(day: string, code: string, size: number) {
    const c = await calendar(this.db.manager, `${date(day)}-${code}`);
    const [{count}] = await this.db.query(`SELECT count(*)::int AS count FROM operations.dining_tables t
      JOIN operations.dining_areas a ON a.id=t.area_id
      WHERE t.active AND a.active AND a.restaurant_id=$3 AND t.capacity >= $1
      AND NOT EXISTS(SELECT 1 FROM operations.table_allocations x WHERE x.table_id=t.id AND x.slot_id=$2 AND x.released_at IS NULL)`, [size,`${day}-${code}`,c.rest.id]);
    const availableTableCount = c.config.active && c.start.toMillis() > this.clock.now().getTime() ? count : 0;
    return {date:day, slotCode:code, partySize:size, available:availableTableCount > 0, availableTableCount, note:'Advisory only; no table is held until confirmation'};
  }
  async mutate(kind: 'areas'|'tables'|'slot-configs', id: string | undefined, data: Row) {
    return this.db.transaction(async tx => {
      await lockCatalog(tx, true);
      const rest = await restaurant(tx);
      if (id && (data.id !== undefined && data.id !== id || data.code !== undefined && data.code !== id)) fail(400,'IMMUTABLE_ID','Body identifier must match the path');
      if (kind === 'areas') {
        const [current] = id ? await tx.query('SELECT * FROM operations.dining_areas WHERE id=$1', [id]) : [];
        if (id && !current) fail(404,'AREA_NOT_FOUND','Area not found');
        if (id && data.active === false) {
          const [active] = await tx.query('SELECT 1 FROM operations.dining_tables WHERE area_id=$1 AND active LIMIT 1',[id]);
          if (active) fail(409,'AREA_HAS_ACTIVE_TABLES','Deactivate child tables before disabling the area');
        }
        const [row] = id ? await tx.query('UPDATE operations.dining_areas SET name=$2,active=$3 WHERE id=$1 RETURNING *',[id,data.name ?? current.name,data.active ?? current.active])
          : await tx.query('INSERT INTO operations.dining_areas(id,restaurant_id,name,active) VALUES($1,$2,$3,$4) RETURNING *',[data.id,rest.id,data.name,data.active ?? true]);
        return areaDto(Array.isArray(row) ? row[0] : row);
      }
      if (kind === 'tables') {
        const [current] = id ? await tx.query('SELECT * FROM operations.dining_tables WHERE id=$1',[id]) : [];
        if (id && !current) fail(404,'TABLE_NOT_FOUND','Table not found');
        const areaId = data.areaId ?? current?.area_id;
        const [area] = await tx.query('SELECT * FROM operations.dining_areas WHERE id=$1 AND restaurant_id=$2',[areaId,rest.id]);
        if (!area) fail(404,'AREA_NOT_FOUND','Area not found');
        if (!area.active && (data.active ?? current?.active ?? true)) fail(409,'AREA_INACTIVE','An active table requires an active area');
        if (current && ((data.active === false && current.active) || (data.capacity !== undefined && data.capacity !== current.capacity) || areaId !== current.area_id)) {
          const allocations = await tx.query(`SELECT r.slot_id FROM operations.table_allocations x JOIN operations.reservations r ON r.id=x.booking_id
            WHERE x.table_id=$1 AND x.released_at IS NULL AND r.state IN ('CONFIRMED','CHECKED_IN','SEATED')`,[id]);
          for (const r of allocations) if ((await calendar(tx,r.slot_id)).end.toMillis() > this.clock.now().getTime()) fail(409,'TABLE_HAS_RESERVATIONS','Table has current or future reservations');
        }
        const [row] = id ? await tx.query('UPDATE operations.dining_tables SET area_id=$2,name=$3,capacity=$4,active=$5 WHERE id=$1 RETURNING *',[id,areaId,data.name ?? current.name,data.capacity ?? current.capacity,data.active ?? current.active])
          : await tx.query('INSERT INTO operations.dining_tables(id,area_id,name,capacity) VALUES($1,$2,$3,$4) RETURNING *',[data.id,areaId,data.name ?? null,data.capacity]);
        return tableDto(Array.isArray(row) ? row[0] : row);
      }
      const [current] = id ? await tx.query('SELECT * FROM operations.service_slot_configs WHERE code=$1',[id]) : [];
      if (id && !current) fail(404,'SLOT_NOT_FOUND','Slot configuration not found');
      const code = id ?? data.code;
      if (!['lunch','dinner'].includes(code)) fail(400,'INVALID_SLOT_CODE','V2 slot codes are lunch and dinner');
      const start = data.startsAtLocal ?? current?.starts_at_local?.slice(0,5);
      const end = data.endsAtLocal ?? current?.ends_at_local?.slice(0,5);
      if (![start,end].every(t => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t)) || end <= start) fail(400,'INVALID_SLOT_TIME','Slots must end after their start on the same local date');
      if (current && (start !== current.starts_at_local.slice(0,5) || end !== current.ends_at_local.slice(0,5) || (data.active === false && current.active))) {
        const rows = await tx.query("SELECT DISTINCT slot_id FROM operations.reservations WHERE state IN ('REQUESTED','CONFIRMED','CHECKED_IN','SEATED') AND slot_id LIKE $1",[`%-${code}`]);
        for (const r of rows) if ((await calendar(tx,r.slot_id)).end.toMillis() > this.clock.now().getTime()) fail(409,'SLOT_HAS_RESERVATIONS','Cannot change a slot with current or future reservations');
      }
      const [row] = id ? await tx.query('UPDATE operations.service_slot_configs SET starts_at_local=$2,ends_at_local=$3,active=$4 WHERE code=$1 RETURNING *',[id,start,end,data.active ?? current.active])
        : await tx.query('INSERT INTO operations.service_slot_configs(code,restaurant_id,starts_at_local,ends_at_local,active) VALUES($1,$2,$3,$4,$5) RETURNING *',[code,rest.id,start,end,data.active ?? true]);
      return configDto(Array.isArray(row) ? row[0] : row);
    });
  }
}
