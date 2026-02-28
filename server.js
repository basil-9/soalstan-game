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
            roomsData[roomID] = { teams: { 'أ': { points: 100 }, 'ب': { points: 100 } }, usedQuestions: [], adminID: socket.id, timer: null };
        }
        socket.emit('init', { pointsA: roomsData[roomID].teams['أ'].points, pointsB: roomsData[roomID].teams['ب'].points, isAdmin: socket.id === roomsData[roomID].adminID });
    });

    socket.on('requestAuction', (data) => {
        const roomID = socket.currentRoom;
        const available = questionBank.filter(q => !roomsData[roomID].usedQuestions.includes(q.q));
        const q = available.length > 0 ? available[Math.floor(Math.random() * available.length)] : questionBank[0];
        roomsData[roomID].usedQuestions.push(q.q);
        io.to(roomID).emit('startAuction', { hint: q.hint, fullQuestion: q, level: data.level });
    });

    socket.on('winAuction', (data) => {
        const roomID = socket.currentRoom;
        let timeLeft = data.level === 'easy' ? 25 : (data.level === 'hard' ? 12 : 18);
        io.to(roomID).emit('revealQuestion', { question: data.question, duration: timeLeft });
        clearInterval(roomsData[roomID].timer);
        roomsData[roomID].timer = setInterval(() => {
            timeLeft--;
            io.to(roomID).emit('timerUpdate', timeLeft);
            if (timeLeft <= 0) {
                clearInterval(roomsData[roomID].timer);
                io.to(roomID).emit('roundResult', { playerName: "انتهى الوقت", isCorrect: false, team: 'أ', points: roomsData[roomID].teams['أ'].points });
            }
        }, 1000);
    });

    socket.on('submitAnswer', (data) => {
        const roomID = socket.currentRoom;
        clearInterval(roomsData[roomID].timer);
        const isCorrect = data.answer === data.correct;
        roomsData[roomID].teams[data.team].points += isCorrect ? 50 : -30;
        io.to(roomID).emit('roundResult', { playerName: data.name, isCorrect, team: data.team, points: roomsData[roomID].teams[data.team].points });
    });

    socket.on('placeBid', (data) => io.to(socket.currentRoom).emit('updateBid', data));
});

server.listen(process.env.PORT || 3000);
