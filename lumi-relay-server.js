const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8787);
const ROOM_TTL_MS = 1000 * 60 * 60 * 2;
const rooms = new Map();
const clients = new Set();

let nextClientId = 1;

const relayTypes = new Set([
  "draft_roster",
  "draft_ban",
  "draft_order",
  "skill",
  "guard",
  "team_switch",
]);

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    const body = JSON.stringify({
      ok: true,
      service: "lumi-relay",
      rooms: rooms.size,
      clients: clients.size,
    });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    });
    res.end(body);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("LUMI relay server. Connect WebSocket clients to /ws.");
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n")
  );

  const client = {
    id: nextClientId++,
    socket,
    buffer: Buffer.alloc(0),
    roomCode: "",
    side: -1,
    alive: true,
  };

  clients.add(client);
  socket.on("data", (chunk) => handleSocketData(client, chunk));
  socket.on("close", () => removeClient(client));
  socket.on("error", () => removeClient(client));
  send(client, { type: "server_ready" });
});

function handleSocketData(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);

  while (client.buffer.length >= 2) {
    const frame = readFrame(client.buffer);
    if (!frame) {
      return;
    }

    client.buffer = client.buffer.slice(frame.bytesRead);

    if (frame.opcode === 0x8) {
      client.socket.end();
      removeClient(client);
      return;
    }

    if (frame.opcode === 0x9) {
      writeFrame(client.socket, frame.payload, 0xA);
      continue;
    }

    if (frame.opcode !== 0x1) {
      continue;
    }

    let message;
    try {
      message = JSON.parse(frame.payload.toString("utf8"));
    } catch (_error) {
      send(client, { type: "error", message: "Mensaje JSON invalido." });
      continue;
    }

    handleMessage(client, message);
  }
}

function readFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }

  const byte1 = buffer[0];
  const byte2 = buffer[1];
  const opcode = byte1 & 0x0f;
  const masked = (byte2 & 0x80) !== 0;
  let length = byte2 & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    length = high * 2 ** 32 + low;
    offset += 8;
  }

  let mask;
  if (masked) {
    if (buffer.length < offset + 4) {
      return null;
    }
    mask = buffer.slice(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) {
    return null;
  }

  const payload = Buffer.from(buffer.slice(offset, offset + length));
  if (masked && mask) {
    for (let index = 0; index < payload.length; index++) {
      payload[index] ^= mask[index % 4];
    }
  }

  return {
    opcode,
    payload,
    bytesRead: offset + length,
  };
}

function writeFrame(socket, payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  let header;

  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(data.length, 6);
  }

  socket.write(Buffer.concat([header, data]));
}

function send(client, message) {
  if (!client || client.socket.destroyed) {
    return;
  }
  writeFrame(client.socket, JSON.stringify(message));
}

function handleMessage(client, message) {
  const type = String(message.type || "");

  if (type === "create_room") {
    createRoom(client);
    return;
  }

  if (type === "join_room") {
    joinRoom(client, String(message.room_code || ""));
    return;
  }

  if (type === "start_draft") {
    const room = getClientRoom(client);
    if (!room) {
      send(client, { type: "error", message: "No estas en una sala." });
      return;
    }
    if (client.side !== 0) {
      send(client, { type: "error", message: "Solo el creador de la sala puede iniciar." });
      return;
    }
    if (!room.players[0] || !room.players[1]) {
      send(client, { type: "error", message: "Falta otro jugador." });
      return;
    }
    broadcast(room, { type: "start_draft" });
    return;
  }

  if (relayTypes.has(type)) {
    relayToOpponent(client, message);
    return;
  }

  send(client, { type: "error", message: `Tipo de mensaje no soportado: ${type}` });
}

function createRoom(client) {
  leaveRoom(client);
  const code = makeRoomCode();
  const room = {
    code,
    players: [client, null],
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  client.roomCode = code;
  client.side = 0;
  send(client, { type: "room_created", room_code: code, side: 0 });
}

function joinRoom(client, rawCode) {
  const code = normalizeRoomCode(rawCode);
  const room = rooms.get(code);
  if (!room) {
    send(client, { type: "error", message: "Sala no encontrada." });
    return;
  }
  if (room.players[1] && room.players[1] !== client) {
    send(client, { type: "error", message: "Sala llena." });
    return;
  }

  leaveRoom(client);
  room.players[1] = client;
  client.roomCode = code;
  client.side = 1;
  send(client, { type: "room_joined", room_code: code, side: 1 });
  broadcast(room, { type: "match_ready", room_code: code });
}

function relayToOpponent(client, message) {
  const room = getClientRoom(client);
  if (!room) {
    send(client, { type: "error", message: "No estas en una sala." });
    return;
  }
  const opponent = room.players[client.side === 0 ? 1 : 0];
  if (!opponent) {
    send(client, { type: "error", message: "Todavia no hay rival." });
    return;
  }
  send(opponent, {
    ...message,
    from_side: client.side,
  });
}

function broadcast(room, message) {
  for (const player of room.players) {
    if (player) {
      send(player, message);
    }
  }
}

function removeClient(client) {
  if (!clients.has(client)) {
    return;
  }
  clients.delete(client);
  leaveRoom(client);
}

function leaveRoom(client) {
  if (!client.roomCode) {
    client.side = -1;
    return;
  }

  const room = rooms.get(client.roomCode);
  if (room) {
    if (room.players[0] === client) {
      room.players[0] = null;
    }
    if (room.players[1] === client) {
      room.players[1] = null;
    }
    for (const player of room.players) {
      if (player) {
        send(player, { type: "peer_left" });
      }
    }
    if (!room.players[0] && !room.players[1]) {
      rooms.delete(room.code);
    }
  }

  client.roomCode = "";
  client.side = -1;
}

function getClientRoom(client) {
  if (!client.roomCode) {
    return null;
  }
  return rooms.get(client.roomCode) || null;
}

function makeRoomCode() {
  let code = "";
  do {
    code = crypto.randomBytes(3).toString("hex").slice(0, 4).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function normalizeRoomCode(code) {
  return String(code || "").replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 8);
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const hasPlayers = Boolean(room.players[0] || room.players[1]);
    if (!hasPlayers || now - room.createdAt > ROOM_TTL_MS) {
      broadcast(room, { type: "peer_left" });
      rooms.delete(code);
    }
  }
}, 60_000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[LUMI Relay] listening on port ${PORT}`);
  console.log(`[LUMI Relay] WebSocket path: /ws`);
});
