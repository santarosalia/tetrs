export interface LogContext {
  userId?: string;
  gameId?: string;
  playerId?: string;
  action?: string;
  method?: string;
  path?: string;
  ip?: string;
  userAgent?: string;
  duration?: number;
  [key: string]: any;
}
