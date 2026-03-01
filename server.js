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
    console.log(`✅ تم تحميل ${questionBank.length} سؤال بنجاح!`);
} catch (e) {
    console.error("🚨 خطأ في ملف الأسئلة: ", e.message); 
    questionBank = [{
        "type": "text", "hint": "تنبيه للقائد", "q": "يوجد خطأ في ملف الأسئلة، يرجى مراجعته.", "options": ["علم", "جاري التصحيح", "حسناً", "تم"], "a": "علم"
    }];
}

let roomsData = {};

io.on('connection', (socket) => {
    socket.on('joinRoom', (data) => {
        const { roomID, settings, team } = data;
        socket.join(roomID);
        socket.currentRoom = roomID;

        if (!roomsData[roomID]) {
            roomsData[roomID] = {
                teams: { 'A': { points: 100, leader: socket.id }, 'B': { points: 100, leader: null } },
                settings: settings || { roundTime: 30, maxRounds: 10 },
                currentQuestion: null, 
                currentRound: 0,
                turnTaken: false
            };
        } else if (team && !roomsData[roomID].teams[team].leader) {
            roomsData[roomID].teams[team].leader = socket.id;
        }

        const room = roomsData[roomID];
        socket.emit('init', { 
            pointsA: room.teams['A'].points, 
            pointsB: room.teams['B'].points, 
            isLeader: socket.id === room.teams['A'].leader || socket.id === room.teams['B'].leader, 
            settings: room.settings 
        });
    });

    // 1. بدء جولة جديدة (تزيد رقم الجولة)
    socket.on('requestAuction', () => {
        const room = roomsData[socket.currentRoom];
        if(!room || questionBank.length === 0) return;

        room.currentRound++;
        if (room.currentRound > room.settings.maxRounds) {
            return io.to(socket.currentRoom).emit('gameOver', { pointsA: room.teams['A'].points, pointsB: room.teams['B'].points });
        }

        const q = questionBank[Math.floor(Math.random() * questionBank.length)];
        room.currentQuestion = q; 
        room.turnTaken = false;
        io.to(socket.currentRoom).emit('startAuction', { hint: q.hint, fullQuestion: q, roundNumber: room.currentRound });
    });

    // 2. تغيير السؤال (لا تزيد رقم الجولة)
    socket.on('changeQuestion', () => {
        const room = roomsData[socket.currentRoom];
        if(!room || questionBank.length === 0) return;

        const q = questionBank[Math.floor(Math.random() * questionBank.length)];
        room.currentQuestion = q; 
        room.turnTaken = false;
        io.to(socket.currentRoom).emit('startAuction', { hint: q.hint, fullQuestion: q, roundNumber: room.currentRound });
    });

    socket.on('submitAnswer', (data) => {
        const room = roomsData[socket.currentRoom];
        if(!room) return;
        
        // 3. معالجة انتهاء الوقت بشكل صحيح
        if (data.answer === "TIMEOUT") {
            room.teams[data.team].points -= 30;
            if (!room.turnTaken) {
                room.turnTaken = true;
                const wrong = room.currentQuestion.options.filter(o => o !== room.currentQuestion.a);
                const newOptions = [room.currentQuestion.a, wrong[0], wrong[1]].sort(() => Math.random() - 0.5);
                io.to(socket.currentRoom).emit('passTurn', { toTeam: data.team === 'A' ? 'B' : 'A', newOptions, points: room.teams[data.team].points, isTimeout: true });
            } else {
                io.to(socket.currentRoom).emit('roundResult', { isCorrect: false, team: data.team, points: room.teams[data.team].points, correctAns: room.currentQuestion.a, isTimeout: true });
            }
            return;
        }

        const isCorrect = data.answer === room.currentQuestion.a;
        if (isCorrect) {
            room.teams[data.team].points += 50;
            io.to(socket.currentRoom).emit('roundResult', { isCorrect: true, team: data.team, points: room.teams[data.team].points, name: data.name, correctAns: room.currentQuestion.a });
        } else {
            room.teams[data.team].points -= 30;
            if (!room.turnTaken) {
                room.turnTaken = true;
                const wrong = room.currentQuestion.options.filter(o => o !== room.currentQuestion.a);
                const newOptions = [room.currentQuestion.a, wrong[0], wrong[1]].sort(() => Math.random() - 0.5);
                io.to(socket.currentRoom).emit('passTurn', { toTeam: data.team === 'A' ? 'B' : 'A', newOptions, points: room.teams[data.team].points });
            } else {
                io.to(socket.currentRoom).emit('roundResult', { isCorrect: false, team: data.team, points: room.teams[data.team].points, name: data.name, correctAns: room.currentQuestion.a });
            }
        }
    });

    socket.on('placeBid', (d) => io.to(socket.currentRoom).emit('updateBid', d));
    socket.on('winAuction', (d) => io.to(socket.currentRoom).emit('revealQuestion', d));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('🚀 Server running on port ' + PORT));

















