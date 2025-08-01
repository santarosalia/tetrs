// 기본 메시지 인터페이스
export interface BaseMessage {
  type: string;
  playerId: string;
  timestamp?: number;
}

// 게임 참여 메시지
export interface JoinGameMessage extends BaseMessage {
  type: 'join_game';
  clientVersion: string;
  preferredSeed?: number | null;
}

// 게임 준비 완료 메시지
export interface MatchReadyMessage extends BaseMessage {
  type: 'match_ready';
  clientVersion: string;
  preferredSeed?: number | null;
}

// 입력 이벤트 메시지
export interface InputEventMessage extends BaseMessage {
  type: 'input_event';
  seq: number;
  actions: string[];
  currentPieceId?: string;
  expectedDropTick?: number;
}

// Ping 메시지
export interface PingMessage extends BaseMessage {
  type: 'ping';
  clientSendTime: number;
}

// Pong 응답 메시지
export interface PongMessage {
  type: 'pong';
  clientSendTime: number;
  serverReceiveTime: number;
  serverSendTime: number;
}

// 스냅샷 요청 메시지
export interface SnapshotRequestMessage extends BaseMessage {
  type: 'snapshot_request';
  reason: 'desync_detected' | 'periodic_sync' | 'game_start';
  localSeq: number;
}

// 상태 스냅샷 메시지
export interface StateSnapshotMessage {
  type: 'state_snapshot';
  playerId: string;
  board: string; // 압축된 비트마스크 또는 diff
  currentPiece: string;
  nextQueue: string[];
  score: number;
  authoritativeSeq: number;
  gameState: 'playing' | 'paused' | 'game_over';
}

// ACK 확인 메시지
export interface AckMessage extends BaseMessage {
  type: 'ack';
  ackType: 'attack_received' | 'piece_placed' | 'line_cleared' | 'game_over';
  referenceId: string;
}

// Keepalive 메시지
export interface KeepaliveMessage extends BaseMessage {
  type: 'keepalive';
}

// Desync 리포트 메시지
export interface DesyncReportMessage extends BaseMessage {
  type: 'desync_report';
  localState: {
    board: string;
    currentPiece: string;
    score: number;
    seq: number;
  };
  serverStateExpectedSeq: number;
  difference: string;
}

// 게임 상태 업데이트 메시지
export interface GameStateUpdateMessage {
  type: 'game_state_update';
  gameId: string;
  players: {
    id: string;
    name: string;
    score: number;
    linesCleared: number;
    level: number;
    isAlive: boolean;
  }[];
  gameState: 'waiting' | 'playing' | 'finished';
  timestamp: number;
}

// 공격 이벤트 메시지
export interface AttackEventMessage extends BaseMessage {
  type: 'attack_event';
  attackType: 'line_clear' | 'tetris' | 'tspin' | 'back_to_back';
  linesCleared: number;
  attackLines: number;
  timestamp: number;
}

// 모든 메시지 타입의 유니온
export type NetworkMessage =
  | JoinGameMessage
  | MatchReadyMessage
  | InputEventMessage
  | PingMessage
  | PongMessage
  | SnapshotRequestMessage
  | StateSnapshotMessage
  | AckMessage
  | KeepaliveMessage
  | DesyncReportMessage
  | GameStateUpdateMessage
  | AttackEventMessage;
