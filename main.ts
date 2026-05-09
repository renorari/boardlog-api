/*
    API server
*/

import "dotenv/config";

import cors from "cors";
import express from "express";
import helmet from "helmet";

import log from "./utils/logger.ts";
import accessLogMiddleware from "./utils/middlewares/log.ts";
import roomsRouter from "./routes/rooms.ts";

const PORT = process.env.PORT || 3000;

const app = express();
const logger = log.getLogger();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ "extended": true }));
app.use(accessLogMiddleware(log.getLogger("access")));

app.use(express.static("public"));

app.use("/api/rooms", roomsRouter);

app.listen(PORT, () => {
    logger.log(`Server is running on http://localhost:${PORT}`);
});
