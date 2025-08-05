# Tetris Multiplayer Game

테트리스 멀티플레이어 게임 프로젝트입니다. 서버(tetrs)와 클라이언트(tetr)로 구성되어 있습니다.

## 🚀 주요 개선사항

### 1. 타입 안전성 강화

- 공통 타입 정의 통합 (`shared.interface.ts`, `shared.ts`)
- 서버/클라이언트 간 일관된 타입 시스템
- 엄격한 타입 체크 및 컴파일 타임 에러 방지

### 2. 코드 중복 제거

- 공통 테트리스 로직 추출 (`TetrisCoreService`, `tetrisCore.ts`)
- 서버/클라이언트 간 로직 재사용
- 유지보수성 향상

### 3. 에러 처리 개선

- 일관된 예외 처리 시스템 (`BaseGameException`)
- 구조화된 에러 응답
- 상세한 에러 로깅 및 디버깅 정보

### 4. 성능 최적화

- React 컴포넌트 메모이제이션
- 불필요한 리렌더링 방지
- 최적화된 게임 루프 (`useOptimizedTetrisGame`)

### 5. 코드 구조 개선

- 관심사 분리 (Separation of Concerns)
- 모듈화된 아키텍처
- 의존성 주입 패턴 적용

## 📁 프로젝트 구조

### 서버 (tetrs)

```
src/
├── common/
│   ├── constants/          # 상수 정의
│   ├── exceptions/         # 예외 처리
│   ├── filters/           # 전역 필터
│   ├── interfaces/        # 타입 정의
│   └── services/          # 공통 서비스
├── controllers/           # API 컨트롤러
├── gateways/             # WebSocket 게이트웨이
├── modules/              # NestJS 모듈
├── services/             # 비즈니스 로직
└── main.ts              # 애플리케이션 진입점
```

### 클라이언트 (tetr)

```
src/
├── components/           # React 컴포넌트
├── constants/           # 상수 정의
├── hooks/              # 커스텀 훅
├── store/              # Redux 스토어
├── types/              # 타입 정의
├── utils/              # 유틸리티 함수
└── main.tsx           # 애플리케이션 진입점
```

## 🛠 기술 스택

### 서버

- **NestJS** - Node.js 프레임워크
- **TypeScript** - 타입 안전성
- **Prisma** - 데이터베이스 ORM
- **Redis** - 캐싱 및 세션 관리
- **WebSocket** - 실시간 통신

### 클라이언트

- **React** - UI 라이브러리
- **TypeScript** - 타입 안전성
- **Redux Toolkit** - 상태 관리
- **Vite** - 빌드 도구
- **Tailwind CSS** - 스타일링

## 🚀 시작하기

### 서버 실행

```bash
cd tetrs
pnpm install
pnpm run start:dev
```

### 클라이언트 실행

```bash
cd tetr
pnpm install
pnpm run dev
```

## 🎮 게임 기능

- **실시간 멀티플레이어** - WebSocket 기반 실시간 게임
- **7-bag 시스템** - 공정한 테트로미노 분배
- **벽킥 시스템** - 표준 테트리스 회전 규칙
- **고스트 피스** - 떨어질 위치 미리보기
- **홀드 시스템** - 피스 보관 기능
- **하드 드롭** - 즉시 떨어뜨리기
- **점수 시스템** - 레벨별 점수 계산

## 🔧 개발 가이드

### 타입 정의 추가

1. `tetrs/src/common/interfaces/shared.interface.ts`에 서버용 타입 추가
2. `tetr/src/types/shared.ts`에 클라이언트용 타입 추가

### 새로운 게임 로직 추가

1. `tetrs/src/common/services/tetris-core.service.ts`에 공통 로직 추가
2. `tetr/src/utils/tetrisCore.ts`에 클라이언트 로직 추가

### 에러 처리 추가

1. `tetrs/src/common/exceptions/base.exception.ts`에 새로운 예외 클래스 추가
2. 적절한 HTTP 상태 코드와 에러 메시지 설정

## �� 라이센스

MIT License
