import { Injectable } from '@nestjs/common';
import { LoggerService } from '../common/services/logger.service';
import { RedisService } from './redis.service';
import {
  NetworkMessage,
  InputEventMessage,
  PingMessage,
  PongMessage,
  SnapshotRequestMessage,
  StateSnapshotMessage,
  AckMessage,
  KeepaliveMessage,
  DesyncReportMessage,
  GameStateUpdateMessage,
  AttackEventMessage,
} from '../common/interfaces/network-message.interface';

@Injectable()
export class NetworkSyncService {
  private readonly logger = new LoggerService();
  private readonly clientStates = new Map<string, any>();
  private readonly sequenceNumbers = new Map<string, number>();

  constructor(private readonly redisService: RedisService) {}

  // 클라이언트 상태 관리
  initializeClientState(playerId: string, gameId: string) {
    const clientState = {
      playerId,
      gameId,
      lastSeq: 0,
      lastPing: Date.now(),
      latency: 0,
      clockOffset: 0,
      lastSnapshot: Date.now(),
      desyncCount: 0,
    };

    this.clientStates.set(playerId, clientState);
    this.sequenceNumbers.set(playerId, 0);

    this.logger.log(`Client state initialized for player ${playerId}`, {
      playerId,
      gameId,
    });
  }

  // 입력 이벤트 처리
  async handleInputEvent(message: InputEventMessage): Promise<boolean> {
    const { playerId, seq, actions } = message;
    const clientState = this.clientStates.get(playerId);

    if (!clientState) {
      this.logger.warn(`No client state found for player ${playerId}`);
      return false;
    }

    // 시퀀스 번호 검증
    if (seq <= clientState.lastSeq) {
      this.logger.warn(
        `Duplicate or out-of-order sequence: ${seq} <= ${clientState.lastSeq}`,
        {
          playerId,
          seq,
          lastSeq: clientState.lastSeq,
        },
      );
      return false;
    }

    // 시퀀스 번호 업데이트
    clientState.lastSeq = seq;
    this.clientStates.set(playerId, clientState);

    // Redis에 입력 이벤트 저장
    const redis = this.redisService.getRedisInstance();
    await redis.set(
      `input:${playerId}:${seq}`,
      JSON.stringify(message),
      'EX',
      300, // 5분 만료
    );

    this.logger.log(`Input event processed`, {
      playerId,
      seq,
      actions,
    });

    return true;
  }

  // Ping/Pong 처리
  async handlePing(message: PingMessage): Promise<PongMessage> {
    const { playerId, clientSendTime } = message;
    const now = Date.now();

    const pongMessage: PongMessage = {
      type: 'pong',
      clientSendTime,
      serverReceiveTime: now,
      serverSendTime: now,
    };

    // 클라이언트 상태 업데이트
    const clientState = this.clientStates.get(playerId);
    if (clientState) {
      clientState.lastPing = now;
      clientState.latency = now - clientSendTime;
      this.clientStates.set(playerId, clientState);
    }

    return pongMessage;
  }

  // 스냅샷 요청 처리
  async handleSnapshotRequest(
    message: SnapshotRequestMessage,
  ): Promise<StateSnapshotMessage | null> {
    const { playerId, reason, localSeq } = message;
    const clientState = this.clientStates.get(playerId);

    if (!clientState) {
      this.logger.warn(
        `No client state found for snapshot request from ${playerId}`,
      );
      return null;
    }

    // 게임 상태를 Redis에서 가져오기
    const redis = this.redisService.getRedisInstance();
    const gameState = await redis.get(`game:${clientState.gameId}`);
    if (!gameState) {
      this.logger.warn(`No game state found for ${clientState.gameId}`);
      return null;
    }

    const parsedGameState = JSON.parse(gameState);

    const snapshotMessage: StateSnapshotMessage = {
      type: 'state_snapshot',
      playerId,
      board: parsedGameState.board || '',
      currentPiece: parsedGameState.currentPiece || 'I',
      nextQueue: parsedGameState.nextQueue || ['I', 'O', 'T'],
      score: parsedGameState.score || 0,
      authoritativeSeq: clientState.lastSeq + 1,
      gameState: parsedGameState.gameState || 'playing',
    };

    // 스냅샷 요청 로그
    this.logger.log(`Snapshot requested`, {
      playerId,
      reason,
      localSeq,
      serverSeq: clientState.lastSeq,
    });

    return snapshotMessage;
  }

  // ACK 처리
  async handleAck(message: AckMessage): Promise<void> {
    const { playerId, ackType, referenceId } = message;

    this.logger.log(`ACK received`, {
      playerId,
      ackType,
      referenceId,
    });

    // Redis에서 해당 이벤트 제거 (선택적)
    const redis = this.redisService.getRedisInstance();
    await redis.del(`event:${referenceId}`);
  }

  // Keepalive 처리
  async handleKeepalive(message: KeepaliveMessage): Promise<void> {
    const { playerId } = message;
    const clientState = this.clientStates.get(playerId);

    if (clientState) {
      clientState.lastPing = Date.now();
      this.clientStates.set(playerId, clientState);
    }

    this.logger.debug(`Keepalive received from ${playerId}`);
  }

