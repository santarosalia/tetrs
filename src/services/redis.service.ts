import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { LoggerService } from '../common/services/logger.service';

export interface GameState {
  id: string;
  status: 'WAITING' | 'PLAYING' | 'FINISHED';
  maxPlayers: number;
  currentPlayers: number;
  linesSent: number;
  linesReceived: number;
  winnerId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlayerState {
  id: string;
  name: string;
  socketId: string;
  status: 'ALIVE' | 'ELIMINATED' | 'SPECTATING';
  score: number;
  linesCleared: number;
  level: number;
  gameId?: string;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(private readonly logger: LoggerService) {
    this.redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB || '0'),
    });
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  // 기본 Redis 메서드들
  async set(key: string, value: string): Promise<void> {
    await this.redis.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return await this.redis.get(key);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async sadd(key: string, member: string): Promise<void> {
    await this.redis.sadd(key, member);
  }

  async srem(key: string, member: string): Promise<void> {
    await this.redis.srem(key, member);
  }

  async smembers(key: string): Promise<string[]> {
    return await this.redis.smembers(key);
  }

  // 게임 관련 메서드들
  async createGame(
    gameData: Omit<GameState, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<GameState> {
    const id = this.generateId();
    const now = new Date().toISOString();
    const game: GameState = {
      ...gameData,
      id,
      createdAt: now,
      updatedAt: now,
    };

    await this.redis.set(`game:${id}`, JSON.stringify(game));
    await this.redis.sadd('games', id);
    await this.redis.expire(`game:${id}`, 3600); // 1시간 후 만료

    this.logger.logRedisOperation('CREATE', `game:${id}`);

    return game;
  }

  async getGame(gameId: string): Promise<GameState | null> {
    const gameData = await this.redis.get(`game:${gameId}`);
    if (!gameData) {
      return null;
    }

    try {
      return JSON.parse(gameData) as GameState;
    } catch (error) {
      this.logger.error('Failed to parse game data', error.stack, { gameId });
      return null;
    }
  }

  async updateGame(
    gameId: string,
    updates: Partial<GameState>,
  ): Promise<GameState | null> {
    const game = await this.getGame(gameId);
    if (!game) return null;

    const updatedGame = {
      ...game,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    await this.redis.set(`game:${gameId}`, JSON.stringify(updatedGame));
    return updatedGame;
  }

  async getAllGames(): Promise<GameState[]> {
    const gameIds = await this.redis.smembers('games');
    const games: GameState[] = [];

    for (const gameId of gameIds) {
      const game = await this.getGame(gameId);
      if (game) {
        games.push(game);
      }
    }

    return games;
  }

  async deleteGame(gameId: string): Promise<void> {
    await this.redis.del(`game:${gameId}`);
    await this.redis.srem('games', gameId);
  }

  // 플레이어 관련 메서드들
  async createPlayer(
    playerData: Omit<PlayerState, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<PlayerState> {
    const id = this.generateId();
    const now = new Date().toISOString();
    const player: PlayerState = {
      ...playerData,
      id,
      createdAt: now,
      updatedAt: now,
    };

    await this.redis.set(`player:${id}`, JSON.stringify(player));
    if (player.gameId) {
      await this.redis.sadd(`game:${player.gameId}:players`, id);
    }
    await this.redis.sadd('players', id);
    await this.redis.expire(`player:${id}`, 3600); // 1시간 후 만료

    return player;
  }

  async getPlayer(playerId: string): Promise<PlayerState | null> {
    const playerData = await this.redis.get(`player:${playerId}`);
    if (!playerData) {
      return null;
    }

    try {
      return JSON.parse(playerData) as PlayerState;
    } catch (error) {
      this.logger.error('Failed to parse player data', error.stack, {
        playerId,
      });
      return null;
    }
  }

  async updatePlayer(
    playerId: string,
    updates: Partial<PlayerState>,
  ): Promise<PlayerState | null> {
    const player = await this.getPlayer(playerId);
    if (!player) return null;

    const updatedPlayer = {
      ...player,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    await this.redis.set(`player:${playerId}`, JSON.stringify(updatedPlayer));
    return updatedPlayer;
  }

  async getPlayersByGame(gameId: string): Promise<PlayerState[]> {
    const playerIds = await this.redis.smembers(`game:${gameId}:players`);
    const players: PlayerState[] = [];

    for (const playerId of playerIds) {
      const player = await this.getPlayer(playerId);
      if (player) {
        players.push(player);
      }
    }

    return players;
  }

  async getAllPlayers(): Promise<PlayerState[]> {
    const playerIds = await this.redis.smembers('players');
    const players: PlayerState[] = [];

    for (const playerId of playerIds) {
      const player = await this.getPlayer(playerId);
      if (player) {
        players.push(player);
      }
    }

    return players;
  }

  async deletePlayer(playerId: string): Promise<void> {
    const player = await this.getPlayer(playerId);
    if (player && player.gameId) {
      await this.redis.srem(`game:${player.gameId}:players`, playerId);
    }
    await this.redis.del(`player:${playerId}`);
    await this.redis.srem('players', playerId);
  }

  // 실시간 게임 상태 관리
  async setGameStatus(
    gameId: string,
    status: GameState['status'],
  ): Promise<void> {
    await this.updateGame(gameId, { status });
  }

  async incrementGamePlayers(gameId: string): Promise<void> {
    const game = await this.getGame(gameId);
    if (game) {
      await this.updateGame(gameId, {
        currentPlayers: game.currentPlayers + 1,
      });
    }
  }

  async decrementGamePlayers(gameId: string): Promise<void> {
    const game = await this.getGame(gameId);
    if (game && game.currentPlayers > 0) {
      await this.updateGame(gameId, {
        currentPlayers: game.currentPlayers - 1,
      });
    }
  }

  // Pub/Sub 기능
  async publish(channel: string, message: any): Promise<void> {
    await this.redis.publish(channel, JSON.stringify(message));
  }

  async subscribe(
    channel: string,
    callback: (message: any) => void,
  ): Promise<void> {
    const subscriber = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB || '0'),
    });

    if (channel.includes('*')) {
      subscriber.psubscribe(channel);
      subscriber.on('pmessage', (pattern, ch, message) => {
        if (pattern === channel) {
          callback(JSON.parse(message));
        }
      });
    } else {
      subscriber.subscribe(channel);
      subscriber.on('message', (ch, message) => {
        if (ch === channel) {
          callback(JSON.parse(message));
        }
      });
    }
  }

  // 유틸리티 메서드
  private generateId(): string {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  // 게임 통계 업데이트
  async updateGameStats(
    gameId: string,
    linesSent: number,
    linesReceived: number,
  ): Promise<void> {
    const game = await this.getGame(gameId);
    if (game) {
      await this.updateGame(gameId, {
        linesSent: game.linesSent + linesSent,
        linesReceived: game.linesReceived + linesReceived,
      });
    }
  }

  // 플레이어 통계 업데이트
  async updatePlayerStats(
    playerId: string,
    stats: { score?: number; linesCleared?: number; level?: number },
  ): Promise<void> {
    const player = await this.getPlayer(playerId);
    if (player) {
      const updates: Partial<PlayerState> = {};
      if (stats.score !== undefined) updates.score = player.score + stats.score;
      if (stats.linesCleared !== undefined)
        updates.linesCleared = player.linesCleared + stats.linesCleared;
      if (stats.level !== undefined) updates.level = stats.level;

      await this.updatePlayer(playerId, updates);
    }
  }

  // Redis 인스턴스 접근자
  getRedisInstance(): Redis {
    return this.redis;
  }
}
