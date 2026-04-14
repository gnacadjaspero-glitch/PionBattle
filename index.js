const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// --- ÉTAT DU SERVEUR ---
const rooms = new Map();
const ROOM_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// Servir les fichiers statiques (Flutter Web)
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- LOGIQUE DES ROOMS ---

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
        code = '';
        for (let i = 0; i < 5; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
    } while (rooms.has(code));
    return code;
}

function updateRoomActivity(roomCode) {
    const room = rooms.get(roomCode);
    if (room) {
        room.lastActivity = Date.now();
    }
}

io.on('connection', (socket) => {
    console.log(`🔌 Nouveau client : ${socket.id}`);

    // Créer une room
    socket.on('createRoom', (data) => {
        const roomCode = generateRoomCode();
        const room = {
            players: [{
                socketId: socket.id,
                playerId: data.playerId,
                pseudo: data.pseudo || "Joueur 1",
                pawn: data.pawn || 'A',
                connected: true
            }],
            gridSize: data.gridSize || 3,
            totalMatches: data.totalMatches || 3,
            status: "waiting",
            lastActivity: Date.now()
        };

        rooms.set(roomCode, room);
        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.playerId = data.playerId;

        socket.emit('roomCreated', {
            roomCode,
            gridSize: room.gridSize,
            totalMatches: room.totalMatches,
            assignedPawn: room.players[0].pawn
        });
        console.log(`🏠 Room créée : ${roomCode}`);
    });

    // Rejoindre une room
    socket.on('joinRoom', (data) => {
        const { roomCode, pseudo, playerId } = data;
        const room = rooms.get(roomCode);

        if (!room) {
            return socket.emit('errorMsg', 'Salon inexistant');
        }
        if (room.players.length >= 2) {
            return socket.emit('errorMsg', 'Salon plein');
        }

        const hostPawn = room.players[0].pawn;
        const assignedPawn = hostPawn === 'A' ? 'B' : 'A';

        const newPlayer = {
            socketId: socket.id,
            playerId: playerId,
            pseudo: pseudo || "Joueur 2",
            pawn: assignedPawn,
            connected: true
        };

        room.players.push(newPlayer);
        room.status = "playing";
        room.lastActivity = Date.now();

        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.playerId = playerId;

        // Notifier tout le monde dans la room
        io.to(roomCode).emit('playerJoined', {
            gridSize: room.gridSize,
            totalMatches: room.totalMatches,
            players: room.players.map(p => ({ pseudo: p.pseudo, pawn: p.pawn })),
            status: room.status
        });

        // Envoyer le pion assigné spécifiquement au nouvel arrivant
        socket.emit('assignPawn', { assignedPawn });

        console.log(`🤝 ${pseudo} a rejoint ${roomCode}`);
    });

    // Reconnexion
    socket.on('rejoinRoom', (data) => {
        const { roomCode, playerId } = data;
        const room = rooms.get(roomCode);

        if (room) {
            const player = room.players.find(p => p.playerId === playerId);
            if (player) {
                player.socketId = socket.id;
                player.connected = true;
                socket.join(roomCode);
                socket.roomCode = roomCode;
                socket.playerId = playerId;

                socket.emit('reconnected', {
                    gridSize: room.gridSize,
                    totalMatches: room.totalMatches,
                    players: room.players.map(p => ({ pseudo: p.pseudo, pawn: p.pawn, connected: p.connected })),
                    assignedPawn: player.pawn,
                    status: room.status
                });

                socket.to(roomCode).emit('playerReconnected', { pseudo: player.pseudo });
                console.log(`♻️ Reconnexion : ${player.pseudo} dans ${roomCode}`);
            }
        }
    });

    // Action de jeu
    socket.on('playMove', (data) => {
        const { roomCode, action } = data;
        const room = rooms.get(roomCode);
        if (room) {
            updateRoomActivity(roomCode);
            // On diffuse l'action aux autres joueurs de la room
            socket.to(roomCode).emit('gameUpdate', { action });
        }
    });

    // Reset du jeu
    socket.on('resetGame', (roomCode) => {
        const room = rooms.get(roomCode);
        if (room) {
            updateRoomActivity(roomCode);
            io.to(roomCode).emit('gameReset');
        }
    });

    // Déconnexion
    socket.on('disconnect', () => {
        const roomCode = socket.roomCode;
        if (roomCode) {
            const room = rooms.get(roomCode);
            if (room) {
                const player = room.players.find(p => p.socketId === socket.id);
                if (player) {
                    player.connected = false;
                    socket.to(roomCode).emit('playerDisconnected', { pseudo: player.pseudo });
                    console.log(`⚠️ Déconnexion : ${player.pseudo} de ${roomCode}`);
                }
            }
        }
    });
});

// --- CLEANUP DES ROOMS INACTIVES ---
setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms.entries()) {
        const allDisconnected = room.players.every(p => !p.connected);
        const isExpired = (now - room.lastActivity) > ROOM_TIMEOUT;

        if (isExpired || (allDisconnected && (now - room.lastActivity) > 60000)) {
            console.log(`🗑️ Suppression room ${code} (inactivité)`);
            rooms.delete(code);
        }
    }
}, 60000);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`🚀 Serveur actif sur le port ${PORT}`);
});
