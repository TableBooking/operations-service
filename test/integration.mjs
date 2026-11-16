import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import pg from 'pg';
import amqp from 'amqplib';
import jwt from 'jsonwebtoken';

const project = path.resolve(import.meta.dirname,'..');
const require = createRequire(import.meta.url);
const Ajv = require('ajv').default;
const ajv = new Ajv({strict:false}); require('ajv-formats')(ajv);
const schemas = JSON.parse(fs.readFileSync(path.join(project,'src/contracts/http.json'),'utf8'));
const schemaValidators = new Map();
function schema(name,value) {
  if (!schemaValidators.has(name)) schemaValidators.set(name,ajv.compile({$ref:`#/components/schemas/${name}`,...schemas}));
  const validate = schemaValidators.get(name);
  assert.ok(validate(value),`${name}: ${JSON.stringify(validate.errors)}`);
}
const suffix = `${process.pid}-${Date.now()}`;
const dbName = `operations-test-pg-${suffix}`;
const mqName = `operations-test-mq-${suffix}`;
const created = new Set();
const secret = randomBytes(24).toString('hex');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(),'operations-integration-'));
const keys = generateKeyPairSync('rsa',{modulusLength:2048});
fs.writeFileSync(path.join(fixture,'public.pem'),keys.publicKey.export({type:'spki',format:'pem'}));
let app, db, connection, channel, base, clock, reservations, messaging;
let now = '2035-01-01T00:00:00Z';
const day = '2035-01-02';
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(check,timeout=20000) {
  const end=Date.now()+timeout;
  while (Date.now()<end) { const result=await check(); if (result) return result; await pause(100); }
  throw new Error('Timed out waiting for integration condition');
}
function docker(args) {
  const result=spawnSync('docker',args,{encoding:'utf8',timeout:180000,windowsHide:true});
  assert.equal(result.status,0,`docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function runDatabase(command) {
  const result=spawnSync(process.execPath,['--import','tsx','scripts/database.ts',command],{cwd:project,env:process.env,encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(result.status,0,`db:${command} failed: ${result.stderr}`);
  return result.stdout;
}
function token(role='STAFF',options={}) {
  return jwt.sign({role},keys.privateKey,{algorithm:'RS256',subject:'11111111-1111-4111-8111-111111111111',issuer:'restaurant-auth',audience:'restaurant-api',expiresIn:3600,...options});
}
async function api(route,method='GET',payload,role='STAFF',rawToken) {
  const response=await fetch(base+route,{method,headers:{...(role ? {authorization:`Bearer ${rawToken ?? token(role)}`} : {}),...(payload!==undefined ? {'content-type':'application/json'}:{})},body:payload===undefined ? undefined:JSON.stringify(payload)});
  return {status:response.status,body:await response.json(),correlation:response.headers.get('x-correlation-id')};
}
function event(type,id,data) { return {eventId:randomUUID(),eventType:type,schemaVersion:1,aggregateId:id,occurredAt:new Date().toISOString(),producer:'booking-service',correlationId:randomUUID(),data}; }
async function send(e) { const {publish}=await import('../dist/messaging/messaging.service.js'); await publish(channel,'restaurant.events',e.eventType,Buffer.from(JSON.stringify(e))); }
async function requested(size=4,slot=`${day}-dinner`) {
  const id=randomUUID(); const customerId=randomUUID();
  const e=event('booking.requested.v1',id,{customerId,email:'integration@example.test',slotId:slot,partySize:size});
  await send(e);
  await until(async()=> (await db.query('SELECT 1 FROM operations.reservations WHERE id=$1',[id])).rowCount);
  return {id,customerId,event:e};
}
async function act(id,action,version,extra={}) { return api(`/operations/reservations/${id}/${action}`,'POST',{expectedVersion:version,...extra}); }

before(async()=> {
  docker(['run','--rm','-d','--name',dbName,'-p','127.0.0.1::5432','-e',`POSTGRES_PASSWORD=${secret}`,'-e','POSTGRES_DB=operations_integration','postgres:17-alpine']); created.add(dbName);
  docker(['run','--rm','-d','--name',mqName,'-p','127.0.0.1::5672','-e','RABBITMQ_DEFAULT_USER=operations_test','-e',`RABBITMQ_DEFAULT_PASS=${secret}`,'rabbitmq:4-management']); created.add(mqName);
  const pgPort=docker(['port',dbName,'5432/tcp']).match(/:(\d+)$/)[1];
  const mqPort=docker(['port',mqName,'5672/tcp']).match(/:(\d+)$/)[1];
  await until(async()=> {
    const admin=new pg.Client({connectionString:`postgresql://postgres:${secret}@localhost:${pgPort}/operations_integration`});
    try {
      await admin.connect();
      await admin.query(`CREATE ROLE operations_test LOGIN PASSWORD '${secret}'`);
      await admin.query('CREATE SCHEMA operations AUTHORIZATION operations_test');
      await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      return true;
    } catch { return false; } finally { await admin.end().catch(()=>{}); }
  });
  Object.assign(process.env,{
    NODE_ENV:'test',DATABASE_URL:`postgresql://operations_test:${secret}@localhost:${pgPort}/operations_integration`,
    DB_SCHEMA:'operations',DB_SSL:'false',DB_SSL_CA_PATH:'',JWT_PUBLIC_KEY_PATH:path.join(fixture,'public.pem'),
    JWT_ISSUER:'restaurant-auth',JWT_AUDIENCE:'restaurant-api',
    RABBITMQ_URL:`amqp://operations_test:${secret}@localhost:${mqPort}`,RABBITMQ_EXCHANGE:'restaurant.events',RABBITMQ_QUEUE:'operations.requests.q',
  });
  assert.match(runDatabase('migrate'),/applied: 2/);
  assert.match(runDatabase('migrate'),/applied: 0/);
  runDatabase('seed'); runDatabase('seed');
  db=new pg.Pool({connectionString:process.env.DATABASE_URL,max:5});
  const {createApplication}=await import('../dist/bootstrap.js');
  const {Clock}=await import('../dist/operations/domain.js');
  const {ReservationService}=await import('../dist/operations/reservation.service.js');
  const {MessagingService}=await import('../dist/messaging/messaging.service.js');
  app=await createApplication(false);
  clock=app.get(Clock); clock.now=()=>new Date(now);
  reservations=app.get(ReservationService); messaging=app.get(MessagingService);
  await app.listen(0,'127.0.0.1'); base=`http://127.0.0.1:${app.getHttpServer().address().port}/api`;
  await until(async()=> (await api('/operations/health/ready')).status===200,40000);
  connection=await amqp.connect(process.env.RABBITMQ_URL);
  connection.on('error',()=>{});
  channel=await connection.createConfirmChannel(); channel.on('error',()=>{});
},{timeout:180000});
beforeEach(()=>{now='2035-01-01T00:00:00Z';});
after(async()=> {
  if (app) await app.close();
  if (channel) await channel.close().catch(()=>{});
  if (connection) await connection.close().catch(()=>{});
  if (db) await db.end();
  for (const name of created) { spawnSync('docker',['unpause',name],{encoding:'utf8',windowsHide:true}); spawnSync('docker',['stop',name],{encoding:'utf8',windowsHide:true,timeout:30000}); }
  const resolved=path.resolve(fixture);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'operations-integration-'));
  fs.rmSync(resolved,{recursive:true,force:true});
});

