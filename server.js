const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname)); 

let questionBank = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
let roomsData = {};

io.on('connection', (socket) => {
    socket.on('joinRoom', (data) => {
        const { roomID, name, team } = data;
        socket.join(roomID);
        socket.currentRoom = roomID;
        if (!roomsData[roomID]) {
            roomsData[roomID] = { teams: { 'أ': { points: 100, leader: socket.id }, 'ب': { points: 100, leader: null } }, usedQuestions: [] };
        } else if (!roomsData[roomID].teams[team].leader) {
            roomsData[roomID].teams[team].leader = socket.id;
        }
        socket.emit('init', { pointsA: roomsData[roomID].teams['أ'].points, pointsB: roomsData[roomID].teams['ب'].points, isLeader: socket.id === roomsData[roomID].teams[team].leader });
    });

    socket.on('requestAuction', () => {
        const room = roomsData[socket.currentRoom];
        const q = questionBank[Math.floor(Math.random() * questionBank.length)];
        io.to(socket.currentRoom).emit('startAuction', { hint: q.hint, fullQuestion: q });
    });

    socket.on('submitAnswer', (data) => {
        const room = roomsData[socket.currentRoom];
        const isCorrect = data.answer === data.correct;
        if (isCorrect) room.teams[data.team].points += 50; else room.teams[data.team].points -= 30;
        io.to(socket.currentRoom).emit('roundResult', { isCorrect, team: data.team, points: room.teams[data.team].points, name: data.name, correctAns: data.correct });
    });

    socket.on('winAuction', (d) => io.to(socket.currentRoom).emit('revealQuestion', d));
    socket.on('placeBid', (d) => io.to(socket.currentRoom).emit('updateBid', d));
});
server.listen(process.env.PORT || 3000);




