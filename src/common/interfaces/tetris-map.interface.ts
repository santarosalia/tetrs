export interface TetrisBlock {
  x: number;
  y: number;
  type: 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';
  rotation: number;
  // 추가 정보
  falling?: boolean; // 현재 떨어지고 있는지
  ghostY?: number; // 고스트 블럭 Y 위치
  lockDelay?: number; // 락 딜레이 (밀착 대기 시간)
  dropTime?: number; // 다음 드롭까지 남은 시간
}

export interface TetrisMap {
  playerId: string;
  playerName: string;
  width: number;
  height: number;
  grid: number[][]; // 0: 빈칸, 1-7: 블록 타입
  currentPiece?: TetrisBlock;
  nextPiece?: TetrisBlock;
  score: number;
  linesCleared: number;
  level: number;
  gameOver: boolean;
  lastUpdated: string;
  // 추가 정보
  linesSent?: number; // 보낸 라인 수
  linesReceived?: number; // 받은 라인 수
  combo?: number; // 콤보 수
  b2b?: boolean; // Back-to-Back (연속 테트리스)
}

export interface GameMapState {
  gameId: string;
  players: TetrisMap[];
  gameStatus: 'WAITING' | 'PLAYING' | 'FINISHED';
  lastUpdated: string;
}