test('public APIs conform to HTTP contract and availability does not reserve',async()=> {
  for (const [route,type] of [['/restaurants/current','Restaurant'],['/restaurants/current/areas','AreaArray'],[`/slots?date=${day}`,'SlotArray'],[`/availability?date=${day}&slotCode=dinner&partySize=4`,'Availability']]) {
    const result=await api(route,'GET',undefined,null); assert.equal(result.status,200); schema(type,result.body);
  }
  const count=(await api(`/availability?date=${day}&slotCode=dinner&partySize=4`)).body.availableTableCount;
  assert.equal(count,3);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM operations.table_allocations')).rows[0].n,0);
  assert.equal((await api('/slots?date=2035-02-30')).status,400);
  assert.equal((await api(`/availability?date=${day}&slotCode=dinner&partySize=13`)).status,400);
  assert.equal((await api(`/slots?date=${day}&extra=x`)).status,400);
});
test('all protected route families verify JWT and roles locally',async()=> {
  for (const route of ['/operations/reservations','/operations/tables','/operations/areas','/operations/slot-configs',`/operations/stats/summary?date=${day}`]) {
    assert.equal((await api(route,'GET',undefined,null)).status,401);
    assert.equal((await api(route,'GET',undefined,'CUSTOMER')).status,403);
  }
  for (const bad of [token('STAFF',{audience:'wrong'}),token('STAFF',{issuer:'wrong'}),token('STAFF',{expiresIn:-60}),jwt.sign({role:'STAFF'},'bad',{algorithm:'HS256'})]) {
    assert.equal((await api('/operations/tables','GET',undefined,'STAFF',bad)).status,401);
  }
  assert.equal((await api('/operations/areas','POST',{id:'denied',name:'Denied'},'STAFF')).status,403);
  assert.equal((await api(`/operations/stats/summary?date=${day}`)).status,403);
});
test('manager CRUD covers areas, tables and slot configs with strict validation',async()=> {
  let r=await api('/operations/areas','POST',{id:'test-area',name:'Test area'},'MANAGER'); assert.equal(r.status,201); schema('Area',r.body);
  r=await api('/operations/areas/test-area','PATCH',{name:'Renamed'},'MANAGER'); assert.equal(r.status,200); schema('Area',r.body);
  assert.equal((await api('/operations/areas','GET')).status,200);
  assert.equal((await api('/operations/tables','POST',{id:'TEST-TABLE',areaId:'test-area',capacity:4},'MANAGER')).status,201);
  r=await api('/operations/tables/TEST-TABLE','PATCH',{name:'Renamed table',capacity:6},'MANAGER'); assert.equal(r.status,200); schema('Table',r.body);
  assert.equal((await api('/operations/areas/test-area','PATCH',{active:false},'MANAGER')).status,409);
  assert.equal((await api('/operations/tables/TEST-TABLE','PATCH',{active:false},'MANAGER')).status,200);
  assert.equal((await api('/operations/areas/test-area','PATCH',{active:false},'MANAGER')).status,200);
  assert.equal((await api('/operations/tables','POST',{id:'bad',areaId:'missing',capacity:4},'MANAGER')).status,404);
  assert.equal((await api('/operations/tables','POST',{id:'bad',areaId:'main',capacity:0},'MANAGER')).status,400);
  assert.equal((await api('/operations/tables','POST',{id:'bad',areaId:'main',capacity:4,active:false},'MANAGER')).status,400);
  assert.equal((await api('/operations/tables/T01','PATCH',{},'MANAGER')).status,400);
  assert.equal((await api('/operations/areas/test-area','PATCH',{id:'changed'},'MANAGER')).status,400);
  await db.query("DELETE FROM operations.service_slot_configs WHERE code='lunch'"); // isolated test DB only
  r=await api('/operations/slot-configs','POST',{code:'lunch',startsAtLocal:'11:30',endsAtLocal:'13:00'},'MANAGER'); assert.equal(r.status,201); schema('SlotConfig',r.body);
  assert.equal((await api('/operations/slot-configs/lunch','PATCH',{startsAtLocal:'11:15'},'MANAGER')).status,200);
  assert.equal((await api('/operations/slot-configs/lunch','PATCH',{endsAtLocal:'10:00'},'MANAGER')).status,400);
  assert.equal((await api('/operations/slot-configs','POST',{code:'lunch',startsAtLocal:'11:30',endsAtLocal:'13:00'},'MANAGER')).status,409);
  schema('SlotConfigArray',(await api('/operations/slot-configs')).body);
});
test('requested consumer deduplicates delivery and aggregate, emits valid v1 state',async()=> {
  const r=await requested(); await send(r.event); await send({...r.event,eventId:randomUUID()});
  await until(async()=> (await db.query('SELECT count(*)::int AS n FROM operations.inbox_events WHERE aggregate_id=$1',[r.id])).rows[0].n===2);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM operations.outbox_events WHERE aggregate_id=$1',[r.id])).rows[0].n,1);
  const result=await api(`/operations/reservations/${r.id}`); assert.equal(result.status,200); schema('Reservation',result.body); assert.equal(result.body.version,1);
  const list=await api(`/operations/reservations?date=${day}&state=REQUESTED&page=1&limit=1`); schema('ReservationList',list.body); assert.equal(list.body.data.length,1);
  assert.equal((await api('/operations/reservations?state=INVALID')).status,400);
  assert.equal((await api('/operations/reservations/not-uuid')).status,400);
  assert.equal((await api(`/operations/reservations/${randomUUID()}`)).status,404);
});
test('confirm validates capacity, reason, state, stale version; concurrent table race commits once',async()=> {
  const a=await requested(), b=await requested();
  assert.equal((await act(a.id,'confirm',1,{tableId:'T01'})).status,409);
  assert.equal((await act(a.id,'confirm',1,{tableId:'TEST-TABLE'})).status,409);
  assert.equal((await act(a.id,'reject',1,{reason:' '})).status,400);
  assert.equal((await act(a.id,'complete',1)).status,409);
  const race=await Promise.all([act(a.id,'confirm',1,{tableId:'T02'}),act(b.id,'confirm',1,{tableId:'T02'})]);
  assert.deepEqual(race.map(x=>x.status).sort(),[200,409]);
  const winner=race[0].status===200?a:b;
  schema('TransitionResult',race.find(x=>x.status===200).body);
  const stale=await act(winner.id,'check-in',1); assert.equal(stale.status,409); assert.equal(stale.body.code,'RESERVATION_VERSION_CONFLICT'); assert.equal(stale.body.details.actualVersion,2);
  assert.ok(stale.correlation);
  assert.equal((await api('/operations/tables/T02','PATCH',{capacity:5},'MANAGER')).status,409);
  assert.equal((await api('/operations/slot-configs/dinner','PATCH',{startsAtLocal:'18:30'},'MANAGER')).status,409);
  const rejected=await requested(); assert.equal((await act(rejected.id,'reject',1,{reason:'No suitable table'})).status,200);
});
test('check-in boundaries, seating and completion retain historical allocation',async()=> {
  const r=await requested(2,`${day}-lunch`); assert.equal((await act(r.id,'confirm',1,{tableId:'T01'})).status,200);
  now=`${day}T03:44:59Z`; assert.equal((await act(r.id,'check-in',2)).status,409); // lunch starts 11:15 local
  now=`${day}T03:45:00Z`; assert.equal((await act(r.id,'check-in',2)).status,200);
  assert.equal((await act(r.id,'seat',3,{tableId:'T04'})).status,409);
  assert.equal((await act(r.id,'seat',3,{tableId:'T01'})).status,200);
  const command=event('booking.cancel-requested.v1',r.id,{commandId:randomUUID(),customerId:r.customerId}); await send(command);
  await until(async()=> (await db.query('SELECT 1 FROM operations.processed_commands WHERE command_id=$1',[command.data.commandId])).rowCount);
  assert.equal((await api(`/operations/reservations/${r.id}`)).body.state,'SEATED');
  assert.equal((await act(r.id,'complete',4)).status,200);
  assert.equal((await db.query('SELECT released_at FROM operations.table_allocations WHERE booking_id=$1',[r.id])).rows[0].released_at,null);
});
test('no-show observes grace boundary and releases allocation',async()=> {
  const r=await requested(2,`${day}-lunch`); // T03 is separate from completed T01
  assert.equal((await act(r.id,'confirm',1,{tableId:'T03'})).status,200);
  now=`${day}T04:30:00Z`; assert.equal((await act(r.id,'no-show',2)).status,409);
  now=`${day}T04:30:00.001Z`; assert.equal((await act(r.id,'no-show',2)).status,200);
  assert.notEqual((await db.query('SELECT released_at FROM operations.table_allocations WHERE booking_id=$1',[r.id])).rows[0].released_at,null);
});
test('cancel before requested preserves command metadata and generates versions 1 then 2',async()=> {
  const id=randomUUID(),customerId=randomUUID(),commandId=randomUUID();
  const command=event('booking.cancel-requested.v1',id,{commandId,customerId,reason:'Changed plans'}); await send(command);
  await until(async()=> (await db.query('SELECT 1 FROM operations.pending_cancellations WHERE command_id=$1',[commandId])).rowCount);
  await send(event('booking.requested.v1',id,{customerId,email:'pending@example.test',slotId:`${day}-dinner`,partySize:2}));
  await until(async()=> (await db.query('SELECT state FROM operations.reservations WHERE id=$1',[id])).rows[0]?.state==='CANCELLED');
  const events=(await db.query('SELECT payload FROM operations.outbox_events WHERE aggregate_id=$1 ORDER BY (payload->>\'aggregateVersion\')::int',[id])).rows.map(x=>x.payload);
  assert.deepEqual(events.map(e=>e.aggregateVersion),[1,2]); assert.equal(events[1].data.commandId,commandId); assert.equal(events[1].correlationId,command.correlationId); assert.equal(events[1].data.reason,'Changed plans');
  await send({...command,eventId:randomUUID()}); await pause(200);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM operations.processed_commands WHERE command_id=$1',[commandId])).rows[0].n,1);
});
test('cancellation enforces ownership and deadline; successful cancellation frees the table',async()=> {
  const r=await requested(2); assert.equal((await act(r.id,'confirm',1,{tableId:'T04'})).status,200);
  const wrong=event('booking.cancel-requested.v1',r.id,{commandId:randomUUID(),customerId:randomUUID()}); await send(wrong);
  await until(async()=> (await db.query('SELECT 1 FROM operations.processed_commands WHERE command_id=$1',[wrong.data.commandId])).rowCount);
  assert.equal((await api(`/operations/reservations/${r.id}`)).body.state,'CONFIRMED');
  const accepted=event('booking.cancel-requested.v1',r.id,{commandId:randomUUID(),customerId:r.customerId}); await send(accepted);
  await until(async()=> (await db.query('SELECT state FROM operations.reservations WHERE id=$1',[r.id])).rows[0].state==='CANCELLED');
  assert.notEqual((await db.query('SELECT released_at FROM operations.table_allocations WHERE booking_id=$1',[r.id])).rows[0].released_at,null);
  const late=await requested(2); now=`${day}T09:00:00Z`;
  const tooLate=event('booking.cancel-requested.v1',late.id,{commandId:randomUUID(),customerId:late.customerId}); await send(tooLate);
  await until(async()=> (await db.query('SELECT 1 FROM operations.processed_commands WHERE command_id=$1',[tooLate.data.commandId])).rowCount);
  assert.equal((await api(`/operations/reservations/${late.id}`)).body.state,'REQUESTED');
});
test('HTTP staff cancellation uses expectedVersion/reason and manager stats conform',async()=> {
  const r=await requested(); assert.equal((await act(r.id,'cancel',1,{reason:'Customer called'})).status,200);
  const stats=await api(`/operations/stats/summary?date=${day}`,'GET',undefined,'MANAGER'); assert.equal(stats.status,200); schema('StatsSummary',stats.body); assert.ok(stats.body.cancelled>0);
  now=`${day}T12:00:00Z`;
  assert.equal((await api(`/availability?date=${day}&slotCode=dinner&partySize=2`)).body.availableTableCount,0);
});
test('poison payload reaches DLQ; confirm mandatory return is detected',async()=> {
  const {publish}=await import('../dist/messaging/messaging.service.js');
  await assert.rejects(publish(channel,'restaurant.events','unbound.invalid',Buffer.from('{}')));
  await publish(channel,'restaurant.events','booking.requested.v1',Buffer.from('not-json'));
  await until(async()=> (await channel.checkQueue('operations.requests.q.dlq')).messageCount>0);
  const message=await channel.get('operations.requests.q.dlq',{noAck:false}); assert.equal(message.content.toString(),'not-json'); channel.ack(message);
});
test('transient consumer failure retries finitely then dead-letters without inserting inbox',async()=> {
  const original=reservations.receive.bind(reservations);
  const id=randomUUID(); let failures=0;
  reservations.receive=async e=>{if(e.aggregateId===id){failures++;throw new Error('Simulated temporary database failure');}return original(e);};
  try {
    await send(event('booking.requested.v1',id,{customerId:randomUUID(),email:'retry@example.test',slotId:`${day}-dinner`,partySize:2}));
    await until(async()=> (await channel.checkQueue('operations.requests.q.dlq')).messageCount>0,30000);
    const message=await channel.get('operations.requests.q.dlq',{noAck:false}); channel.ack(message);
    assert.equal(JSON.parse(message.content).aggregateId,id); assert.equal(failures,4);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM operations.inbox_events WHERE aggregate_id=$1',[id])).rows[0].n,0);
  } finally { reservations.receive=original; }
});
test('orphan pending cancellation expires into a correlated rejection',async()=> {
  const id=randomUUID(); const command=event('booking.cancel-requested.v1',id,{commandId:randomUUID(),customerId:randomUUID()}); await send(command);
  await until(async()=> (await db.query('SELECT 1 FROM operations.pending_cancellations WHERE command_id=$1',[command.data.commandId])).rowCount);
  await db.query("UPDATE operations.pending_cancellations SET received_at=now()-interval '25 hours' WHERE command_id=$1",[command.data.commandId]);
  await reservations.expirePending();
  const result=(await db.query('SELECT payload FROM operations.outbox_events WHERE aggregate_id=$1',[id])).rows[0].payload;
  assert.equal(result.data.reason,'BOOKING_NOT_RECEIVED'); assert.equal(result.correlationId,command.correlationId);
});
test('broker pause does not block HTTP commit; outbox recovers and independent queues retain events',async()=> {
  const r=await requested(2,`2035-01-03-dinner`);
  docker(['pause',mqName]);
  try {
    const response=await act(r.id,'confirm',1,{tableId:'T01'}); assert.equal(response.status,200);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM operations.outbox_events WHERE aggregate_id=$1 AND published_at IS NULL',[r.id])).rows[0].n>0,true);
    await pause(6500); // exercise the 5-second publisher-confirm timeout
    assert.ok((await db.query('SELECT count(*)::int AS n FROM operations.outbox_events WHERE aggregate_id=$1 AND published_at IS NULL',[r.id])).rows[0].n>0);
  } finally { docker(['unpause',mqName]); }
  await until(async()=> (await db.query('SELECT count(*)::int AS n FROM operations.outbox_events WHERE aggregate_id=$1 AND published_at IS NULL',[r.id])).rows[0].n===0,30000);
  assert.ok((await channel.checkQueue('notification.lifecycle.q')).messageCount>0);
  assert.ok((await channel.checkQueue('tracking.lifecycle.q')).messageCount>0);
  const {validateEvent}=await import('../dist/messaging/events.js');
  for(const queue of ['booking.lifecycle.q','tracking.lifecycle.q','notification.lifecycle.q']) {
    let message; let count=0;
    while((message=await channel.get(queue,{noAck:false}))) { validateEvent(JSON.parse(message.content)); channel.ack(message); count++; }
    assert.ok(count>0);
  }
});
test('broker application restart reconnects consumer and drains durable outbox',async()=> {
  const r=await requested(2,'2035-01-04-dinner');
  docker(['exec',mqName,'rabbitmqctl','stop_app']);
  try {
    await until(()=>!messaging.connected);
    assert.equal((await api('/operations/health/ready')).status,503);
    assert.equal((await act(r.id,'confirm',1,{tableId:'T01'})).status,200);
    assert.ok((await db.query('SELECT count(*)::int AS n FROM operations.outbox_events WHERE aggregate_id=$1 AND published_at IS NULL',[r.id])).rows[0].n>0);
  } finally { docker(['exec',mqName,'rabbitmqctl','start_app']); }
  await until(()=>messaging.connected,30000);
  await until(async()=> (await db.query('SELECT count(*)::int AS n FROM operations.outbox_events WHERE aggregate_id=$1 AND published_at IS NULL',[r.id])).rows[0].n===0,30000);
  assert.equal((await api('/operations/health/ready')).status,200);
  // Publish a new command after reconnect to prove the consumer was re-registered.
  connection=await amqp.connect(process.env.RABBITMQ_URL);connection.on('error',()=>{});
  channel=await connection.createConfirmChannel();channel.on('error',()=>{});
  const afterRestart=await requested(2,'2035-01-05-dinner');
  assert.equal((await api(`/operations/reservations/${afterRestart.id}`)).body.state,'REQUESTED');
});
