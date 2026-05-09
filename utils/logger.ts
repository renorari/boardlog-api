/*
    log4js configuration
*/

import log4js from "log4js";

const isProduction = process.env.NODE_ENV === "production";

log4js.configure({
    "appenders": {
        "console": { "type": "console" },
        "consoleInfo": {
            "type": "logLevelFilter",
            "appender": "console",
            "level": "info"
        },
        "appFile": {
            "type": "dateFile",
            "filename": "logs/app.log",
            "pattern": "yyyy-MM-dd",
            "keepFileExt": true,
            "numBackups": 1826,
            "compress": true,
            "alwaysIncludePattern": false
        },
        "appFileInfo": {
            "type": "logLevelFilter",
            "appender": "appFile",
            "level": "info"
        },
        "accessFile": {
            "type": "dateFile",
            "filename": "logs/access.log",
            "pattern": "yyyy-MM-dd",
            "keepFileExt": true,
            "numBackups": 1826,
            "compress": true,
            "alwaysIncludePattern": false
        }
    },
    "categories": {
        "default": {
            "appenders": isProduction ? ["consoleInfo", "appFileInfo"]: ["console"],
            "level": "debug"
        },
        "access": {
            "appenders": ["console", "accessFile"],
            "level": "info"
        }
    }
});

const log = log4js;

export default log;
