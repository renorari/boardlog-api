/*
    Cleanup job: delete images older than 365 days
*/

import cron from "node-cron";
import fs from "node:fs";

import { prisma } from "./db.ts";
import log from "./logger.ts";

const logger = log.getLogger();

export function startCleanupJob() {
    // Run every day at 3:00 AM
    cron.schedule("0 3 * * *", async () => {
        logger.info("Starting daily cleanup job");

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - 365);

        try {
            const oldImages = await prisma.image.findMany({
                "where": {
                    "createdAt": {
                        "lt": cutoffDate
                    }
                }
            });

            logger.info(`Found ${oldImages.length} images to delete`);

            for (const image of oldImages) {
                try {
                    if (fs.existsSync(image.path)) {
                        await fs.promises.unlink(image.path);
                        logger.debug(`Deleted file: ${image.path}`);
                    }
                } catch (err) {
                    logger.error(`Failed to delete file ${image.path}`, err);
                }
            }

            const result = await prisma.image.deleteMany({
                "where": {
                    "createdAt": {
                        "lt": cutoffDate
                    }
                }
            });

            logger.info(`Deleted ${result.count} old image records`);
        } catch (err) {
            logger.error("Cleanup job failed", err);
        }
    });

    logger.info("Cleanup job scheduled (daily at 3:00 AM)");
}
