# Tetris Multiplayer Game

테트리스 멀티플레이어 게임 서버입니다. WebSocket을 통한 실시간 통신과 Redis를 이용한 상태 관리를 지원합니다.

## 네트워크 통신 프로토콜

### 1. 전체 흐름 요약

#### 초기 핸드쉐이크 / 매치 참여

- 클라이언트가 서버에 연결 후 `join_game` 메시지 전송
- 서버가 공유 시드, 게임 설정 등 응답
- 클라이언트가 `match_ready` 메시지로 준비 완료 알림

#### 입력 이벤트 전송

- 플레이어 조작 시 `input_event` 메시지 전송
- 시퀀스 번호와 타임스탬프 포함
- 서버가 authoritative하게 시뮬레이션

#### 지연 측정 및 동기화

- 주기적 `ping`/`pong` 메시지로 지연 시간 측정
- 클라이언트-서버 시간 보정
- 필요시 `snapshot_request`로 상태 동기화

#### 연결 유지

- 주기적 `keepalive` 메시지
- 연결 상태 모니터링

### 2. 메시지 타입

#### join_game

```json
{
  "type": "join_game",
  "playerId": "user123",
  "clientVersion": "1.0.2",
  "preferredSeed": null,
  "timestamp": 1712000000000
}
```

#### input_event

```json
{
  "type": "input_event",
  "playerId": "user123",
  "seq": 4321,
  "timestamp": 1712000000000,
  "actions": ["move_left", "rotate"],
  "currentPieceId": "T",
  "expectedDropTick": 125
}
```

#### ping

```json
{
  "type": "ping",
  "playerId": "user123",
  "clientSendTime": 1712000005000,
  "timestamp": 1712000005000
}
```

#### pong (서버 응답)

```json
{
  "type": "pong",
  "clientSendTime": 1712000005000,
  "serverReceiveTime": 1712000005003,
  "serverSendTime": 1712000005004
}
```

#### snapshot_request

```json
{
  "type": "snapshot_request",
  "playerId": "user123",
  "reason": "desync_detected",
  "localSeq": 4500,
  "timestamp": 1712000000000
}
```

#### state_snapshot (서버 응답)

```json
{
  "type": "state_snapshot",
  "playerId": "user123",
  "board": "<compressed bitmask or diff>",
  "currentPiece": "L",
  "nextQueue": ["O", "I", "S"],
  "score": 12000,
  "authoritativeSeq": 4501,
  "gameState": "playing"
}
```

#### ack

```json
{
  "type": "ack",
  "playerId": "user123",
  "ackType": "attack_received",
  "referenceId": "attack_789",
  "timestamp": 1712000000000
}
```

#### keepalive

```json
{
  "type": "keepalive",
  "playerId": "user123",
  "timestamp": 1712000000000
}
```

#### desync_report

```json
{
  "type": "desync_report",
  "playerId": "user123",
  "localState": {
    "board": "<board state>",
    "currentPiece": "T",
    "score": 10000,
    "seq": 4500
  },
  "serverStateExpectedSeq": 4520,
  "difference": "piece_position_mismatch",
  "timestamp": 1712000000000
}
```

### 3. 전송 전략 및 최적화

#### 배치 처리

- 여러 작은 입력을 한 틱 안에서 묶어서 전송
- 패킷 오버헤드 감소

#### 순서 번호 관리

- 각 메시지에 고유한 시퀀스 번호 포함
- 중복/순서 뒤섞임 방지
- 서버가 누락된 seq 감지 가능

#### 압축

- 자주 보내지 않는 필드는 delta/변경 있을 때만
- 메시지 크기 최적화

#### 역방향 보정

- 서버 응답을 받고 로컬 예측이 틀렸으면 reconciliation 수행
- 부드러운 상태 조정

### 4. 클라이언트 예측 + 보정 패턴

1. 사용자 입력 즉시 로컬에 반영 (예: 회전 애니메이션)
2. 동일한 입력을 서버로 전송
3. 서버가 authoritative 결과를 보내면:
   - seq 비교
   - 로컬 상태와 다르면 부드럽게 맞춤
   - 이상하게 반복적인 불일치면 desync 로그/스냅샷 요청

## 설치 및 실행

### 필수 요구사항

- Node.js 18+
- Redis
- PostgreSQL (Prisma 사용)

### 설치

```bash
npm install
# 또는
pnpm install
```

### 환경 변수 설정

```bash
# .env 파일 생성
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

DATABASE_URL="postgresql://username:password@localhost:5432/tetris"
```

### 데이터베이스 마이그레이션

```bash
npx prisma migrate dev
```

### 개발 서버 실행

```bash
npm run start:dev
```

### 프로덕션 빌드

```bash
npm run build
npm run start:prod
```

## API 문서

### WebSocket 이벤트

#### 클라이언트 → 서버

- `join_game`: 게임 참여
- `match_ready`: 매치 준비 완료
- `input_event`: 입력 이벤트
- `ping`: 지연 측정
- `snapshot_request`: 상태 스냅샷 요청
- `ack`: 확인 응답
- `keepalive`: 연결 유지
- `desync_report`: 동기화 불일치 리포트

#### 서버 → 클라이언트

- `join_game_response`: 게임 참여 응답
- `player_ready`: 플레이어 준비 완료 알림
- `input_event_received`: 입력 이벤트 수신 확인
- `pong`: Ping 응답
- `state_snapshot`: 상태 스냅샷
- `game_state_update`: 게임 상태 업데이트
- `attack_event`: 공격 이벤트

## 프로젝트 구조

```
src/
├── controllers/          # HTTP 컨트롤러
├── gateways/            # WebSocket 게이트웨이
├── services/            # 비즈니스 로직 서비스
├── modules/             # NestJS 모듈
├── dto/                 # 데이터 전송 객체
├── common/
│   ├── interfaces/      # 타입 정의
│   ├── services/        # 공통 서비스
│   ├── exceptions/      # 예외 처리
│   └── examples/        # 예제 코드
└── test/               # 테스트 파일
```

## 주요 기능

- 실시간 멀티플레이어 테트리스 게임
- WebSocket을 통한 실시간 통신
- Redis를 이용한 상태 관리
- 클라이언트-서버 동기화
- 지연 시간 측정 및 보정
- 연결 상태 모니터링
- 오류 처리 및 로깅

## 라이센스

MIT License
