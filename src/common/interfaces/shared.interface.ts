// 공통 타입 정의
export type TetrominoType = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';

export interface Position {
  x: number;
  y: number;
}

export interface Tetromino {
  type: TetrominoType;
  position: Position;
  rotation: number;
  shape: number[][];
}

// 게임 상태 관련 타입
export type GameStatus = 'WAITING' | 'PLAYING' | 'FINISHED' | 'PAUSED';

export interface GameConfig {
  boardWidth: number;
  boardHeight: number;
  blockSize: number;
  dropInterval: number;
}

// 에러 응답 타입
export interface ErrorResponse {
  code: string;
  message: string;
  details?: any;
}

// 성공 응답 타입
export interface SuccessResponse<T = any> {
  success: true;
  data: T;
  message?: string;
}

// 네트워크 메시지 타입
export interface NetworkMessage<T = any> {
  type: string;
  payload: T;
  timestamp: number;
  playerId?: string;
}

// 로그 컨텍스트 타입
export interface LogContext {
  playerId?: string;
  gameId?: string;
  action?: string;
  [key: string]: any;
}
