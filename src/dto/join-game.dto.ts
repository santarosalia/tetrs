import { IsString, IsNotEmpty, MinLength, MaxLength } from 'class-validator';

export class JoinGameDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(20)
  name: string;

  @IsString()
  @IsNotEmpty()
  socketId: string;
}
