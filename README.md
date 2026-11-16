# TableBooking — Operations V2

Service NestJS + TypeORM chịu trách nhiệm restaurant/areas/tables/slots, reservation state machine và phân bàn. Source chỉ nằm trong operation-service; không sửa gateway hoặc service khác. Gateway chạy 8080, Operations chạy 3003 và giữ prefix /api.

## Clone và chạy Docker

```bash
git clone https://github.com/TableBooking/operations-service.git
cd operations-service
```

Làm theo **[hướng dẫn Docker](docs/docker.md)** để tạo `.env`, lấy public key/CA, thiết lập schema Supabase và chạy migration/seed ngay trong container. Luồng Docker này không cần Node trên máy host. Repository không chứa `.env` hoặc các file key thực tế.

Sau khi chuẩn bị cấu hình:

```bash
docker compose --profile app build operation-service
docker compose --profile app run --rm --no-deps operation-service node dist/database/cli.js migrate
docker compose --profile app run --rm --no-deps operation-service node dist/database/cli.js seed
docker compose --profile app up -d --wait
```

Service: http://localhost:3003 · RabbitMQ management: http://localhost:15672.

## Chạy trên máy hiện tại

Supabase đã có schema operations, login riêng operations_user và 2 migration. File .env giữ connection URL; public key và CA mount read-only vào container. Không ghi đè .env bằng file mẫu.

~~~powershell
cd D:\VSC_PWD\TableBooking\operation-service
npm.cmd ci
npm.cmd run db:migrate
npm.cmd run docker:up
docker compose --profile app ps
~~~

Health: http://localhost:3003/api/operations/health/live và /ready. Ready kiểm tra DB, migration metadata và kết nối RabbitMQ; live chỉ kiểm tra tiến trình. Khi broker mất kết nối, các lệnh HTTP vẫn có thể commit DB/outbox; relay tự nối lại.

Dev trên Windows: chạy npm.cmd run docker:stop trước để nhường cổng 3003, sau đó npm.cmd run start:dev. Khi quay lại container, dừng dev bằng Ctrl+C và chạy npm.cmd run docker:up.

Gateway dev hiện có: docker start tablebooking-gateway-dev. Đích gateway container là http://host.docker.internal:3003. Không cần sửa source gateway.

## Cấu hình

- Node 24 LTS; dependencies đã khóa bằng package-lock.json.
- DATABASE_URL: PostgreSQL URL Supabase Session pooler IPv4, port 5432. Dùng login Operations, không dùng tài khoản admin cho ứng dụng.
- DB_SCHEMA=operations; synchronize=false, migrationsRun=false. Chạy migration rõ ràng trước khi deploy.
- DB_SSL=true, DB_SSL_CA_PATH=./certs/supabase-ca.crt. CA được tải từ Supabase downloads và giữ rejectUnauthorized=true.
- JWT_PUBLIC_KEY_PATH=./keys/auth-public.pem; RS256, issuer restaurant-auth, audience restaurant-api. Mọi API protected tự verify JWT, không tin identity header từ gateway.
- RABBITMQ_URL cho chạy host trỏ broker dev localhost:5672. Compose thay URL nội bộ thành rabbitmq:5672.
- RABBITMQ_EXCHANGE=restaurant.events; RABBITMQ_QUEUE=operations.requests.q.
- .env, private keys, node_modules, dist không được commit hoặc đưa vào gói source. Service chỉ dùng public key.

Project Supabase mới: tạo login/schema theo quyền riêng, đặt URL và CA, rồi db:migrate và db:seed. Seed idempotent chỉ tạo rest-001, main/garden, T01–T04, lunch/dinner; không tạo booking giả. Không chạy schema baseline để nâng cấp dữ liệu V1.

Migration 2 bổ sung event_payload JSONB và index received_at cho pending_cancellations; giữ metadata/correlation của lệnh hủy đến trước booking. Không xóa hoặc đổi bảng nghiệp vụ đã có.

