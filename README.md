# LUMI Relay Server

Servidor WebSocket para salas PvP de LUMI.

## Protocolo

- `create_room`: crea una sala y devuelve `room_created`.
- `join_room`: entra usando un codigo de sala y devuelve `room_joined`.
- `start_draft`: inicia draft para ambos jugadores.
- `draft_roster`, `draft_ban`, `draft_order`, `skill`, `guard`, `team_switch`: se reenvian al rival.

## Ejecutar localmente

Requiere Node.js 18 o superior.

```powershell
cd Server
npm start
```

URL local:

```text
ws://127.0.0.1:8787/ws
```

## Desplegar

En una plataforma tipo Render/Railway/Fly:

- Root directory: `Server`
- Build command: ninguno o `npm install`
- Start command: `npm start`
- Environment: `PORT` lo define la plataforma

La URL final se usara en el juego como:

```text
wss://TU-SERVIDOR/ws
```

## Probar desde itch.io

1. Sube el zip web mas reciente a itch.io.
2. Despliega este servidor y copia su URL publica.
3. En LUMI ONLINE, escribe la URL como `wss://TU-SERVIDOR/ws`.
4. Jugador 1: `Crear sala online`.
5. Jugador 2: escribe la misma URL, el codigo de sala y pulsa `Entrar sala`.
6. Jugador 1: pulsa `Iniciar PvP`.

Nota: itch.io aloja el cliente web, pero las salas PvP necesitan este servidor WebSocket.
