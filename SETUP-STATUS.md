# Operations V2 — bàn giao ngày 15/11/2026

Source: D:\VSC_PWD\TableBooking\operation-service. Đã triển khai local Docker với Supabase thật; không sửa source gateway hoặc service khác.

## Kết quả

- Đủ 17 OpenAPI operations: 4 public + 13 protected; action route hỗ trợ confirm/reject/check-in/seat/complete/no-show/cancel.
- Restaurant/areas/tables/slots/availability, reservation list/detail/pagination, manager CRUD và stats.
- State/version/allocation dùng TypeORM transaction, khóa booking/catalog và partial unique index chống trùng bàn.
- Verify RS256/issuer/audience/expiry/UUID subject/role tại Operations; validate input và trả lỗi theo contract; log correlationId không log JWT/password/email.
- Consume requested/cancel, inbox dedup, outbox publisher-confirm + mandatory return, retry tối đa 3 lần, DLQ và tự reconnect.
- Pending cancellation giữ envelope/correlation/reason; xử lý sau requested hoặc timeout 24 giờ phát cancellation-rejected.
- Queue riêng cho Booking, Tracking, Notification được provision trước khi publish. Không gọi backend service khác trong hot path.

## Kiểm tra đã chạy

| Kiểm tra | Kết quả |
|---|---|
| npm test — cấu hình | 11/11 pass |
| npm run test:integration | 15/15 nhóm pass, khoảng 48 giây ở lượt cuối |
| npm run typecheck | Pass |
| npm run build và build image Docker | Pass |
| npm audit --omit=dev và audit trong Docker build | 0 lỗ hổng tại thời điểm kiểm tra |
| Migration local DB mới rồi chạy lại + seed hai lần | Pass |
| Migration bổ sung trên Supabase thật | 1 migration áp dụng thành công; tổng 2 migration |
| DB thật | clientTls=true, certificateVerified=true; schema operations |
| HTTP trực tiếp 3003 | 4 GET public, 5 GET protected MANAGER, 4 ca auth âm tính pass |
| HTTP qua gateway 8080 | Cùng 13 kiểm tra pass |
| Operations readiness | status ok, database up, messaging up |

15 nhóm tích hợp kiểm tra: contract public APIs/availability; JWT/role; manager CRUD; duplicate event và booking; concurrent confirm/stale version/capacity; check-in/seat/complete; no-show; cancel đến trước requested; ownership/deadline/release; staff cancel/stats; poison DLQ/mandatory return; retry hữu hạn; pending expiry; broker pause vượt timeout confirm/outbox backlog; RabbitMQ stop_app/start_app và consumer reconnect.

PostgreSQL/RabbitMQ kiểm thử là container tạm riêng, port ngẫu nhiên, login DB không phải superuser và key tạm. Container/fixture được dọn sau test. Không ghi reservation hay sự kiện thử lên Supabase thật. Sau deploy chỉ smoke GET/auth; token kiểm thử ký offline bằng key Auth đã cung cấp, không thay thế login E2E.

Test đầu phát hiện response UPDATE RETURNING của TypeORM thiếu field vì driver trả [rows, affected]; đã sửa serializer và suite cuối pass. Không che bỏ test lỗi.

## Đang chạy

- Operations: tablebooking-operations-dev-operation-service-1, cổng 3003, healthy.
- Gateway: tablebooking-gateway-dev, image tientran05/dinnerdeserve:setup, cổng 8080; được bật lại từ container hiện có, giữ nguyên cấu hình.
- RabbitMQ: tablebooking-operations-dev-rabbitmq-1, AMQP 5672, management 15672, healthy.
- Operations image cuối: tablebooking-operation-service:local; build manifest sha256:e9a3694b90ce04fac6d9e448c61bf483d58fc39d1e97219b7e0ab6f2a4e5b113.

Health:
- http://localhost:3003/api/operations/health/ready
- http://localhost:8080/api/health

## Dữ liệu và phạm vi

Migration bổ sung chỉ thêm pending_cancellations.event_payload JSONB và index received_at. Không xóa dữ liệu, không đổi schema service khác. DATABASE_URL vẫn dùng operations_user và public key/CA được mount read-only. Gói source không có .env, private key, node_modules, dist.

Cần ghép tiếp với tiến trình Booking, Tracking, Notification và frontend của các bạn khác để chạy full E2E tạo booking → projections/history/email. Lượt này chứng minh contract/queue/outbox và gateway của riêng Operations; không khẳng định các consumer khác đã xử lý dữ liệu.

Giới hạn MVP đã ghi trong README: một nhà hàng, lunch/dinner, một bàn/booking, chưa đổi bàn; relay giữ transaction lock qua publish có timeout, chưa có claim/lease cho tải lớn. Khi dùng broker chung phải thống nhất queue arguments/DLX; không xóa queue để xử lý mismatch.

Chạy lại: npm.cmd run typecheck; npm.cmd test; npm.cmd run test:integration. Deploy: npm.cmd run db:migrate, rồi npm.cmd run docker:up. Dev host: docker:stop trước start:dev để tránh trùng cổng.
