-- CreateEnum
CREATE TYPE "public"."GameStatus" AS ENUM ('WAITING', 'PLAYING', 'FINISHED');

-- CreateEnum
CREATE TYPE "public"."PlayerStatus" AS ENUM ('ALIVE', 'ELIMINATED', 'SPECTATING');

-- CreateTable
CREATE TABLE "public"."games" (
    "id" TEXT NOT NULL,
    "status" "public"."GameStatus" NOT NULL DEFAULT 'WAITING',
    "maxPlayers" INTEGER NOT NULL DEFAULT 99,
    "currentPlayers" INTEGER NOT NULL DEFAULT 0,
    "linesSent" INTEGER NOT NULL DEFAULT 0,
    "linesReceived" INTEGER NOT NULL DEFAULT 0,
    "winnerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."players" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "socketId" TEXT NOT NULL,
    "status" "public"."PlayerStatus" NOT NULL DEFAULT 'ALIVE',
    "score" INTEGER NOT NULL DEFAULT 0,
    "linesCleared" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 0,
    "gameId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "players_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "public"."players" ADD CONSTRAINT "players_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "public"."games"("id") ON DELETE SET NULL ON UPDATE CASCADE;
