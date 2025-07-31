import { IsOptional, IsNumber, Min, Max } from 'class-validator';

export class CreateGameDto {
  @IsOptional()
  @IsNumber()
  @Min(2)
  @Max(99)
  maxPlayers?: number;
}