  // Desync 리포트 처리
  async handleDesyncReport(message: DesyncReportMessage): Promise<void> {
    const { playerId, localState, serverStateExpectedSeq, difference } =
      message;
    const clientState = this.clientStates.get(playerId);

    if (clientState) {
      clientState.desyncCount++;
      this.clientStates.set(playerId, clientState);
    }

    // Desync 통계를 Redis에 저장
    const redis = this.redisService.getRedisInstance();
    await redis.hset(
      'desync_stats',
      playerId,
      JSON.stringify({
        count: clientState?.desyncCount || 1,
        lastReport: Date.now(),
        difference,
        localSeq: localState.seq,
        expectedSeq: serverStateExpectedSeq,
      }),
    );

    this.logger.warn(`Desync report received`, {
      playerId,
      difference,
      localSeq: localState.seq,
      expectedSeq: serverStateExpectedSeq,
      desyncCount: clientState?.desyncCount || 1,
    });
  }

  // 게임 상태 업데이트 브로드캐스트
  async broadcastGameStateUpdate(
    gameId: string,
    gameState: any,
  ): Promise<void> {
    const message: GameStateUpdateMessage = {
      type: 'game_state_update',
      gameId,
      players: gameState.players || [],
      gameState: gameState.status || 'waiting',
      timestamp: Date.now(),
    };

    // Redis Pub/Sub을 통해 브로드캐스트
    await this.redisService.publish(
      `game:${gameId}:state`,
      JSON.stringify(message),
    );
  }

  // 공격 이벤트 브로드캐스트
  async broadcastAttackEvent(playerId: string, attackData: any): Promise<void> {
    const message: AttackEventMessage = {
      type: 'attack_event',
      playerId,
      attackType: attackData.type,
      linesCleared: attackData.linesCleared,
      attackLines: attackData.attackLines,
      timestamp: Date.now(),
    };

    const clientState = this.clientStates.get(playerId);
    if (clientState) {
      await this.redisService.publish(
        `game:${clientState.gameId}:attack`,
        JSON.stringify(message),
      );
    }
  }

  // 클라이언트 상태 정리
  cleanupClientState(playerId: string): void {
    this.clientStates.delete(playerId);
    this.sequenceNumbers.delete(playerId);

    this.logger.log(`Client state cleaned up for player ${playerId}`);
  }

  // 클라이언트 상태 조회
  getClientState(playerId: string): any {
    return this.clientStates.get(playerId);
  }

  // 모든 클라이언트 상태 조회
  getAllClientStates(): Map<string, any> {
    return this.clientStates;
  }

  // 실시간 게임 상태 동기화 최적화
  async optimizeGameStateSync(playerId: string, gameState: any): Promise<any> {
    const clientState = this.clientStates.get(playerId);
    if (!clientState) {
      return gameState;
    }

    // 마지막 스냅샷과 비교하여 변경된 부분만 전송
    const lastSnapshot = clientState.lastSnapshot;
    const now = Date.now();

    // 100ms마다 전체 스냅샷, 그 외에는 델타 업데이트만
    if (now - lastSnapshot > 100) {
      clientState.lastSnapshot = now;
      return {
        type: 'full_snapshot',
        gameState,
        timestamp: now,
      };
    } else {
      // 델타 업데이트 (변경된 부분만)
      return {
        type: 'delta_update',
        changes: this.calculateDeltaChanges(
          clientState.lastGameState,
          gameState,
        ),
        timestamp: now,
      };
    }
  }

  // 델타 변경사항 계산
  private calculateDeltaChanges(lastState: any, currentState: any): any {
    if (!lastState) {
      return currentState;
    }

    const changes: any = {};

    // 보드 변경사항만 계산 (가장 무거운 데이터)
    if (currentState.board && lastState.board) {
      const boardChanges = this.calculateBoardDelta(
        lastState.board,
        currentState.board,
      );
      if (boardChanges.length > 0) {
        changes.board = boardChanges;
      }
    }

    // 다른 필드들의 변경사항
    const fields = ['score', 'level', 'linesCleared', 'gameOver', 'paused'];
    fields.forEach((field) => {
      if (currentState[field] !== lastState[field]) {
        changes[field] = currentState[field];
      }
    });

    // 조각 변경사항
    if (currentState.currentPiece && lastState.currentPiece) {
      if (
        JSON.stringify(currentState.currentPiece) !==
        JSON.stringify(lastState.currentPiece)
      ) {
        changes.currentPiece = currentState.currentPiece;
      }
    }

    return changes;
  }

  // 보드 델타 계산 (최적화)
  private calculateBoardDelta(
    lastBoard: number[][],
    currentBoard: number[][],
  ): any[] {
    const changes: any[] = [];

    for (let y = 0; y < currentBoard.length; y++) {
      for (let x = 0; x < currentBoard[y].length; x++) {
        if (lastBoard[y] && lastBoard[y][x] !== currentBoard[y][x]) {
          changes.push({
            x,
            y,
            value: currentBoard[y][x],
          });
        }
      }
    }

    return changes;
  }

  // 네트워크 지연 보정
  calculateNetworkCompensation(playerId: string): number {
    const clientState = this.clientStates.get(playerId);
    if (!clientState) {
      return 0;
    }

    // 평균 지연시간 기반 보정값 계산
    return Math.min(clientState.latency * 0.5, 100); // 최대 100ms 보정
  }

  // 클라이언트 상태 예측
  predictClientState(playerId: string, currentState: any): any {
    const clientState = this.clientStates.get(playerId);
    if (!clientState) {
      return currentState;
    }

    const compensation = this.calculateNetworkCompensation(playerId);

    // 네트워크 지연을 고려한 상태 예측
    return {
      ...currentState,
      predictedLatency: compensation,
      serverTime: Date.now(),
    };
  }
}
