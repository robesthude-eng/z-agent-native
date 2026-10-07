# Хостовые помощники

`z-agent-host-status` раз в минуту пишет `host-status.json` в том данных
приложения: контейнеры, диск хоста, последний бэкап. Его читает раздел
«Сервер» в настройках (`GET /api/system/status`, только администратор).

```sh
install -m 755 deploy/host/z-agent-host-status /usr/local/bin/
install -m 644 deploy/host/z-agent-host-status.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now z-agent-host-status.timer
```

Скрипт бэкапа `z-agent-backup` (restic поверх rclone → Google Drive; конфигурация в
`/etc/z-agent-backup.env`) делает снимок базы через `server/backup.mjs`, проверяет его
`server/restore-verify.mjs` и по успеху пишет `/var/lib/z-agent/backup-last.json`
(`finishedAt`, `verify`, `size`, `snapshots`) — отсюда «последний успешный бэкап».

Имя проекта Compose и контейнера по умолчанию — `z-agent-native-main` (так называется каталог
с исходниками). Если ваш каталог называется иначе, задайте `Z_AGENT_COMPOSE_PROJECT` для
`z-agent-host-status` (путь файла статуса можно переопределить `Z_AGENT_HOST_STATUS_FILE`);
в `z-agent-backup` имя контейнера (`C=`) и путь тома (`WS=`) прописаны в самом скрипте и правятся вручную.
