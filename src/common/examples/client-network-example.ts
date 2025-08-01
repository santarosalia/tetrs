import { io, Socket } from 'socket.io-client';
import {
  JoinGameMessage,
  MatchReadyMessage,
  InputEventMessage,
  PingMessage,
  SnapshotRequestMessage,
  AckMessage,
  KeepaliveMessage,
  DesyncReportMessage,
} from '../interfaces/network-message.interface';

export class TetrisNetworkClient {
  private socket: Socket;
  private playerId: string;
  private clientVersion: string;
  private sequenceNumber = 0;
  private lastPingTime = 0;
  private latency = 0;
  private clockOffset = 0;
  private keepaliveInterval: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private gameState: any = null;

  constructor(
    serverUrl: string,
    playerId: string,
    clientVersion: string = '1.0.0',
  ) {
    this.socket = io(serverUrl);
    this.playerId = playerId;
    this.clientVersion = clientVersion;
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // 연결 이벤트
    this.socket.on('connect', () => {
      console.log('Connected to server');
      this.startPeriodicTasks();
    });

    this.socket.on('disconnect', () => {
      console.log('Disconnected from server');
      this.stopPeriodicTasks();
    });

    // 게임 관련 이벤트
    this.socket.on('join_game_response', (response) => {
      console.log('Join game response:', response);
      this.handleJoinGameResponse(response);
    });

    this.socket.on('player_ready', (data) => {
      console.log('Player ready:', data);
    });

    this.socket.on('input_event_received', (data) => {
      console.log('Input event received:', data);
    });

    this.socket.on('pong', (pongMessage) => {
      this.handlePong(pongMessage);
    });

    this.socket.on('state_snapshot', (snapshot) => {
      console.log('State snapshot received:', snapshot);
      this.handleStateSnapshot(snapshot);
    });

    this.socket.on('game_state_update', (update) => {
      console.log('Game state update:', update);
      this.handleGameStateUpdate(update);
    });

    this.socket.on('attack_event', (attack) => {
      console.log('Attack event:', attack);
      this.handleAttackEvent(attack);
    });
  }

  // 게임 참여
  async joinGame(preferredSeed?: number): Promise<void> {
    const message: JoinGameMessage = {
      type: 'join_game',
      playerId: this.playerId,
      clientVersion: this.clientVersion,
      preferredSeed,
      timestamp: this.getAdjustedTime(),
    };

    this.socket.emit('join_game', message);
  }

  // 매치 준비 완료
  async matchReady(preferredSeed?: number): Promise<void> {
    const message: MatchReadyMessage = {
      type: 'match_ready',
      playerId: this.playerId,
      clientVersion: this.clientVersion,
      preferredSeed,
      timestamp: this.getAdjustedTime(),
    };

    this.socket.emit('match_ready', message);
  }

  // 입력 이벤트 전송
  sendInputEvent(
    actions: string[],
    currentPieceId?: string,
    expectedDropTick?: number,
  ): void {
    const message: InputEventMessage = {
      type: 'input_event',
      playerId: this.playerId,
      seq: ++this.sequenceNumber,
      actions,
      currentPieceId,
      expectedDropTick,
      timestamp: this.getAdjustedTime(),
    };

    this.socket.emit('input_event', message);
  }

  // Ping 전송
  sendPing(): void {
    this.lastPingTime = Date.now();
    const message: PingMessage = {
      type: 'ping',
      playerId: this.playerId,
      clientSendTime: this.lastPingTime,
      timestamp: this.getAdjustedTime(),
    };

    this.socket.emit('ping', message);
  }

  // 스냅샷 요청
  requestSnapshot(
    reason: 'desync_detected' | 'periodic_sync' | 'game_start',
  ): void {
    const message: SnapshotRequestMessage = {
      type: 'snapshot_request',
      playerId: this.playerId,
      reason,
      localSeq: this.sequenceNumber,
      timestamp: this.getAdjustedTime(),
    };

    this.socket.emit('snapshot_request', message);
  }

  // ACK 전송
  sendAck(
    ackType: 'attack_received' | 'piece_placed' | 'line_cleared' | 'game_over',
    referenceId: string,
  ): void {
    const message: AckMessage = {
      type: 'ack',
      playerId: this.playerId,
      ackType,
      referenceId,
      timestamp: this.getAdjustedTime(),
    };

    this.socket.emit('ack', message);
  }

