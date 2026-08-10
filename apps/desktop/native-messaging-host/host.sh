#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "/home/artefaktor/Рабочий стол/Repositories/steam-client/node_modules/.pnpm/electron@41.2.0/node_modules/electron/dist/electron" "/home/artefaktor/Рабочий стол/Repositories/steam-client/apps/desktop/native-messaging-host/host.js" "$@"