## 17 API theo OpenAPI V2

| Method | Path sau /api | Quyền |
|---|---|---|
| GET | /restaurants/current | Public |
| GET | /restaurants/current/areas | Public |
| GET | /slots?date=YYYY-MM-DD | Public |
| GET | /availability?date=...&slotCode=dinner&partySize=4 | Public |
| GET | /operations/reservations?date=...&slotId=...&state=...&page=1&limit=20 | STAFF, MANAGER |
| GET | /operations/reservations/:id | STAFF, MANAGER |
| POST | /operations/reservations/:id/:action | STAFF, MANAGER |
| GET | /operations/tables | STAFF, MANAGER |
| POST | /operations/tables | MANAGER |
| PATCH | /operations/tables/:id | MANAGER |
| GET | /operations/areas | STAFF, MANAGER |
| POST | /operations/areas | MANAGER |
| PATCH | /operations/areas/:id | MANAGER |
| GET | /operations/slot-configs | STAFF, MANAGER |
| POST | /operations/slot-configs | MANAGER |
| PATCH | /operations/slot-configs/:code | MANAGER |
| GET | /operations/stats/summary?date=YYYY-MM-DD | MANAGER |

Action: confirm, reject, check-in, seat, complete, no-show, cancel. Tất cả cần expectedVersion >= 1; confirm cần tableId; reject/cancel cần reason không rỗng. cancel của nhân viên có trong OpenAPI hiện tại và dùng cùng policy thời gian.

~~~json
{"expectedVersion":1,"tableId":"T02"}
~~~

GET list trả {data,meta}; reservation dùng bookingId, version, customerId, slotId, partySize, state và tableId khi có. Không lộ email/phone trong response ngoài contract. Optional field null được bỏ khi schema yêu cầu string.

Body được validate bằng schema trích từ OpenAPI; từ chối field lạ. PATCH nhận cả body đầy đủ hoặc partial; id/code nếu có phải khớp path. Page/limit >= 1, limit tối đa 100. Lỗi có {code,message,correlationId,details?}; stale version/trùng bàn/trạng thái sai là 409; thiếu/sai JWT 401; sai role 403. Không trả SQL/credential ra response.

MVP cố định lunch/dinner theo contract slotId. Không thêm mã ca khác khi chưa version contract. Stats total gồm mọi state; các field breakdown trả đúng schema StatsSummary.

## Transaction và policy

- Operations là single writer của state/version. Không có POST tạo reservation trực tiếp từ frontend; nhận từ Booking event.
- Inbox + thay đổi reservation/allocation + outbox nằm trong cùng transaction; ACK sau commit.
- Advisory transaction lock theo booking xử lý cả race khi reservation chưa tồn tại. Catalog dùng shared/exclusive advisory lock để cấu hình không thay đổi giữa lúc confirm.
- Confirm kiểm tra expectedVersion, REQUESTED, slot còn mở, active area/table, capacity và partial unique index table_id/slot_id. Hai staff tranh cùng bàn chỉ một transaction commit.
- Slot timestamp được tính bằng Luxon theo timezone nhà hàng, mặc định Asia/Ho_Chi_Minh. Clock injectable để test các biên thời gian.
- Cancel REQUESTED/CONFIRMED chỉ trước start - cancel_before_minutes; kiểm tra customerId của command.
- Check-in từ start - checkin_early_minutes tới start + no_show_after_minutes, gồm hai biên. No-show chỉ sau biên cuối, chưa check-in.
- CHECKED_IN → SEATED → COMPLETED. Seat dùng đúng allocation. CANCELLED/NO_SHOW release allocation; COMPLETED giữ lịch sử chiếm slot.
- Không đổi capacity/area hoặc tắt bàn có allocation current/future còn hiệu lực. Không tắt khu vực còn bàn active. Không đổi giờ/tắt ca có reservation current/future chưa kết thúc.
- Không có chức năng đổi bàn sau confirm vì schema giữ UNIQUE(booking_id).

