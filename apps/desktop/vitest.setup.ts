// Prevent electron-log from ever writing to disk during unit tests.
import log from 'electron-log/main.js';
log.transports.file.level = false;
log.transports.console.level = false;
