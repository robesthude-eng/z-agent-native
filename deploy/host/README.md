# Хостовые помощники

`z-agent-host-status` раз в минуту пишет `host-status.json` в том данных
приложения: контейнеры, диск хоста, последний бэкап. Его читает раздел
«Сервер» в настройках (`GET /api/system/status`, только администратор).

```sh
install -m 755 deploy/host/z-agent-host-status /usr/local/bin/
install -m 644 deploy/host/z-agent-host-status.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now z-agent-host-status.timer
```

Скрипт бэкапа по успеху пишет `/var/lib/z-agent/backup-last.json`
(`finishedAt`, `verify`, `size`) — отсюда «последний успешный бэкап».
