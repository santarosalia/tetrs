import { Controller } from '@nestjs/common';
import { GameService } from '../services/game.service';

@Controller('games')
export class GameController {
  constructor(private readonly gameService: GameService) {}
}
