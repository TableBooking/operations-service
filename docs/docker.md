# Chạy Operations bằng Docker

Repository: https://github.com/TableBooking/operations-service

Compose trong repo chạy **Operations + RabbitMQ dev**. PostgreSQL nằm trên **Supabase**, gateway/Auth do thành viên khác phụ trách. Không cần tự build hoặc push image RabbitMQ; Compose pull `rabbitmq:4-management`.

Image Operations: **[ooshiowithlaundry/operations-service](https://hub.docker.com/r/ooshiowithlaundry/operations-service)**. Tag cố định `sha-fde57a7`, tag cập nhật `latest`; hỗ trợ Linux amd64 và arm64. `compose.hub.yaml` chỉ pull image, không có build context. `compose.yaml` dành cho người muốn build source. Cả hai dùng cùng project/volume dev; không khởi chạy đồng thời hai bản Operations trên cùng cổng.

## 1. Chuẩn bị

- Docker Desktop đang chạy Linux containers và có Docker Compose v2 trở lên.
- Git để clone repo.
- Supabase project, connection string Session pooler IPv4 cổng 5432, login sở hữu schema `operations`.
- Public key RS256 từ Auth, issuer `restaurant-auth`, audience `restaurant-api`.

Luồng Docker bên dưới không cần Node/npm trên máy host. Node 24 chỉ cần khi chạy dev, test hoặc FE test bên ngoài Docker.

```bash
git clone https://github.com/TableBooking/operations-service.git
cd operations-service
cp .env.example .env
mkdir -p keys certs
```

PowerShell thay hai lệnh cuối bằng:

```powershell
Copy-Item .env.example .env
New-Item -ItemType Directory -Force -Path keys,certs
```

Chỉ copy file mẫu khi chưa có `.env`; giữ nguyên credential đang dùng nếu đây là checkout đã cấu hình.

## 2. Public key và TLS CA

Nhận `auth-public.pem` từ người làm Auth, đặt tại `keys/auth-public.pem`. File cần bắt đầu bằng `-----BEGIN PUBLIC KEY-----`, RSA tối thiểu 2048 bit và trùng key Auth dùng ký token.

**Operations không cần private key.** Không đưa `auth-private.pem` vào repo, container image hoặc thư mục FE. Các file key thực tế được gitignore; repo chỉ giữ `.gitkeep` để có sẵn thư mục.

Tải CA công khai của Supabase từ Dashboard → Database Settings → SSL Configuration, hoặc endpoint Supabase downloads:

```bash
curl --fail --location https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt --output certs/supabase-ca.crt
```

PowerShell:

```powershell
Invoke-WebRequest -Uri 'https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt' -OutFile 'certs/supabase-ca.crt'
```

Public key và CA được mount read-only; không COPY vào image. Giữ xác minh TLS, không dùng `rejectUnauthorized=false` để khắc phục lỗi chứng chỉ.

## 3. Supabase và .env

Sửa `.env` theo project của bạn. Các giá trị dưới là placeholder, phải thay trước khi chạy:

```dotenv
DATABASE_URL=postgresql://operations_user.PROJECT_REF:URL_ENCODED_PASSWORD@POOLER_HOST:5432/postgres
DB_SCHEMA=operations
DB_SSL=true
DB_SSL_CA_PATH=./certs/supabase-ca.crt
JWT_PUBLIC_KEY_PATH=./keys/auth-public.pem
JWT_ISSUER=restaurant-auth
JWT_AUDIENCE=restaurant-api
PORT=3003
```

Connection URL lấy từ Supabase **Connect → Session pooler**. Dùng mật khẩu database/login PostgreSQL, không dùng mật khẩu tài khoản Supabase, URL https của project hoặc API key. Mã hóa URL ký tự đặc biệt trong password. Xóa tham số `sslmode`/`sslrootcert` khỏi URL; TLS được cấu hình bằng `DB_SSL` và `DB_SSL_CA_PATH`.

Nếu project mới hoàn toàn, owner chạy một lần trong Supabase SQL Editor:

```sql
CREATE ROLE operations_user LOGIN PASSWORD '<REPLACE_WITH_UNIQUE_PASSWORD>';
GRANT CONNECT ON DATABASE postgres TO operations_user;
CREATE SCHEMA operations AUTHORIZATION operations_user;
REVOKE ALL ON SCHEMA operations FROM PUBLIC;
```

Chỉ chạy trên project/schema Operations của bạn. Nếu role/schema đã có, dùng credential hiện tại và kiểm tra owner, không xóa schema hoặc reset password tự động. Nếu PostgreSQL báo không thể SET ROLE khi CREATE SCHEMA, owner cần cấp quyền quản lý role Operations cho tài khoản migration/admin phù hợp; không cấp superuser cho ứng dụng. Giai đoạn production nên tách login migration khỏi runtime CRUD.

Username qua pooler có dạng `operations_user.PROJECT_REF`. Không để ứng dụng chạy bằng login admin `postgres`.

## 4. Pull image, migration, seed, start — không build source

Sau khi đã có `.env`, public key và CA:

```bash
docker pull ooshiowithlaundry/operations-service:sha-fde57a7
docker compose -f compose.hub.yaml pull
docker compose -f compose.hub.yaml run --rm --no-deps operation-service node dist/database/cli.js migrate
docker compose -f compose.hub.yaml run --rm --no-deps operation-service node dist/database/cli.js seed
docker compose -f compose.hub.yaml up -d --wait
docker compose -f compose.hub.yaml ps
```

Seed demo là tùy chọn. Để dùng tag khác, đặt `OPERATIONS_IMAGE=ooshiowithlaundry/operations-service:latest` trong `.env`; bỏ biến này để dùng mặc định tag theo commit. Public key/credential vẫn phải tự cung cấp; chúng không nằm trong image.

Muốn theo dõi log hoặc chỉ kiểm tra DB:

```bash
docker compose -f compose.hub.yaml logs --tail=100 operation-service
docker compose -f compose.hub.yaml run --rm --no-deps operation-service node dist/database/cli.js check
```

## 4b. Tự build từ source (tùy chọn)

```bash
docker compose --profile app build operation-service

docker compose --profile app run --rm --no-deps operation-service node dist/database/cli.js migrate

# Seed demo là tùy chọn: 4 bàn, 2 khu vực, lunch/dinner; không tạo reservation giả.
docker compose --profile app run --rm --no-deps operation-service node dist/database/cli.js seed

docker compose --profile app up -d --wait
docker compose --profile app ps
```

Các lệnh trên dùng được cả Bash và PowerShell. Migration chạy riêng trước startup; `synchronize=false`, `migrationsRun=false`. Chạy lại migration không tạo trùng phiên bản; seed dùng `ON CONFLICT DO NOTHING`, giữ dữ liệu đã có.

Baseline V2 chỉ dành cho schema `operations` mới; không dùng để upgrade DB V1. Migration thứ hai chỉ bổ sung metadata cho pending cancellation và index, không drop bảng.

## 5. Kiểm tra

```bash
curl --fail http://localhost:3003/api/operations/health/live
curl --fail http://localhost:3003/api/operations/health/ready
curl --fail http://localhost:3003/api/restaurants/current

docker compose --profile app run --rm --no-deps operation-service node dist/database/cli.js check
docker compose --profile app logs --tail=100 operation-service
```

PowerShell có thể dùng `Invoke-RestMethod` thay `curl`. Ready trả database/messaging up sau khi RabbitMQ đã kết nối và migration đã có; live chỉ xác nhận tiến trình. `db:check` báo TLS socket của ứng dụng riêng với TLS backend của pooler.

RabbitMQ management: http://localhost:15672. Tài khoản dev lấy từ `RABBITMQ_USER` / `RABBITMQ_PASSWORD` trong `.env`, mặc định là giá trị demo ở file mẫu. Chỉ dùng trên máy dev, các cổng bind loopback.

RabbitMQ default user/password chỉ được bootstrap khi volume mới. Đổi `.env` không tự đổi mật khẩu trong volume cũ; không xóa volume có message để xử lý lỗi đăng nhập.

## 6. Gateway và broker chung của nhóm

Gateway giữ nguyên prefix `/api`. Người phụ trách gateway cấu hình:

| Vị trí gateway | OPERATIONS_SERVICE_URL |
|---|---|
| Chạy trực tiếp trên cùng Windows host | `http://localhost:3003` |
| Container Docker Desktop, Operations publish cổng host | `http://host.docker.internal:3003` |
| Cùng Docker network với Operations | `http://operation-service:3003` |

Trên Linux nên dùng cùng Docker network và DNS service. Không dùng localhost trong container gateway để gọi một container khác.

Compose này là môi trường dev cá nhân, tự tạo broker. Khi tích hợp cả nhóm, deploy **image Operations riêng**, đưa `DATABASE_URL`, `RABBITMQ_URL` của broker chung, public key/CA qua cấu hình deployment. Không triển khai một broker riêng cho từng service rồi kỳ vọng event tự đi qua nhau. Compose dev hiện cố định URL RabbitMQ nội bộ; cấu hình deployment chung do người phụ trách hạ tầng quản lý.

Exchange, queue, DLX arguments phải thống nhất với README và contracts. Không xóa queue để giải quyết `PRECONDITION_FAILED` vì có thể mất message.

## 7. Cập nhật và dừng

Với image Docker Hub, chọn tag cần dùng trong `.env`, sau đó:

```bash
docker compose -f compose.hub.yaml pull
docker compose -f compose.hub.yaml run --rm --no-deps operation-service node dist/database/cli.js migrate
docker compose -f compose.hub.yaml up -d --wait
docker compose -f compose.hub.yaml stop operation-service
```

Với bản tự build source:

```bash
git pull --ff-only
docker compose --profile app build operation-service
docker compose --profile app run --rm --no-deps operation-service node dist/database/cli.js migrate
docker compose --profile app up -d --wait

# Chỉ dừng Operations
docker compose --profile app stop operation-service

# Dừng môi trường dev, giữ named volume RabbitMQ
docker compose --profile app down
```

Không dùng `down -v` trên môi trường cần giữ dữ liệu. Khi rollback code, kiểm tra tương thích migration; không có reset/drop DB tự động.

## 8. Test backend (tùy chọn, cần Node 24 trên host)

```bash
npm ci
npm run typecheck
npm test
npm run test:integration
```

Test tích hợp tạo PostgreSQL/RabbitMQ tạm riêng và dọn sau test, không dùng Supabase thật để ghi dữ liệu thử.
