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

// نظام الحماية: يقرأ الأسئلة بدون ما يطيح السيرفر لو فيه خطأ
try {
    const data = fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8');
    questionBank = JSON.parse(data);
    console.log(`✅ تم تحميل ${questionBank.length} سؤال بنجاح!`);
} catch (e) {
    console.error("❌ خطأ في ملف questions.json! تأكد من الفواصل والأقواس:", e.message);
    questionBank = [{
        "type": "text", "hint": "تنبيه للقائد", "q": "يوجد خطأ (فاصلة أو قوس) في ملف questions.json، يرجى إصلاحه!", "options": ["حسناً", "جاري التعديل", "تم", "علم"], "a": "حسناً"
    }];
}

let roomsData = {};

io.on('connection', (socket) => {
    socket.on('joinRoom', (data) => {
        const { roomID, settings, team, teamAName, teamBName } = data;
        socket.join(roomID);
        socket.currentRoom = roomID;

        // إنشاء الغرفة وتعيين أسماء الفرق
        if (!roomsData[roomID]) {
            roomsData[roomID] = {
                teams: { 
                    'A': { points: 100, leader: null, name: teamAName || "فريق A" }, 
                    'B': { points: 100, leader: null, name: teamBName || "فريق B" } 
                },
                settings: settings || { roundTime: 30, maxRounds: 10 },
                currentQuestion: null, 
                currentRound: 0,
                turnTaken: false,
                firstTeam: null
            };
        }
        
        // حل مشكلة القادة: أول شخص يدخل الفريق يصير قائده (مفصولين عن بعض)
        if (team && !roomsData[roomID].teams[team].leader) {
            roomsData[roomID].teams[team].leader = socket.id;
        }

        const room = roomsData[roomID];
        // تحديد هل هذا اللاعب هو القائد لفريقه أم لا
        const isLeader = (socket.id === room.teams[team].leader);

        socket.emit('init', { 
            pointsA: room.teams['A'].points, 
            pointsB: room.teams['B'].points, 
            teamAName: room.teams['A'].name,
            teamBName: room.teams['B'].name,
            isLeader: isLeader, 
            settings: room.settings 
        });
    });

    // 1. طلب جولة جديدة (تزيد الجولة)
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
        room.firstTeam = null;
        io.to(socket.currentRoom).emit('startAuction', { hint: q.hint, fullQuestion: q, roundNumber: room.currentRound });
    });

    // 2. تغيير السؤال (لا تزيد الجولة)
    socket.on('changeQuestion', () => {
        const room = roomsData[socket.currentRoom];
        if(!room || questionBank.length === 0) return;

        const q = questionBank[Math.floor(Math.random() * questionBank.length)];
        room.currentQuestion = q; 
        room.turnTaken = false;
        room.firstTeam = null;
        io.to(socket.currentRoom).emit('startAuction', { hint: q.hint, fullQuestion: q, roundNumber: room.currentRound });
    });

    socket.on('submitAnswer', (data) => {
        const room = roomsData[socket.currentRoom];
        if(!room || !room.currentQuestion) return;
        
        // منع الفريق من الإجابة مرتين
        if (room.turnTaken && data.team === room.firstTeam) return;

        // 3. معالجة انتهاء الوقت (ترجع الخيارات للفريق الخصم)
        if (data.answer === "TIMEOUT") {
            room.teams[data.team].points -= 30;
            if (!room.turnTaken) {
                room.turnTaken = true;
                room.firstTeam = data.team;
                const wrong = room.currentQuestion.options.filter(o => o !== room.currentQuestion.a);
                const newOptions = [room.currentQuestion.a, wrong[0], wrong[1]].sort(() => Math.random() - 0.5);
                io.to(socket.currentRoom).emit('passTurn', { toTeam: data.team === 'A' ? 'B' : 'A', newOptions, points: room.teams[data.team].points, isTimeout: true });
            } else {
                const correctAns = room.currentQuestion.a;
                room.currentQuestion = null;
                io.to(socket.currentRoom).emit('roundResult', { isCorrect: false, team: data.team, points: room.teams[data.team].points, name: data.name, correctAns: correctAns, isTimeout: true });
            }
            return;
        }

        const isCorrect = data.answer === room.currentQuestion.a;
        if (isCorrect) {
            room.teams[data.team].points += 50;
            const correctAns = room.currentQuestion.a;
            room.currentQuestion = null;
            io.to(socket.currentRoom).emit('roundResult', { isCorrect: true, team: data.team, points: room.teams[data.team].points, name: data.name, correctAns: correctAns });
        } else {
            room.teams[data.team].points -= 30;
            if (!room.turnTaken) {
                room.turnTaken = true;
                room.firstTeam = data.team;
                const wrong = room.currentQuestion.options.filter(o => o !== room.currentQuestion.a);
                const newOptions = [room.currentQuestion.a, wrong[0], wrong[1]].sort(() => Math.random() - 0.5);
                io.to(socket.currentRoom).emit('passTurn', { toTeam: data.team === 'A' ? 'B' : 'A', newOptions, points: room.teams[data.team].points });
            } else {
                const correctAns = room.currentQuestion.a;
                room.currentQuestion = null;
                io.to(socket.currentRoom).emit('roundResult', { isCorrect: false, team: data.team, points: room.teams[data.team].points, name: data.name, correctAns: correctAns });
            }
        }
    });

    socket.on('placeBid', (d) => io.to(socket.currentRoom).emit('updateBid', d));
    socket.on('winAuction', (d) => io.to(socket.currentRoom).emit('revealQuestion', d));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('🚀 Server running on port ' + PORT));





















