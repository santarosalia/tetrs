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
  ) {
    // Redis 구독 설정
    this.setupRedisSubscriptions();
  }

  private setupRedisSubscriptions() {
    // 게임 상태 업데이트 구독
    this.redisService.subscribe('game_state_update:*', (message) => {
      try {
        const data = JSON.parse(message);
        console.log('update', data);
        const playerId = data.playerId;

        if (data.type === 'gameOver') {
          // 게임오버 이벤트를 해당 플레이어에게 전송
          this.server.to(playerId).emit('gameOver', {
            playerId: data.playerId,
            finalScore: data.finalScore,
            finalLevel: data.finalLevel,
            finalLines: data.finalLines,
            reason: data.reason,
            timestamp: data.timestamp,
          });

          this.logger.log(`게임오버 이벤트 전송: ${playerId}`, {
            playerId,
            finalScore: data.finalScore,
            finalLevel: data.finalLevel,
            finalLines: data.finalLines,
          });
        } else if (data.type === 'game_state_update') {
          // 일반 게임 상태 업데이트
          this.server.to(playerId).emit('gameStateUpdate', data);
        }
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

      // 플레이어 게임 상태 가져오기
      const playerGameState =
        await this.gameService.getPlayerGameState(playerId);

      // 서버 응답: 게임 시드, 게임 설정 등
      const response = {
        type: 'join_game_response',
        playerId,
        roomId,
        gameSeed:
          playerGameState?.gameSeed || Math.floor(Math.random() * 1000000),
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

      // 룸의 모든 클라이언트에게 업데이트된 플레이어 목록 전송
      const roomPlayers = await this.gameService.getRoomPlayers(roomId);
      this.server.to(roomId).emit('roomPlayersUpdate', {
        success: true,
        players: roomPlayers,
        roomId,
        timestamp: Date.now(),
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
          client.broadcast.to(updatedState.roomId).emit('playerGameOver', {
            playerId,
            finalScore: updatedState.score,
            finalLevel: updatedState.level,
            finalLines: updatedState.linesCleared,
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

  // 보드 상태 검증 메서드 추가
  private validateBoardState(
    serverBoard: number[][],
    clientBoard: number[][],
  ): number {
    if (!serverBoard || !clientBoard) return 1.0;

    let differences = 0;
    let totalCells = 0;

    for (let y = 0; y < Math.min(serverBoard.length, clientBoard.length); y++) {
      for (
        let x = 0;
        x < Math.min(serverBoard[y].length, clientBoard[y].length);
        x++
      ) {
        totalCells++;
        if (serverBoard[y][x] !== clientBoard[y][x]) {
          differences++;
        }
      }
    }

    return totalCells > 0 ? differences / totalCells : 1.0;
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

      // 룸의 모든 클라이언트에게 업데이트된 플레이어 목록 전송
      const roomPlayers = await this.gameService.getRoomPlayers(roomId);

      // 기존 플레이어들에게 새 플레이어 참여 알림과 함께 최신 방 상태 전송
      this.server.to(roomId).emit('playerJoined', {
        player,
        roomId,
        roomState: {
          players: roomPlayers,
          gameState: roomGameState,
          timestamp: Date.now(),
        },
      });

      // 룸의 모든 클라이언트에게 업데이트된 플레이어 목록 전송
      this.server.to(roomId).emit('roomPlayersUpdate', {
        success: true,
        players: roomPlayers,
        roomId,
        timestamp: Date.now(),
      });

      // 룸 정보 조회 및 업데이트
      const room = await this.gameService.getRoom(roomId);

      if (room) {
        // 룸 정보 구성
        const roomInfo = {
          roomId: room.id,
          playerCount: roomPlayers.length,
          maxPlayers: 99, // 기본값
          roomStatus: room.status || 'waiting',
          averageScore: room.averageScore,
          highestScore: room.highestScore,
          createdAt: room.createdAt,
        };

        // 모든 클라이언트에게 룸 정보 업데이트 전송
        this.server.to(roomId).emit('roomInfoUpdate', {
          roomInfo,
        });

        // 룸 플레이어 수 업데이트
        this.server.to(roomId).emit('roomPlayerCountUpdate', {
          playerCount: roomPlayers.length,
        });

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

      // 기존 플레이어들에게 전체 방 상태 업데이트 알림
      this.server.to(roomId).emit('roomStateUpdate', {
        success: true,
        roomId,
        players: roomPlayers,
        gameState: roomGameState,
        newPlayer: player,
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

      // 룸의 모든 클라이언트에게 업데이트된 플레이어 목록 전송
      const roomPlayers = await this.gameService.getRoomPlayers(data.roomId);
      this.server.to(data.roomId).emit('roomPlayersUpdate', {
        success: true,
        players: roomPlayers,
        roomId: data.roomId,
        timestamp: Date.now(),
      });

      // 룸 정보 업데이트
      const room = await this.gameService.getRoom(data.roomId);
      if (room) {
        // 룸 정보 구성
        const roomInfo = {
          roomId: room.id,
          playerCount: roomPlayers.length,
          maxPlayers: 99, // 기본값
          roomStatus: room.status || 'waiting',
          averageScore: room.averageScore,
          highestScore: room.highestScore,
          createdAt: room.createdAt,
        };

        // 모든 클라이언트에게 룸 정보 업데이트 전송
        this.server.to(data.roomId).emit('roomInfoUpdate', {
          roomInfo,
        });

        // 룸 플레이어 수 업데이트
        this.server.to(data.roomId).emit('roomPlayerCountUpdate', {
          playerCount: roomPlayers.length,
        });

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

  @SubscribeMessage('getRoomPlayers')
  async handleGetRoomPlayers(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    try {
      this.logger.log(`룸 플레이어 조회 요청: ${data.roomId}`, {
        roomId: data.roomId,
        clientId: client.id,
      });

      const players = await this.gameService.getRoomPlayers(data.roomId);

      this.logger.log(`룸 플레이어 조회 완료: ${data.roomId}`, {
        roomId: data.roomId,
        playerCount: players.length,
        players: players.map((p) => ({
          id: p.id,
          name: p.name,
          score: p.score,
          level: p.level,
          lines: p.lines,
          gameOver: p.gameOver,
          hasGameState: !!p.gameState,
        })),
      });

      // 클라이언트에게 플레이어 정보 전송
      client.emit('roomPlayersUpdate', {
        success: true,
        players,
        roomId: data.roomId,
        timestamp: Date.now(),
      });

      return { success: true, players };
    } catch (error) {
      throw new WsException({
        success: false,
        error: {
          code: error.code || 'GET_ROOM_PLAYERS_ERROR',
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

        client.emit('roomInfoUpdate', {
          roomInfo,
        });

        client.emit('roomPlayerCountUpdate', {
          playerCount: roomPlayers.length,
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

  @SubscribeMessage('fixGameStateSync')
  async handleFixGameStateSync(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { playerId: string },
  ) {
    try {
      const { playerId } = data;

      this.logger.log(`게임 상태 동기화 수정 요청: ${playerId}`, {
        playerId,
        clientId: client.id,
      });

      // 서버 권위적으로 게임 상태 수정
      const fixedState = await this.gameService.fixGameStateSync(playerId);

      if (fixedState) {
        // 수정된 상태를 클라이언트에게 전송
        client.emit('gameStateSyncFixed', {
          success: true,
          gameState: {
            board: fixedState.board || [],
            currentPiece: fixedState.currentPiece || null,
            nextPiece: fixedState.nextPiece || null,
            heldPiece: fixedState.heldPiece || null,
            canHold: fixedState.canHold || false,
            score: fixedState.score || 0,
            level: fixedState.level || 1,
            linesCleared: fixedState.linesCleared || 0,
            gameOver: fixedState.gameOver || false,
            paused: fixedState.paused || false,
            ghostPiece: fixedState.ghostPiece || null,
            tetrominoBag: fixedState.tetrominoBag,
            bagIndex: fixedState.bagIndex,
            gameSeed: fixedState.gameSeed,
          },
          timestamp: Date.now(),
        });

        // 룸의 다른 플레이어들에게 상태 변경 알림
        if (fixedState.roomId) {
          client.broadcast
            .to(fixedState.roomId)
            .emit('playerGameStateChanged', {
              playerId,
              score: fixedState.score,
              level: fixedState.level,
              linesCleared: fixedState.linesCleared,
              gameOver: fixedState.gameOver,
              timestamp: Date.now(),
            });
        }

        this.logger.log(`게임 상태 동기화 수정 완료: ${playerId}`, {
          playerId,
          currentPiece: fixedState.currentPiece?.type,
          ghostPiece: fixedState.ghostPiece?.type,
          nextPiece: fixedState.nextPiece,
          gameOver: fixedState.gameOver,
        });
      } else {
        client.emit('gameStateSyncFixed', {
          success: false,
          error: '게임 상태를 찾을 수 없거나 게임이 종료되었습니다.',
        });
      }

      return { success: true, fixedState };
    } catch (error) {
      this.logger.log(`게임 상태 동기화 수정 실패: ${error.message}`, {
        error,
        playerId: data.playerId,
      });

      client.emit('gameStateSyncFixed', {
        success: false,
        error: error.message,
      });

      throw new WsException({
        success: false,
        error: {
          code: error.code || 'FIX_GAME_STATE_SYNC_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('forceGameOverState')
  async handleForceGameOverState(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { playerId: string },
  ) {
    try {
      const { playerId } = data;

      this.logger.log(`게임 오버 상태 강제 수정 요청: ${playerId}`, {
        playerId,
        clientId: client.id,
      });

      // 서버에서 게임 오버 상태 강제 수정
      const updatedState = await this.gameService.forceGameOverState(playerId);

      if (updatedState) {
        // 수정된 상태를 클라이언트에게 전송
        client.emit('gameOverStateForced', {
          success: true,
          gameState: {
            board: updatedState.board || [],
            currentPiece: updatedState.currentPiece || null,
            nextPiece: updatedState.nextPiece || null,
            heldPiece: updatedState.heldPiece || null,
            canHold: updatedState.canHold || false,
            score: updatedState.score || 0,
            level: updatedState.level || 1,
            linesCleared: updatedState.linesCleared || 0,
            gameOver: updatedState.gameOver || true,
            paused: updatedState.paused || false,
            ghostPiece: updatedState.ghostPiece || null,
            tetrominoBag: updatedState.tetrominoBag,
            bagIndex: updatedState.bagIndex,
            gameSeed: updatedState.gameSeed,
          },
          timestamp: Date.now(),
        });

        // 룸의 다른 플레이어들에게 게임 오버 알림
        if (updatedState.roomId) {
          client.broadcast.to(updatedState.roomId).emit('playerGameOver', {
            playerId,
            finalScore: updatedState.score,
            finalLevel: updatedState.level,
            finalLines: updatedState.linesCleared,
            timestamp: Date.now(),
          });
        }

        this.logger.log(`게임 오버 상태 강제 수정 완료: ${playerId}`, {
          playerId,
          gameOver: updatedState.gameOver,
        });
      } else {
        client.emit('gameOverStateForced', {
          success: false,
          error: '게임 상태를 찾을 수 없습니다.',
        });
      }

      return { success: true, updatedState };
    } catch (error) {
      this.logger.log(`게임 오버 상태 강제 수정 실패: ${error.message}`, {
        error,
        playerId: data.playerId,
      });

      client.emit('gameOverStateForced', {
        success: false,
        error: error.message,
      });

      throw new WsException({
        success: false,
        error: {
          code: error.code || 'FORCE_GAME_OVER_STATE_ERROR',
          message: error.message,
        },
      });
    }
  }

  @SubscribeMessage('startRoomGame')
  async handleStartRoomGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    try {
      await this.gameService.startRoomGame(data.roomId);

      // 룸의 플레이어들의 게임 상태를 가져와서 시드 정보 추출
      const players = await this.gameService.getRoomPlayers(data.roomId, true);
      const gameSeed =
        players.length > 0 && players[0].gameState?.gameSeed
          ? players[0].gameState.gameSeed
          : Date.now() + Math.floor(Math.random() * 1000);

      // 룸의 모든 플레이어에게 게임 시작 알림 (시드 포함)
      this.server.to(data.roomId).emit('roomGameStarted', {
        roomId: data.roomId,
        gameSeed,
        timestamp: Date.now(),
      });

      // 클라이언트에게 성공 응답 전송
      client.emit('startRoomGameResponse', {
        success: true,
        roomId: data.roomId,
        gameSeed,
        timestamp: Date.now(),
      });

      return { success: true, roomId: data.roomId };
    } catch (error) {
      // 클라이언트에게 실패 응답 전송
      client.emit('startRoomGameResponse', {
        success: false,
        error: {
          code: error.code || 'START_ROOM_GAME_ERROR',
          message: error.message,
        },
      });

      throw new WsException({
        success: false,
        error: {
          code: error.code || 'START_ROOM_GAME_ERROR',
          message: error.message,
        },
      });
    }
  }
}
