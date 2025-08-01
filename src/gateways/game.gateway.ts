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
  ) {}

  handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
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
}
