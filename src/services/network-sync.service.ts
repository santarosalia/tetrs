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
}
