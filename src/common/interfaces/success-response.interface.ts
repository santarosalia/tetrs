export interface SuccessResponse<T = any> {
  success: true;
  data: T;
  timestamp: string;
}
