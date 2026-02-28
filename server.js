const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname)); 

let questionBank = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
let roomsData = {};

io.on('connection', (socket) => {
    socket.on('joinRoom', (data) => {
        const { roomID, name, team } = data;
        socket.join(roomID);
        socket.currentRoom = roomID;
        if (!roomsData[roomID]) {
            roomsData[roomID] = { 
                teams: { 'أ': { points: 100, combo: 0 }, 'ب': { points: 100, combo: 0 } }, 
                adminID: socket.id, 
                frozenTeam: null 
            };
        }
        socket.emit('init', { pointsA: roomsData[roomID].teams['أ'].points, pointsB: roomsData[roomID].teams['ب'].points, isAdmin: socket.id === roomsData[roomID].adminID });
    });

    socket.on('requestAuction', (data) => {
        const room = roomsData[socket.currentRoom];
        const q = questionBank[Math.floor(Math.random() * questionBank.length)];
        // فرصة 20% لظهور بطاقة قوة مع السؤال
        const powerUp = Math.random() > 0.8 ? (Math.random() > 0.5 ? 'steal' : 'freeze') : null;
        io.to(socket.currentRoom).emit('startAuction', { hint: q.hint, fullQuestion: q, level: data.level, powerUp });
    });

    socket.on('placeBid', (data) => {
        const room = roomsData[socket.currentRoom];
        if (room.frozenTeam === data.team) return socket.emit('notification', 'فريقك مجمد حالياً! ❄️');
        io.to(socket.currentRoom).emit('updateBid', data);
    });

    socket.on('usePowerUp', (data) => {
        const room = roomsData[socket.currentRoom];
        if (data.type === 'steal') {
            const victim = data.team === 'أ' ? 'ب' : 'أ';
            room.teams[victim].points -= 20;
            room.teams[data.team].points += 20;
        } else if (data.type === 'freeze') {
            room.frozenTeam = data.team === 'أ' ? 'ب' : 'أ';
            setTimeout(() => { room.frozenTeam = null; }, 10000); // إذابة الثلج بعد 10 ثوانٍ
        }
        io.to(socket.currentRoom).emit('updateScores', { pointsA: room.teams['أ'].points, pointsB: room.teams['ب'].points });
    });

    socket.on('submitAnswer', (data) => {
        const room = roomsData[socket.currentRoom];
        const isCorrect = data.answer === data.correct;
        const teamData = room.teams[data.team];
        
        if (isCorrect) {
            teamData.combo++;
            let gain = 50 + (teamData.combo >= 3 ? 20 : 0); // مكافأة الكومبو
            teamData.points += gain;
        } else {
            teamData.combo = 0;
            teamData.points -= 30;
        }
        io.to(socket.currentRoom).emit('roundResult', { isCorrect, team: data.team, points: teamData.points, combo: teamData.combo });
    });

    socket.on('winAuction', (data) => io.to(socket.currentRoom).emit('revealQuestion', data));
});

server.listen(process.env.PORT || 3000);

