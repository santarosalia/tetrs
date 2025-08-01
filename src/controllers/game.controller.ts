import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { GameService } from '../services/game.service';
import { CreateGameDto } from '../dto/create-game.dto';
import { JoinGameDto } from '../dto/join-game.dto';

@Controller('games')
export class GameController {
  constructor(private readonly gameService: GameService) {}

  @Post()
  async createGame(@Body() createGameDto: CreateGameDto) {
    const game = await this.gameService.createGame(createGameDto);
    return {
      success: true,
      data: game,
      timestamp: new Date().toISOString(),
    };
  }

  @Get()
  async getAllGames() {
    const games = await this.gameService.getAllGames();
    return {
      success: true,
      data: games,
      timestamp: new Date().toISOString(),
    };
  }

  @Get(':id')
  async getGame(@Param('id') id: string) {
    const game = await this.gameService.getGame(id);
    return {
      success: true,
      data: game,
      timestamp: new Date().toISOString(),
    };
  }

  @Post(':id/join')
  async joinGame(
    @Param('id') gameId: string,
    @Body() joinGameDto: JoinGameDto,
  ) {
    const player = await this.gameService.joinGame(gameId, joinGameDto);
    return {
      success: true,
      data: player,
      timestamp: new Date().toISOString(),
    };
  }

  @Post(':id/start')
  async startGame(@Param('id') gameId: string) {
    const game = await this.gameService.startGame(gameId);
    return {
      success: true,
      data: game,
      timestamp: new Date().toISOString(),
    };
  }
}
