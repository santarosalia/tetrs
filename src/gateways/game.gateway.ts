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
  ) {
    // Redis 구독 설정
    this.setupRedisSubscriptions();
  }

  private setupRedisSubscriptions() {
    // 게임 상태 업데이트 구독
    this.redisService.subscribe('game_state_update:*', (message) => {
      try {
        const data = message;
        const playerId = data.playerId;

        // 모든 게임 상태 업데이트를 game_state_update로 통일
        this.server.to(playerId).emit('gameStateUpdate', data);
      } catch (error) {
        this.logger.logError(error);
      }
    });

    // 게임 시작 이벤트 구독
    this.redisService.subscribe('game_started:*', (message) => {
      try {
        const data = JSON.parse(message);
        const playerId = data.playerId;

        // 게임 시작 이벤트를 해당 플레이어에게 전송
        this.server.to(playerId).emit('gameStarted', {
          playerId: data.playerId,
          roomId: data.roomId,
          gameSeed: data.gameSeed,
          timestamp: data.timestamp,
        });

        this.logger.log(`게임 시작 이벤트 전송: ${playerId}`, {
          playerId,
          roomId: data.roomId,
          gameSeed: data.gameSeed,
        });
      } catch (error) {
        this.logger.logError(error);
      }
    });

    // 플레이어 상태 변경 이벤트 구독
    this.redisService.subscribe('player_state_changed:*', (message) => {
      try {
        const data = message;
        const roomId = data.roomId;

        // 룸의 모든 클라이언트에게 플레이어 상태 변경 알림
        this.server.to(roomId).emit('roomPlayersUpdate', {
          success: true,
          players: data.players,
          roomId,
          timestamp: Date.now(),
        });

        this.logger.log(`플레이어 상태 변경 이벤트 전송: ${roomId}`, {
          roomId,
          playerCount: data.players.length,
        });
      } catch (error) {
        this.logger.logError(error);
      }
    });
  }

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
      // 클라이언트에서 전송하는 게임 상태 데이터 제거
      // 서버에서만 게임 로직 처리
    },
  ) {
    try {
      const { playerId, action } = data;

      // 1. 입력 검증 (서버 권한)
      const validActions = [
        'moveLeft',
        'moveRight',
        'moveDown',
        'rotate',
        'hardDrop',
        'hold',
      ];
      if (!validActions.includes(action)) {
        this.logger.logInvalidInput(playerId, action, 'Invalid action type');
        return;
      }

      // 2. 플레이어 상태 확인
      const playerState = await this.gameService.getPlayerGameState(playerId);
      if (!playerState || playerState.gameOver) {
        this.logger.logInvalidInput(
          playerId,
          action,
          'Player not in game or game over',
        );
        return;
      }

      // 3. 서버에서 게임 로직 처리 (클라이언트 상태 무시)
      const updatedState = await this.gameService.handlePlayerInputServerOnly(
        playerId,
        action,
      );

      if (updatedState) {
        // 4. 업데이트된 상태를 모든 클라이언트에게 브로드캐스트
        client.broadcast
          .to(updatedState.roomId)
          .emit('playerGameStateChanged', {
            playerId,
            score: updatedState.score,
            level: updatedState.level,
            linesCleared: updatedState.linesCleared,
            gameOver: updatedState.gameOver,
            timestamp: Date.now(),
          });

        // 5. 개별 플레이어에게 상세 상태 전송
        client.emit('gameStateUpdate', {
          gameState: {
            board: updatedState.board,
            currentPiece: updatedState.currentPiece,
            nextPiece: updatedState.nextPiece,
            heldPiece: updatedState.heldPiece,
            ghostPiece: updatedState.ghostPiece,
            score: updatedState.score,
            level: updatedState.level,
            linesCleared: updatedState.linesCleared,
            gameOver: updatedState.gameOver,
            paused: updatedState.paused,
            gameSeed: updatedState.gameSeed,
            canHold: updatedState.canHold,
          },
        });

        // 6. 게임 오버 처리
        if (updatedState.gameOver) {
          await this.gameService.handleGameOver(playerId);
          // 게임 오버 상태를 gameStateUpdate로 통일하여 전송
          client.broadcast.to(updatedState.roomId).emit('gameStateUpdate', {
            playerId,
            gameState: {
              gameOver: true,
              score: updatedState.score,
              level: updatedState.level,
              linesCleared: updatedState.linesCleared,
            },
            type: 'game_state_update',
            timestamp: Date.now(),
          });
        }
      }

      this.logger.logPlayerInput(
        playerId,
        action,
        'Input processed successfully',
      );
    } catch (error) {
      this.logger.logError(error);
      client.emit('error', { message: '입력 처리 중 오류가 발생했습니다.' });
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
      client.join(player.id);

      // 기존 플레이어들의 게임 상태 조회
      const existingPlayers = await this.gameService.getRoomPlayers(roomId);

      // 신규 플레이어에게 기존 플레이어들의 상태 전송
      client.emit('existingPlayersState', {
        success: true,
        players: existingPlayers.filter((p) => p.id !== player.id), // 자신 제외
        roomId,
        timestamp: Date.now(),
      });

      // 신규 플레이어에게 룸의 전체 게임 상태 전송
      const roomGameState = await this.gameService.getRoomGameState(roomId);
      if (roomGameState) {
        client.emit('roomGameState', {
          success: true,
          gameState: roomGameState,
          roomId,
          timestamp: Date.now(),
        });
      }

      // 플레이어 상태 변경 이벤트 발행
      await this.gameService.publishPlayerStateChanged(roomId);

      // 기존 플레이어들에게 새 플레이어 참여 알림과 함께 최신 방 상태 전송
      this.server.to(roomId).emit('playerJoined', {
        player,
        roomId,
        roomState: {
          players: await this.gameService.getRoomPlayers(roomId),
          gameState: roomGameState,
          timestamp: Date.now(),
        },
      });

      // 룸 정보 조회 및 업데이트
      const room = await this.gameService.getRoom(roomId);
      const currentPlayers = await this.gameService.getRoomPlayers(roomId);

      let roomInfo = null;
      if (room) {
        // 룸 정보 구성
        roomInfo = {
          roomId: room.id,
          playerCount: currentPlayers.length,
          maxPlayers: 99, // 기본값
          roomStatus: room.status || 'waiting',
          averageScore: room.averageScore,
          highestScore: room.highestScore,
          createdAt: room.createdAt,
        };

        // 룸 통계 업데이트 (평균 점수, 최고 점수)
        if (room.averageScore || room.highestScore) {
          this.server.to(roomId).emit('roomStatsUpdate', {
            roomStats: {
              averageScore: room.averageScore,
              highestScore: room.highestScore,
            },
          });
        }
      }

      // 기존 플레이어들에게 전체 방 상태 업데이트 알림 (통합된 이벤트)
      this.server.to(roomId).emit('roomStateUpdate', {
        success: true,
        roomId,
        players: currentPlayers,
        gameState: roomGameState,
        newPlayer: player,
        roomInfo,
        playerCount: currentPlayers.length,
        timestamp: Date.now(),
      });

      // 클라이언트에게 응답 전송
      client.emit('joinAutoRoomResponse', { success: true, roomId, player });

      this.logger.log(
        `신규 플레이어 ${player.name}이 룸 ${roomId}에 입장했습니다. 기존 플레이어 ${existingPlayers.length - 1}명`,
        {
          roomId,
          newPlayerId: player.id,
          existingPlayerCount: existingPlayers.length - 1,
        },
      );

      return { success: true, roomId, player };
    } catch (error) {
      // 에러 응답도 클라이언트에게 전송
      client.emit('joinAutoRoomResponse', {
        success: false,
        error: {
          code: error.code || 'JOIN_AUTO_ROOM_ERROR',
          message: error.message,
        },
      });

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

      // 플레이어 상태 변경 이벤트 발행
      await this.gameService.publishPlayerStateChanged(data.roomId);

      // 룸 정보 업데이트
      const room = await this.gameService.getRoom(data.roomId);
      const currentPlayers = await this.gameService.getRoomPlayers(data.roomId);

      let roomInfo = null;
      if (room) {
        // 룸 정보 구성
        roomInfo = {
          roomId: room.id,
          playerCount: currentPlayers.length,
          maxPlayers: 99, // 기본값
          roomStatus: room.status || 'waiting',
          averageScore: room.averageScore,
          highestScore: room.highestScore,
          createdAt: room.createdAt,
        };

        // 룸 통계 업데이트 (평균 점수, 최고 점수)
        if (room.averageScore || room.highestScore) {
          this.server.to(data.roomId).emit('roomStatsUpdate', {
            roomStats: {
              averageScore: room.averageScore,
              highestScore: room.highestScore,
            },
          });
        }
      }

      // 통합된 룸 상태 업데이트 전송
      this.server.to(data.roomId).emit('roomStateUpdate', {
        success: true,
        roomId: data.roomId,
        players: currentPlayers,
        roomInfo,
        playerCount: currentPlayers.length,
        timestamp: Date.now(),
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

  @SubscribeMessage('getRoomInfo')
  async handleGetRoomInfo(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    try {
      const room = await this.gameService.getRoom(data.roomId);
      const roomPlayers = await this.gameService.getRoomPlayers(data.roomId);

      if (room) {
        const roomInfo = {
          roomId: room.id,
          playerCount: roomPlayers.length,
          maxPlayers: 99, // 기본값
          roomStatus: room.status || 'waiting',
          averageScore: room.averageScore,
          highestScore: room.highestScore,
          createdAt: room.createdAt,
        };

        // 통합된 룸 상태 업데이트 전송
        client.emit('roomStateUpdate', {
          success: true,
          roomId: room.id,
          players: roomPlayers,
          roomInfo,
          playerCount: roomPlayers.length,
          timestamp: Date.now(),
        });

        if (room.averageScore || room.highestScore) {
          client.emit('roomStatsUpdate', {
            roomStats: {
              averageScore: room.averageScore,
              highestScore: room.highestScore,
            },
          });
        }
      }

      return { success: true };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'GET_ROOM_INFO_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('getPlayerInfo')
  async handleGetPlayerInfo(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { playerId: string },
  ) {
    try {
      const playerInfo = await this.gameService.getPlayerInfo(data.playerId);
      return { success: true, playerInfo };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'GET_PLAYER_INFO_ERROR',
          message: error.message,
        },
      });
    }
  }
}
