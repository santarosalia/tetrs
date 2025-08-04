import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { GameService } from '../services/game.service';
import { RedisService } from '../services/redis.service';
import { NetworkSyncService } from '../services/network-sync.service';
import { JoinGameDto } from '../dto/join-game.dto';
import { WsException } from '@nestjs/websockets';
import { LoggerService } from '../common/services/logger.service';
import { TetrisMapService } from '../services/tetris-map.service';
import {
  JoinGameMessage,
  MatchReadyMessage,
  InputEventMessage,
  PingMessage,
  SnapshotRequestMessage,
  AckMessage,
  KeepaliveMessage,
  DesyncReportMessage,
} from '../common/interfaces/network-message.interface';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly gameService: GameService,
    private readonly redisService: RedisService,
    private readonly networkSyncService: NetworkSyncService,
    private readonly logger: LoggerService,
    private readonly tetrisMapService: TetrisMapService,
  ) {}

  handleConnection(client: Socket) {
    this.logger.logWebSocketConnection(client.id, {
      ip: client.handshake.address,
      userAgent: client.handshake.headers['user-agent'],
    });
  }

  handleDisconnect(client: Socket) {
    this.logger.logWebSocketDisconnection(client.id, {
      ip: client.handshake.address,
    });
  }

  // 새로운 네트워크 통신 프로토콜 메시지 핸들러들

  @SubscribeMessage('join_game')
  async handleJoinGameProtocol(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: JoinGameMessage,
  ) {
    try {
      const { playerId } = data;

      // 클라이언트 상태 초기화
      this.networkSyncService.initializeClientState(playerId, 'auto_room');

      // 자동 룸 배정으로 게임 참여
      const joinGameDto: JoinGameDto = {
        name: playerId,
        socketId: client.id,
      };

      const { roomId, player } =
        await this.gameService.joinGameAuto(joinGameDto);

      // 게임 룸에 참여
      client.join(roomId);

      // 서버 응답: 공유 시드, 게임 설정 등
      const response = {
        type: 'join_game_response',
        playerId,
        roomId,
        sharedSeed: Math.floor(Math.random() * 1000000),
        garbageSyncSeed: Math.floor(Math.random() * 1000000),
        gameSettings: {
          tickRate: 60,
          gravity: 1,
          dropDelay: 1000,
        },
        player,
      };

      // 룸의 다른 플레이어들에게 새 플레이어 참여 알림
      client.broadcast.to(roomId).emit('playerJoined', {
        player,
        roomId,
      });

      return response;
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'JOIN_GAME_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('match_ready')
  async handleMatchReady(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: MatchReadyMessage,
  ) {
    try {
      const { playerId } = data;

      // 매치 준비 완료 처리
      this.logger.log(`Player ${playerId} is ready for match`, {
        playerId,
      });

      // 다른 플레이어들에게 매치 준비 완료 알림
      client.broadcast.to('auto_room').emit('player_ready', {
        playerId,
        timestamp: Date.now(),
      });

      return { success: true, playerId };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'MATCH_READY_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('input_event')
  async handleInputEvent(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: InputEventMessage,
  ) {
    try {
      const { playerId, seq, actions } = data;

      // 입력 이벤트 처리
      const success = await this.networkSyncService.handleInputEvent(data);

      if (success) {
        // 다른 플레이어들에게 입력 이벤트 브로드캐스트
        client.broadcast.to('auto_room').emit('input_event_received', {
          playerId,
          seq,
          actions,
          timestamp: Date.now(),
        });
      }

      return { success, seq };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'INPUT_EVENT_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('ping')
  async handlePing(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: PingMessage,
  ) {
    try {
      const pongMessage = await this.networkSyncService.handlePing(data);
      return pongMessage;
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'PING_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('snapshot_request')
  async handleSnapshotRequest(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: SnapshotRequestMessage,
  ) {
    try {
      const snapshotMessage =
        await this.networkSyncService.handleSnapshotRequest(data);
      return snapshotMessage;
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'SNAPSHOT_REQUEST_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('ack')
  async handleAck(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: AckMessage,
  ) {
    try {
      await this.networkSyncService.handleAck(data);
      return { success: true };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'ACK_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('keepalive')
  async handleKeepalive(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: KeepaliveMessage,
  ) {
    try {
      await this.networkSyncService.handleKeepalive(data);
      return { success: true };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'KEEPALIVE_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('desync_report')
  async handleDesyncReport(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: DesyncReportMessage,
  ) {
    try {
      await this.networkSyncService.handleDesyncReport(data);
      return { success: true };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'DESYNC_REPORT_ERROR',
          message: error.message,
        },
      });
    }
  }

  // 개인 게임 관련 메시지 핸들러들

  @SubscribeMessage('getPlayerGameState')
  async handleGetPlayerGameState(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { playerId: string },
  ) {
    try {
      const gameState = await this.gameService.getPlayerGameState(
        data.playerId,
      );
      return { success: true, gameState };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'GET_PLAYER_GAME_STATE_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('handlePlayerInput')
  async handlePlayerInput(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      playerId: string;
      action: string;
      currentPiece?: any;
      board?: number[][];
      score?: number;
      level?: number;
      linesCleared?: number;
    },
  ) {
    try {
      const gameState = await this.gameService.handlePlayerInput(
        data.playerId,
        {
          action: data.action,
          currentPiece: data.currentPiece,
          board: data.board,
          score: data.score,
          level: data.level,
          linesCleared: data.linesCleared,
        },
      );

      if (gameState) {
        // 클라이언트에게 업데이트된 게임 상태 전송
        client.emit('gameStateUpdated', {
          success: true,
          gameState,
          timestamp: Date.now(),
        });

        // 룸의 다른 플레이어들에게 게임 상태 변경 알림 (옵션)
        const roomId = gameState.roomId;
        if (roomId) {
          client.broadcast.to(roomId).emit('playerGameStateChanged', {
            playerId: data.playerId,
            score: gameState.score,
            level: gameState.level,
            linesCleared: gameState.linesCleared,
            timestamp: Date.now(),
          });
        }
      }

      return { success: true, gameState };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'HANDLE_PLAYER_INPUT_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('updatePlayerGameState')
  async handleUpdatePlayerGameState(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      playerId: string;
      updates: any;
    },
  ) {
    try {
      await this.gameService.updatePlayerGameState(data.playerId, data.updates);
      return { success: true };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'UPDATE_PLAYER_GAME_STATE_ERROR',
          message: error.message,
        },
      });
    }
  }

  // 자동 룸 시스템 관련 메시지 핸들러들

  @SubscribeMessage('joinAutoRoom')
  async handleJoinAutoRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { name: string },
  ) {
    try {
      const joinGameDto: JoinGameDto = {
        name: data.name,
        socketId: client.id,
      };

      const { roomId, player } =
        await this.gameService.joinGameAuto(joinGameDto);

      // 룸에 참여
      client.join(roomId);

      // 다른 플레이어들에게 새 플레이어 참여 알림
      this.server.to(roomId).emit('playerJoined', {
        player,
        roomId,
      });

      return { success: true, roomId, player };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'JOIN_AUTO_ROOM_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('leaveAutoRoom')
  async handleLeaveAutoRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string; playerId: string },
  ) {
    try {
      await this.gameService.leaveGameAuto(data.roomId, data.playerId);

      // 클라이언트 상태 정리
      this.networkSyncService.cleanupClientState(data.playerId);

      // 룸에서 나가기
      client.leave(data.roomId);

      // 다른 플레이어들에게 플레이어 퇴장 알림
      this.server.to(data.roomId).emit('playerLeft', {
        playerId: data.playerId,
        roomId: data.roomId,
      });

      return { success: true };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'LEAVE_AUTO_ROOM_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('getRoomStats')
  async handleGetRoomStats() {
    try {
      const stats = await this.gameService.getRoomStats();
      return { success: true, stats };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'GET_ROOM_STATS_ERROR',
          message: error.message,
        },
      });
    }
  }

  // 기존 메시지 핸들러들 (하위 호환성 유지)

  @SubscribeMessage('joinGame')
  async handleJoinGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string; name: string },
  ) {
    try {
      const joinGameDto: JoinGameDto = {
        name: data.name,
        socketId: client.id,
      };

      const player = await this.gameService.joinGame(data.gameId, joinGameDto);

      // Join the game room
      client.join(data.gameId);

      // Notify all players in the game
      this.server.to(data.gameId).emit('playerJoined', {
        player,
        gameId: data.gameId,
      });

      return { success: true, player };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'JOIN_GAME_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('startGame')
  async handleStartGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string },
  ) {
    try {
      const game = await this.gameService.startGame(data.gameId);

      // Notify all players that game has started
      this.server.to(data.gameId).emit('gameStarted', {
        game,
        gameId: data.gameId,
      });

      return { success: true, game };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'START_GAME_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('playerEliminated')
  async handlePlayerEliminated(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { playerId: string },
  ) {
    try {
      const player = await this.gameService.eliminatePlayer(data.playerId);

      // Notify all players about elimination
      this.server.to(player.gameId).emit('playerEliminated', {
        player,
        gameId: player.gameId,
      });

      return { success: true, player };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'PLAYER_ELIMINATED_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('updateStats')
  async handleUpdateStats(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      playerId: string;
      score?: number;
      linesCleared?: number;
      level?: number;
    },
  ) {
    try {
      const player = await this.gameService.updatePlayerStats(data.playerId, {
        score: data.score,
        linesCleared: data.linesCleared,
        level: data.level,
      });

      // Notify all players about stats update
      this.server.to(player.gameId).emit('statsUpdated', {
        player,
        gameId: player.gameId,
      });

      return { success: true, player };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'UPDATE_STATS_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('leaveGame')
  async handleLeaveGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { playerId: string },
  ) {
    try {
      await this.gameService.leaveGame(data.playerId);

      // 클라이언트 상태 정리
      this.networkSyncService.cleanupClientState(data.playerId);

      // Leave the game room
      client.leave(data.playerId);

      return { success: true };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'LEAVE_GAME_ERROR',
          message: error.message,
        },
      });
    }
  }

  // 테트리스 맵 관련 이벤트들
  @SubscribeMessage('getGameMapState')
  async handleGetGameMapState(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string },
  ) {
    try {
      const gameMapState = await this.gameService.getGameMapState(data.gameId);
      return { success: true, data: gameMapState };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'GET_MAP_STATE_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('updatePlayerMap')
  async handleUpdatePlayerMap(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      gameId: string;
      playerId: string;
      mapData: any;
    },
  ) {
    try {
      await this.gameService.updatePlayerMap(
        data.gameId,
        data.playerId,
        data.mapData,
      );

      // 모든 플레이어에게 맵 업데이트 알림
      this.server.to(data.gameId).emit('playerMapUpdated', {
        gameId: data.gameId,
        playerId: data.playerId,
        timestamp: new Date().toISOString(),
      });

      return { success: true };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'UPDATE_MAP_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('initializePlayerMap')
  async handleInitializePlayerMap(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      gameId: string;
      playerId: string;
      playerName: string;
    },
  ) {
    try {
      await this.gameService.initializePlayerMap(
        data.gameId,
        data.playerId,
        data.playerName,
      );

      // 모든 플레이어에게 새 플레이어 맵 초기화 알림
      this.server.to(data.gameId).emit('playerMapInitialized', {
        gameId: data.gameId,
        playerId: data.playerId,
        playerName: data.playerName,
        timestamp: new Date().toISOString(),
      });

      return { success: true };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'INITIALIZE_MAP_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('subscribeToMapUpdates')
  async handleSubscribeToMapUpdates(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string },
  ) {
    try {
      // Redis 구독 설정
      await this.tetrisMapService.subscribeToMapUpdates(
        data.gameId,
        (message) => {
          // 구독한 클라이언트에게 맵 업데이트 전송
          this.server.to(data.gameId).emit('mapUpdateReceived', message);
        },
      );

      return { success: true };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'SUBSCRIBE_MAP_ERROR',
          message: error.message,
        },
      });
    }
  }
}
