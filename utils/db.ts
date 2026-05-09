/*
    Prisma PostgreSQL adapter / Prisma Client setup / Redis client setup
*/

import "dotenv/config";

import { Pool } from "pg";
import { createClient } from "redis";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/prisma/client.ts";

const connectionString = `${process.env.DATABASE_URL}`;

const pool = new Pool({
    "connectionString": connectionString
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const redis = createClient({
    "url": process.env.REDIS_URL
});

redis.on("error", (err) => {
    console.error("Redis Client Error", err);
});

try {
    await redis.connect();
} catch (err) {
    console.error("Failed to connect to Redis", err);
    process.exit(1);
}

export { prisma, pool, redis };