## Messaging

Bản sao schema HTTP/event đã frozen trong src/contracts; file gốc trong docs nhóm không bị thay đổi.

Consume:
- booking.requested.v1: tạo REQUESTED version 1 và state event. Dedup eventId và bookingId.
- booking.cancel-requested.v1: kiểm tra ownership/state/deadline; thành công phát state-changed kèm commandId, thất bại phát cancellation-rejected.

Produce:
- booking.state-changed.v1
- booking.cancellation-rejected.v1

Giữ data.email của event và contact_email của DB đúng mapping V2. Không gọi HTTP Booking/Auth/Notification trong transaction nghiệp vụ.

Topology durable:
- restaurant.events (topic), restaurant.retry, restaurant.dlx.
- operations.requests.q bind hai command; retry queue TTL 5 giây; operations.requests.q.dlq.
- booking.lifecycle.q nhận state + cancellation result.
- tracking.lifecycle.q và notification.lifecycle.q nhận state, là queue riêng.
- Lifecycle queues được provision trước khi publish, kể cả consumer khác chưa chạy. Khi ghép broker có sẵn, các bên phải thống nhất tên, bindings và DLX arguments; không xóa queue để xử lý lỗi PRECONDITION_FAILED.

Consumer manual ACK sau commit; lỗi tạm retry tối đa 3 lần rồi DLQ; JSON/schema/domain command không hợp lệ đi DLQ trực tiếp. Retry/DLQ publish dùng persistent message, mandatory return và publisher confirm trước khi ACK delivery cũ. Replay từ DLQ phải giữ eventId.

Outbox relay dùng FOR UPDATE SKIP LOCKED, batch tối đa 10, mỗi publish confirm có timeout 5 giây; chỉ đánh dấu sent khi broker confirm và không return. Retry lỗi giữ row pending. Crash sau confirm trước mark-sent có thể tạo delivery trùng; inbox là cơ chế dedup, không hứa exactly-once. MVP giữ lock transaction qua một lần publish có timeout; chưa có claim/lease relay cho tải lớn.

Cancel đến trước requested lưu nguyên envelope; requested tới xử lý pending theo received_at, tạo version 1 rồi 2 nếu hủy hợp lệ. Job mỗi phút từ chối command mồ côi sau 24 giờ với BOOKING_NOT_RECEIVED, giữ commandId/correlationId; không âm thầm bỏ command.

## Test

~~~powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run test:integration
npm.cmd audit
~~~

test:integration cần Docker. Test tự tạo PostgreSQL 17 và RabbitMQ riêng với port ngẫu nhiên, login DB không phải superuser, key JWT tạm. Không dùng DATABASE_URL Supabase thật để ghi dữ liệu thử; cuối test dọn container/fixture do test tạo.

Đã qua ngày 15/11/2026:
- 11 test cấu hình.
- 15 nhóm tích hợp: OpenAPI response/request, JWT/role, CRUD cả 17 operations, migration/seed lặp, duplicate event, concurrent confirm, stale version, time guards, cancellation, pending expiry, mandatory return, retry/DLQ, broker pause vượt timeout confirm, restart RabbitMQ/reconnect consumer và queue backlog khi consumer khác không chạy.
- Typecheck, build host và Docker image.
- npm audit: 0 lỗ hổng tại thời điểm kiểm tra.
- Supabase thật: migration bổ sung + kết nối TLS.
- Smoke read-only trực tiếp 3003 và qua gateway 8080: 4 GET public + 5 GET protected + 4 ca auth âm tính trên mỗi cổng. Token kiểm thử được ký offline bằng key Auth cung cấp; không thay thế test login Auth.

Chưa chạy E2E với tiến trình Booking, Tracking, Notification và frontend của các bạn khác. Những service đó chưa được triển khai trong phạm vi này. Test outage chứng minh queue/outbox độc lập, không tuyên bố các consumer khác đã xử lý projection/email.
