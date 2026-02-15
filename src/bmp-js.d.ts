declare module 'bmp-js' {
    export function encode(data: { data: Uint8Array; width: number; height: number }): { data: Buffer };
    export function decode(buffer: Buffer): { data: Buffer; width: number; height: number };
}
