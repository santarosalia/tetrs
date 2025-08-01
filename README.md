# Tetris 99 Backend

테트리스 99와 같은 멀티플레이어 테트리스 게임을 위한 NestJS 백엔드입니다.

## 기능

- 실시간 멀티플레이어 게임 (최대 99명)
- WebSocket을 통한 실시간 통신
- 하이브리드 데이터 저장 (Redis + PostgreSQL)
- Redis: 실시간 게임 상태 및 세션 관리
- PostgreSQL: 영속성 데이터 및 통계 저장
- Prisma ORM
- 게임 상태 관리
- 플레이어 통계 추적
- 통합된 에러 처리 시스템
- 구조화된 로깅 시스템

## 설치

```bash
# 의존성 설치
pnpm install

# Prisma 클라이언트 생성
pnpm run prisma:generate

# 데이터베이스 마이그레이션
pnpm run prisma:migrate

# 개발 서버 실행
pnpm run start:dev
```

## 데이터베이스 설정

### PostgreSQL 설정

1. PostgreSQL 데이터베이스를 설치하고 실행합니다.
2. `.env` 파일에서 데이터베이스 연결 정보를 설정합니다:

```env
DATABASE_URL="postgresql://username:password@localhost:5432/tetrs?schema=public"
```

3. 데이터베이스를 생성하고 마이그레이션을 실행합니다:

```bash
pnpm run prisma:migrate
```

### Redis 설정

1. Redis 서버를 설치하고 실행합니다.
2. `.env` 파일에서 Redis 연결 정보를 설정합니다:

```env
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
```

## API 엔드포인트

### 게임 관리

- `POST /games` - 새 게임 생성
- `GET /games` - 모든 게임 목록 조회
- `GET /games/:id` - 특정 게임 정보 조회
- `POST /games/:id/join` - 게임 참가
- `POST /games/:id/start` - 게임 시작

## WebSocket 이벤트

### 클라이언트 → 서버

- `joinGame` - 게임 참가
- `startGame` - 게임 시작
- `playerEliminated` - 플레이어 탈락
- `updateStats` - 플레이어 통계 업데이트
- `leaveGame` - 게임 나가기
- `getGameMapState` - 게임 맵 상태 조회
- `updatePlayerMap` - 플레이어 맵 업데이트
- `initializePlayerMap` - 플레이어 맵 초기화
- `subscribeToMapUpdates` - 맵 업데이트 구독

### 서버 → 클라이언트

- `playerJoined` - 플레이어 참가 알림
- `gameStarted` - 게임 시작 알림
- `playerEliminated` - 플레이어 탈락 알림
- `statsUpdated` - 통계 업데이트 알림
- `playerMapUpdated` - 플레이어 맵 업데이트 알림
- `playerMapInitialized` - 플레이어 맵 초기화 알림
- `mapUpdateReceived` - 맵 업데이트 수신

## 게임 규칙

1. 최대 99명의 플레이어가 동시에 게임에 참가할 수 있습니다.
2. 플레이어가 라인을 클리어하면 다른 플레이어들에게 공격 라인이 전송됩니다.
3. 마지막까지 살아남은 플레이어가 승리합니다.

## 기술 스택

- NestJS
- Prisma ORM
- PostgreSQL (영속성 데이터)
- Redis (실시간 데이터)
- Socket.IO
- TypeScript
- 전역 예외 필터
- 구조화된 로깅

## 개발 도구

- `pnpm run prisma:generate` - Prisma 클라이언트 생성
- `pnpm run prisma:migrate` - 데이터베이스 마이그레이션
- `pnpm run prisma:studio` - Prisma Studio 실행 (데이터베이스 GUI)
- `pnpm run db:push` - 스키마 변경사항을 데이터베이스에 직접 푸시
- `pnpm run redis:start` - Redis 서버 시작
- `pnpm run redis:cli` - Redis CLI 실행

## 에러 처리

### HTTP API 에러 응답 형식

```json
{
  "success": false,
  "error": {
    "code": "GAME_NOT_FOUND",
    "message": "Game with ID abc123 not found",
    "details": null
  },
  "timestamp": "2024-01-01T00:00:00.000Z",
  "path": "/games/abc123"
}
```

### WebSocket 에러 응답 형식

```json
{
  "success": false,
  "error": {
    "code": "JOIN_GAME_ERROR",
    "message": "Game is full"
  }
}
```

### 주요 에러 코드

- `GAME_NOT_FOUND` - 게임을 찾을 수 없음
- `GAME_NOT_ACCEPTING_PLAYERS` - 게임이 플레이어를 받지 않음
- `GAME_FULL` - 게임이 가득 참
- `GAME_CANNOT_START` - 게임을 시작할 수 없음
- `PLAYER_NOT_FOUND` - 플레이어를 찾을 수 없음
- `VALIDATION_ERROR` - 입력 데이터 검증 실패
- `INTERNAL_SERVER_ERROR` - 서버 내부 오류

## 로깅 시스템

### 로그 레벨

- `log` - 일반 정보 로그
- `error` - 에러 로그
- `warn` - 경고 로그
- `debug` - 디버그 로그
- `verbose` - 상세 로그

### 로그 형식

```
[Timestamp] [LogLevel] [Context] Message | key1=value1 key2=value2
```

### 주요 로그 이벤트

- `GAME_CREATED` - 게임 생성
- `GAME_JOINED` - 플레이어 게임 참가
- `GAME_STARTED` - 게임 시작
- `GAME_FINISHED` - 게임 종료
- `PLAYER_ELIMINATED` - 플레이어 탈락
- `PLAYER_LEFT` - 플레이어 퇴장
- `STATS_UPDATED` - 통계 업데이트
- `WS_CONNECTED` - WebSocket 연결
- `WS_DISCONNECTED` - WebSocket 연결 해제
- `REDIS_OPERATION` - Redis 작업
- `DB_OPERATION` - 데이터베이스 작업
- `TETRIS_MAP_UPDATED` - 테트리스 맵 업데이트
- `TETRIS_MAP_INITIALIZED` - 테트리스 맵 초기화
- `TETRIS_MAP_DELETED` - 테트리스 맵 삭제
