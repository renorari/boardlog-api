/*
    Server-Sent Events utilities
*/

import type { Response } from "express";

export const sseConnections = new Map<string, Set<Response>>();

export function broadcast(res: Response, roomCode: string, event: string, data: unknown) {
    const connections = sseConnections.get(roomCode);
    if (!connections) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of connections) {
        res.write(payload);
    }
}
