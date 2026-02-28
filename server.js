const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname)); 

// وضعنا الأسئلة هنا مزودة بكلمتي (img و image) عشان تشتغل غصب على أي واجهة عندك!
let questionBank = [
  { 
      "type": "image", 
      "hint": "اختبار الصور", 
      "q": "هل تظهر هذه الصورة (جبال الألب) بشكل سليم الآن؟", 
      "img": "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=600&q=80", 
      "image": "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=600&q=80", 
      "options": ["نعم تظهر", "لا", "ربما", "شاشة سوداء"], 
      "a": "نعم تظهر" 
  },
  { 
      "type": "text", 
      "hint": "رياضة: كأس العالم", 
      "q": "من هو المنتخب الذي فاز بكأس العالم 2022؟", 
      "options": ["فرنسا", "الأرجنتين", "البرازيل", "المغرب"], 
      "a": "الأرجنتين" 
  }
];

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

    socket.on('submitAnswer', (data) => {
        const room = roomsData[socket.currentRoom];
        if(!room) return;
        
        if (data.answer === "TIMEOUT") {
            room.teams[data.team].points -= 30;
            if (!room.turnTaken) {
                room.turnTaken = true;
                const wrong = room.currentQuestion.options.filter(o => o !== room.currentQuestion.a);
                const newOptions = [room.currentQuestion.a, wrong[0], wrong[1]].sort(() => Math.random() - 0.5);
                io.to(socket.currentRoom).emit('passTurn', { toTeam: data.team === 'A' ? 'B' : 'A', newOptions, points: room.teams[data.team].points });
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











