/*
    Room routes
*/

import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import yazl from "yazl";

import { IMAGE_DIR } from "../constants/index.ts";
import { prisma, redis } from "../utils/db.ts";
import { ensureDir, generateRoomCode } from "../utils/functions.ts";
import log from "../utils/logger.ts";
import { upload } from "../utils/multer.ts";
import { broadcast, sseConnections } from "../utils/sse.ts";

import type { Request, Response } from "express";

const logger = log.getLogger();

const router = express.Router();

router.post("/", async (req: Request, res: Response) => {
    try {
        let code: string = req.body.code;
        if (code && typeof code === "string") {
            if (code.length < 6) {
                res.status(400).json({ "error": "Room code must be at least 6 characters" });
                return;
            }
        } else {
            code = generateRoomCode();
        }

        const room = await prisma.room.create({
            "data": { code }
        });

        res.status(201).json(room);
    } catch (err) {
        logger.error("POST /api/rooms error", err);
        res.status(500).json({ "error": "Failed to create room" });
    }
});

router.get("/:code", async (req: Request, res: Response) => {
    try {
        const roomCode = req.params.code as string;
        const room = await prisma.room.findUnique({
            "where": { "code": roomCode }
        });
        if (!room) {
            res.status(404).json({ "error": "Room not found" });
            return;
        }
        res.json(room);
    } catch (err) {
        logger.error("GET /api/rooms/:code error", err);
        res.status(500).json({ "error": "Failed to get room" });
    }
});

router.post("/:code/images", upload.single("image"), async (req: Request, res: Response) => {
    try {
        const roomCode = req.params.code as string;
        const room = await prisma.room.findUnique({
            "where": { "code": roomCode }
        });
        if (!room) {
            res.status(404).json({ "error": "Room not found" });
            return;
        }

        if (!req.file) {
            res.status(400).json({ "error": "No image uploaded" });
            return;
        }

        const filename = `${crypto.randomUUID()}.heic`;
        const dir = path.join(IMAGE_DIR, room.id);
        ensureDir(dir);
        const filePath = path.join(dir, filename);

        await fs.promises.writeFile(filePath, req.file.buffer);

        const image = await prisma.image.create({
            "data": {
                "roomId": room.id,
                filename,
                "path": filePath
            }
        });

        broadcast(res, roomCode, "new_image", {
            "type": "new_image",
            "id": image.id,
            "timestamp": image.createdAt.toISOString()
        });

        res.status(201).json(image);
    } catch (err) {
        logger.error("POST /api/rooms/:code/images error", err);
        res.status(500).json({ "error": "Failed to upload image" });
    }
});

router.post("/:code/live", upload.single("image"), async (req: Request, res: Response) => {
    try {
        const roomCode = req.params.code as string;
        const room = await prisma.room.findUnique({
            "where": { "code": roomCode }
        });
        if (!room) {
            res.status(404).json({ "error": "Room not found" });
            return;
        }

        if (!req.file) {
            res.status(400).json({ "error": "No image uploaded" });
            return;
        }

        await redis.setEx(`live:${roomCode}`, 10, req.file.buffer.toString("base64"));

        broadcast(res, roomCode, "live_update", {
            "type": "live_update",
            "timestamp": new Date().toISOString()
        });

        res.status(204).send();
    } catch (err) {
        logger.error("POST /api/rooms/:code/live error", err);
        res.status(500).json({ "error": "Failed to upload live image" });
    }
});

router.get("/:code/live", async (req: Request, res: Response) => {
    try {
        const roomCode = req.params.code as string;
        const room = await prisma.room.findUnique({
            "where": { "code": roomCode }
        });
        if (!room) {
            res.status(404).json({ "error": "Room not found" });
            return;
        }

        const base64 = await redis.get(`live:${roomCode}`);
        if (!base64) {
            res.status(404).json({ "error": "No live image available" });
            return;
        }

        const buffer = Buffer.from(base64, "base64");
        res.setHeader("Content-Type", "image/heic");
        res.send(buffer);
    } catch (err) {
        logger.error("GET /api/rooms/:code/live error", err);
        res.status(500).json({ "error": "Failed to get live image" });
    }
});

router.get("/:code/images", async (req: Request, res: Response) => {
    try {
        const roomCode = req.params.code as string;
        const room = await prisma.room.findUnique({
            "where": { "code": roomCode }
        });
        if (!room) {
            res.status(404).json({ "error": "Room not found" });
            return;
        }

        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
        const skip = (page - 1) * limit;

        const [images, total] = await Promise.all([
            prisma.image.findMany({
                "where": { "roomId": room.id },
                "orderBy": { "createdAt": "desc" },
                skip,
                "take": limit
            }),
            prisma.image.count({
                "where": { "roomId": room.id }
            })
        ]);

        res.json({
            "data": images,
            "pagination": {
                page,
                limit,
                total,
                "totalPages": Math.ceil(total / limit)
            }
        });
    } catch (err) {
        logger.error("GET /api/rooms/:code/images error", err);
        res.status(500).json({ "error": "Failed to list images" });
    }
});

