export declare function toolFromProvider(provider: string): string;
export declare function computeFingerprint(provider: string, sourcePort: number, authHeader: string | null): string;
export declare function getOrCreateSession(provider: string, sourcePort: number, authHeader: string | null, endpoint: string): number;
