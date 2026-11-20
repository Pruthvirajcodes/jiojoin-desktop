declare module "default-gateway" {
  export interface GatewayResult {
    gateway: string;
    version: 4 | 6;
    int: string | null;
  }
  export function gateway4async(): Promise<GatewayResult>;
  export function gateway6async(): Promise<GatewayResult>;
}