router.get("/:code/images/:id", async (req: Request, res: Response) => {
    try {
        const roomCode = req.params.code as string;
        const room = await prisma.room.findUnique({
            "where": { "code": roomCode }
        });
        if (!room) {
            res.status(404).json({ "error": "Room not found" });
            return;
        }

        const image = await prisma.image.findFirst({
            "where": {
                "id": req.params.id as string,
                "roomId": room.id
            }
        });
        if (!image) {
            res.status(404).json({ "error": "Image not found" });
            return;
        }

        if (!fs.existsSync(image.path)) {
            res.status(404).json({ "error": "Image file not found" });
            return;
        }

        const format = req.query.format;
        const width = req.query.width ? Number(req.query.width) : undefined;
        const height = req.query.height ? Number(req.query.height) : undefined;
        if (format === "jpeg" || width || height) {
            try {
                let pipeline = sharp(image.path, { "failOn": "none" });
                if (width || height) {
                    pipeline = pipeline.resize(width, height, { "fit": "inside", "withoutEnlargement": true });
                }
                pipeline = pipeline.jpeg();
                const converted = await pipeline.toBuffer();
                res.setHeader("Content-Type", "image/jpeg");
                res.send(converted);
                return;
            } catch {
                // HEIF/HEIC not supported by this sharp build, fall through to serve original
            }
        }

        res.setHeader("Content-Type", "image/heic");
        res.sendFile(image.path);
    } catch (err) {
        logger.error("GET /api/rooms/:code/images/:id error", err);
        res.status(500).json({ "error": "Failed to get image" });
    }
});

router.get("/:code/download", async (req: Request, res: Response) => {
    try {
        const roomCode = req.params.code as string;
        const room = await prisma.room.findUnique({
            "where": { "code": roomCode }
        });
        if (!room) {
            res.status(404).json({ "error": "Room not found" });
            return;
        }

        const images = await prisma.image.findMany({
            "where": { "roomId": room.id },
            "orderBy": { "createdAt": "asc" }
        });

        if (images.length === 0) {
            res.status(404).json({ "error": "No images in room" });
            return;
        }

        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="${roomCode}.zip"`);

        const zipfile = new yazl.ZipFile();
        zipfile.outputStream.pipe(res);

        let addedCount = 0;
        for (const image of images) {
            if (!fs.existsSync(image.path)) continue;
            try {
                const data = await fs.promises.readFile(image.path);
                zipfile.addBuffer(data, `${image.id}.heic`);
                addedCount++;
            } catch (err) {
                logger.warn(`Failed to read image ${image.id}`, err);
            }
        }

        if (addedCount === 0) {
            // パイプ済みなのでレスポンスを強制終了
            zipfile.end();
            res.destroy();
            return;
        }

        zipfile.end();
    } catch (err) {
        logger.error("GET /api/rooms/:code/download error", err);
        if (!res.headersSent) {
            res.status(500).json({ "error": "Failed to download images" });
        }
    }
});

router.get("/:code/events", async (req: Request, res: Response) => {
    try {
        const roomCode = req.params.code as string;
        const room = await prisma.room.findUnique({
            "where": { "code": roomCode }
        });
        if (!room) {
            res.status(404).json({ "error": "Room not found" });
            return;
        }

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();

        if (!sseConnections.has(roomCode)) {
            sseConnections.set(roomCode, new Set());
        }
        sseConnections.get(roomCode)!.add(res);

        res.write(`event: connected\ndata: ${JSON.stringify({ "type": "connected" })}\n\n`);

        const pingInterval = setInterval(() => {
            res.write(`event: ping\ndata: ${JSON.stringify({ "type": "ping" })}\n\n`);
        }, 30000);

        req.on("close", () => {
            clearInterval(pingInterval);
            const connections = sseConnections.get(roomCode);
            if (connections) {
                connections.delete(res);
                if (connections.size === 0) {
                    sseConnections.delete(roomCode);
                }
            }
        });
    } catch (err) {
        logger.error("GET /api/rooms/:code/events error", err);
        res.status(500).json({ "error": "Failed to connect SSE" });
    }
});

router.delete("/:code/images/:id", async (req: Request, res: Response) => {
    try {
        const roomCode = req.params.code as string;
        const room = await prisma.room.findUnique({
            "where": { "code": roomCode }
        });
        if (!room) {
            res.status(404).json({ "error": "Room not found" });
            return;
        }

        const image = await prisma.image.findFirst({
            "where": {
                "id": req.params.id as string,
                "roomId": room.id
            }
        });
        if (!image) {
            res.status(404).json({ "error": "Image not found" });
            return;
        }

        if (fs.existsSync(image.path)) {
            await fs.promises.unlink(image.path);
        }

        await prisma.image.delete({
            "where": { "id": image.id }
        });

        res.status(204).send();
    } catch (err) {
        logger.error("DELETE /api/rooms/:code/images/:id error", err);
        res.status(500).json({ "error": "Failed to delete image" });
    }
});

export default router;