  // Keepalive 전송
  sendKeepalive(): void {
    const message: KeepaliveMessage = {
      type: 'keepalive',
      playerId: this.playerId,
      timestamp: this.getAdjustedTime(),
    };

    this.socket.emit('keepalive', message);
  }

  // Desync 리포트 전송
  sendDesyncReport(
    localState: {
      board: string;
      currentPiece: string;
      score: number;
      seq: number;
    },
    serverStateExpectedSeq: number,
    difference: string,
  ): void {
    const message: DesyncReportMessage = {
      type: 'desync_report',
      playerId: this.playerId,
      localState,
      serverStateExpectedSeq,
      difference,
      timestamp: this.getAdjustedTime(),
    };

    this.socket.emit('desync_report', message);
  }

  // 이벤트 핸들러들
  private handleJoinGameResponse(response: any): void {
    console.log('Game joined successfully:', response);
    // 게임 설정 저장
    this.gameState = {
      sharedSeed: response.sharedSeed,
      garbageSyncSeed: response.garbageSyncSeed,
      gameSettings: response.gameSettings,
    };
  }

  private handlePong(pongMessage: any): void {
    const { clientSendTime, serverReceiveTime, serverSendTime } = pongMessage;
    const clientReceiveTime = Date.now();

    // 왕복 지연 시간 계산
    const rtt = clientReceiveTime - clientSendTime;
    this.latency = rtt / 2;

    // 시계 오프셋 계산
    const serverTime = serverReceiveTime + this.latency;
    this.clockOffset = serverTime - clientReceiveTime;

    console.log(
      `Ping/Pong processed - RTT: ${rtt}ms, Latency: ${this.latency}ms, Clock offset: ${this.clockOffset}ms`,
    );
  }

  private handleStateSnapshot(snapshot: any): void {
    console.log('State snapshot received:', snapshot);
    // 게임 상태 동기화
    this.gameState = {
      ...this.gameState,
      board: snapshot.board,
      currentPiece: snapshot.currentPiece,
      nextQueue: snapshot.nextQueue,
      score: snapshot.score,
      authoritativeSeq: snapshot.authoritativeSeq,
    };
  }

  private handleGameStateUpdate(update: any): void {
    console.log('Game state update:', update);
    // 게임 상태 업데이트
  }

  private handleAttackEvent(attack: any): void {
    console.log('Attack event:', attack);
    // 공격 이벤트 처리
    this.sendAck('attack_received', `attack_${attack.timestamp}`);
  }

  // 유틸리티 메서드들
  private getAdjustedTime(): number {
    return Date.now() + this.clockOffset;
  }

  private startPeriodicTasks(): void {
    // 주기적 Ping (2초마다)
    this.pingInterval = setInterval(() => {
      this.sendPing();
    }, 2000);

    // 주기적 Keepalive (30초마다)
    this.keepaliveInterval = setInterval(() => {
      this.sendKeepalive();
    }, 30000);
  }

  private stopPeriodicTasks(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
  }

  // 연결 해제
  disconnect(): void {
    this.stopPeriodicTasks();
    this.socket.disconnect();
  }

  // 네트워크 통계 조회
  getNetworkStats(): {
    latency: number;
    clockOffset: number;
    sequenceNumber: number;
    lastPingTime: number;
  } {
    return {
      latency: this.latency,
      clockOffset: this.clockOffset,
      sequenceNumber: this.sequenceNumber,
      lastPingTime: this.lastPingTime,
    };
  }

  // 연결 상태 확인
  isConnected(): boolean {
    return this.socket.connected;
  }
}

// 사용 예제
export function createTetrisClient(
  serverUrl: string,
  playerId: string,
): TetrisNetworkClient {
  const client = new TetrisNetworkClient(serverUrl, playerId);

  // 게임 참여
  client.joinGame().then(() => {
    console.log('Joined game successfully');

    // 매치 준비 완료
    client.matchReady();

    // 입력 이벤트 예제
    setTimeout(() => {
      client.sendInputEvent(['move_left', 'rotate']);
    }, 1000);

    // 주기적 스냅샷 요청 (5초마다)
    setInterval(() => {
      client.requestSnapshot('periodic_sync');
    }, 5000);
  });

  return client;
}
