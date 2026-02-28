const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname)); 

let questionBank = [];
try {
    const data = fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8');
    questionBank = JSON.parse(data);
} catch (err) { console.error("❌ خطأ في تحميل الأسئلة"); }

let roomsData = {};

io.on('connection', (socket) => {
    socket.on('joinRoom', (data) => {
        const { roomID, name, team } = data;
        socket.join(roomID);
        socket.currentRoom = roomID;
        
        if (!roomsData[roomID]) {
            roomsData[roomID] = {
                teams: { 'أ': { points: 100, leader: socket.id }, 'ب': { points: 100, leader: null } },
                usedQuestions: [], isSuddenDeath: false
            };
        } else if (!roomsData[roomID].teams[team].leader) {
            roomsData[roomID].teams[team].leader = socket.id;
        }

        const room = roomsData[roomID];
        socket.emit('init', { 
            pointsA: room.teams['أ'].points, 
            pointsB: room.teams['ب'].points,
            isLeader: socket.id === room.teams[team].leader 
        });
    });

    socket.on('requestAuction', () => {
        const room = roomsData[socket.currentRoom];
        if (!room) return;
        const available = questionBank.filter(q => !room.usedQuestions.includes(q.q));
        const q = available.length > 0 ? available[Math.floor(Math.random() * available.length)] : questionBank[0];
        room.usedQuestions.push(q.q);
        io.to(socket.currentRoom).emit('startAuction', { hint: q.hint, fullQuestion: q });
    });

    socket.on('submitAnswer', (data) => {
        const room = roomsData[socket.currentRoom];
        const isCorrect = data.answer === data.correct;
        if (isCorrect) room.teams[data.team].points += 50;
        else room.teams[data.team].points -= 30;

        io.to(socket.currentRoom).emit('roundResult', { isCorrect, team: data.team, points: room.teams[data.team].points, name: data.name, correctAns: data.correct });
    });

    socket.on('winAuction', (d) => io.to(socket.currentRoom).emit('revealQuestion', d));
    socket.on('placeBid', (d) => io.to(socket.currentRoom).emit('updateBid', d));
});

server.listen(process.env.PORT || 3000);



