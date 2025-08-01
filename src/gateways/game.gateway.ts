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
import { JoinGameDto } from '../dto/join-game.dto';
import { WsException } from '@nestjs/websockets';
import { LoggerService } from '../common/services/logger.service';
import { TetrisMapService } from '../services/tetris-map.service';

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
