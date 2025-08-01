import { Injectable } from '@nestjs/common';
import { LoggerService } from './logger.service';
import {
  NetworkMessage,
  JoinGameMessage,
  MatchReadyMessage,
  InputEventMessage,
  PingMessage,
  SnapshotRequestMessage,
  AckMessage,
  KeepaliveMessage,
  DesyncReportMessage,
} from '../interfaces/network-message.interface';

@Injectable()
export class NetworkClientService {
  private readonly logger = new LoggerService();
  private sequenceNumber = 0;
  private lastPingTime = 0;
  private latency = 0;
  private clockOffset = 0;
  private keepaliveInterval: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;

  constructor() {}

  // 시퀀스 번호 생성
  getNextSequenceNumber(): number {
    return ++this.sequenceNumber;
  }

  // 클라이언트 시간 조정
  getAdjustedTime(): number {
    return Date.now() + this.clockOffset;
  }

  // 지연 시간 설정
  setLatency(latency: number): void {
    this.latency = latency;
  }

  // 시계 오프셋 설정
  setClockOffset(offset: number): void {
    this.clockOffset = offset;
  }

  // Ping/Pong 처리
  handlePong(pongMessage: any): void {
    const { clientSendTime, serverReceiveTime, serverSendTime } = pongMessage;
    const clientReceiveTime = Date.now();

    // 왕복 지연 시간 계산
    const rtt = clientReceiveTime - clientSendTime;
    this.latency = rtt / 2;

    // 시계 오프셋 계산
    const serverTime = serverReceiveTime + this.latency;
    this.clockOffset = serverTime - clientReceiveTime;

    this.logger.log(`Ping/Pong processed`, {
      rtt,
      latency: this.latency,
      clockOffset: this.clockOffset,
    });
  }

  // 게임 참여 메시지 생성
  createJoinGameMessage(
    playerId: string,
    clientVersion: string,
    preferredSeed?: number,
  ): JoinGameMessage {
    return {
      type: 'join_game',
      playerId,
      clientVersion,
      preferredSeed,
      timestamp: this.getAdjustedTime(),
    };
  }

  // 매치 준비 메시지 생성
  createMatchReadyMessage(
    playerId: string,
    clientVersion: string,
    preferredSeed?: number,
  ): MatchReadyMessage {
    return {
      type: 'match_ready',
      playerId,
      clientVersion,
      preferredSeed,
      timestamp: this.getAdjustedTime(),
    };
  }

  // 입력 이벤트 메시지 생성
  createInputEventMessage(
    playerId: string,
    actions: string[],
    currentPieceId?: string,
    expectedDropTick?: number,
  ): InputEventMessage {
    return {
      type: 'input_event',
      playerId,
      seq: this.getNextSequenceNumber(),
      actions,
      currentPieceId,
      expectedDropTick,
      timestamp: this.getAdjustedTime(),
    };
  }

  // Ping 메시지 생성
  createPingMessage(playerId: string): PingMessage {
    this.lastPingTime = Date.now();
    return {
      type: 'ping',
      playerId,
      clientSendTime: this.lastPingTime,
      timestamp: this.getAdjustedTime(),
    };
  }

  // 스냅샷 요청 메시지 생성
  createSnapshotRequestMessage(
    playerId: string,
    reason: 'desync_detected' | 'periodic_sync' | 'game_start',
  ): SnapshotRequestMessage {
    return {
      type: 'snapshot_request',
      playerId,
      reason,
      localSeq: this.sequenceNumber,
      timestamp: this.getAdjustedTime(),
    };
  }

  // ACK 메시지 생성
  createAckMessage(
    playerId: string,
    ackType: 'attack_received' | 'piece_placed' | 'line_cleared' | 'game_over',
    referenceId: string,
  ): AckMessage {
    return {
      type: 'ack',
      playerId,
      ackType,
      referenceId,
      timestamp: this.getAdjustedTime(),
    };
  }

  // Keepalive 메시지 생성
  createKeepaliveMessage(playerId: string): KeepaliveMessage {
    return {
      type: 'keepalive',
      playerId,
      timestamp: this.getAdjustedTime(),
    };
  }

  // Desync 리포트 메시지 생성
  createDesyncReportMessage(
    playerId: string,
    localState: {
      board: string;
      currentPiece: string;
      score: number;
      seq: number;
    },
    serverStateExpectedSeq: number,
    difference: string,
  ): DesyncReportMessage {
    return {
      type: 'desync_report',
      playerId,
      localState,
      serverStateExpectedSeq,
      difference,
      timestamp: this.getAdjustedTime(),
    };
  }

  // 주기적 Ping 시작
  startPeriodicPing(
    playerId: string,
    socket: any,
    intervalMs: number = 2000,
  ): void {
    this.pingInterval = setInterval(() => {
      const pingMessage = this.createPingMessage(playerId);
      socket.emit('ping', pingMessage);
    }, intervalMs);
  }

  // 주기적 Keepalive 시작
  startPeriodicKeepalive(
    playerId: string,
    socket: any,
    intervalMs: number = 30000,
  ): void {
    this.keepaliveInterval = setInterval(() => {
      const keepaliveMessage = this.createKeepaliveMessage(playerId);
      socket.emit('keepalive', keepaliveMessage);
    }, intervalMs);
  }

  // 주기적 작업 중지
  stopPeriodicTasks(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
  }

  // 메시지 배치 처리
  batchInputEvents(
    playerId: string,
    events: Array<{
      actions: string[];
      currentPieceId?: string;
      expectedDropTick?: number;
    }>,
  ): InputEventMessage[] {
    return events.map((event) =>
      this.createInputEventMessage(
        playerId,
        event.actions,
        event.currentPieceId,
        event.expectedDropTick,
      ),
    );
  }

  // 메시지 압축 (선택적)
  compressMessage(message: NetworkMessage): string {
    // 간단한 압축 예시 - 실제로는 더 정교한 압축 알고리즘 사용
    return JSON.stringify(message).replace(/\s+/g, '');
  }

  // 메시지 압축 해제
  decompressMessage(compressedMessage: string): NetworkMessage {
    return JSON.parse(compressedMessage);
  }

  // 연결 상태 확인
  isConnectionHealthy(): boolean {
    const now = Date.now();
    const timeSinceLastPing = now - this.lastPingTime;

    // 마지막 ping이 10초 이상 지났으면 연결 상태 불량으로 간주
    return timeSinceLastPing < 10000;
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

  // 리소스 정리
  cleanup(): void {
    this.stopPeriodicTasks();
    this.sequenceNumber = 0;
    this.lastPingTime = 0;
    this.latency = 0;
    this.clockOffset = 0;
  }
}
