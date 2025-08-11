# Node.js 20.11.1 버전을 기반으로 하는 이미지 사용
FROM node:20.11.1-alpine

RUN npm install -g pnpm

# 작업 디렉토리 설정
WORKDIR /app

# package.json과 package-lock.json 복사
COPY package*.json pnpm-lock.yaml ./

RUN pnpm install

# 소스 코드 복사
COPY . .

# Prisma 클라이언트 생성
# RUN npx prisma generate
# TypeScript 빌드
RUN npx prisma generate
RUN pnpm run build

# 포트 설정
EXPOSE 3000

# 애플리케이션 실행
CMD ["pnpm", "run", "start:prod"]