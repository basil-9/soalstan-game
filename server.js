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

// نظام الحماية
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
        
        // 🚀 تنظيف: خروج من الغرف السابقة إن وجدت
        if(socket.currentRoom && socket.currentRoom !== roomID) {
            socket.leave(socket.currentRoom);
        }

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
        
        // تعيين القادة للغرفة المحددة
        if (team && !roomsData[roomID].teams[team].leader) {
            roomsData[roomID].teams[team].leader = socket.id;
        }

        const room = roomsData[roomID];
        const isLeader = (socket.id === room.teams[team].leader);

        // إرسال الإشارة لنفس اللاعب اللي دخل
        socket.emit('init', { 
            pointsA: room.teams['A'].points, 
            pointsB: room.teams['B'].points, 
            teamAName: room.teams['A'].name,
            teamBName: room.teams['B'].name,
            isLeader: isLeader, 
            settings: room.settings 
        });
        
        // تحديث النقاط لكل من في الغرفة
        io.to(roomID).emit('updateScores', { pointsA: room.teams['A'].points, pointsB: room.teams['B'].points });
    });

    // طلب جولة جديدة
    socket.on('requestAuction', () => {
        const rID = socket.currentRoom;
        const room = roomsData[rID];
        if(!room || questionBank.length === 0) return;

        room.currentRound++;
        if (room.currentRound > room.settings.maxRounds) {
            return io.to(rID).emit('gameOver', { pointsA: room.teams['A'].points, pointsB: room.teams['B'].points });
        }

        const q = questionBank[Math.floor(Math.random() * questionBank.length)];
        room.currentQuestion = q; 
        room.turnTaken = false;
        room.firstTeam = null;
        
        // 🚀 الإرسال للغرفة المحددة فقط
        io.to(rID).emit('startAuction', { hint: q.hint, fullQuestion: q, roundNumber: room.currentRound });
    });

    // تغيير السؤال
    socket.on('changeQuestion', () => {
        const rID = socket.currentRoom;
        const room = roomsData[rID];
        if(!room || questionBank.length === 0) return;

        const q = questionBank[Math.floor(Math.random() * questionBank.length)];
        room.currentQuestion = q; 
        room.turnTaken = false;
        room.firstTeam = null;
        
        // 🚀 الإرسال للغرفة المحددة فقط
        io.to(rID).emit('startAuction', { hint: q.hint, fullQuestion: q, roundNumber: room.currentRound });
    });

    socket.on('submitAnswer', (data) => {
        const rID = socket.currentRoom;
        const room = roomsData[rID];
        if(!room || !room.currentQuestion) return;
        
        if (room.turnTaken && data.team === room.firstTeam) return;

        if (data.answer === "TIMEOUT") {
            room.teams[data.team].points -= 30;
            if (!room.turnTaken) {
                room.turnTaken = true;
                room.firstTeam = data.team;
                const wrong = room.currentQuestion.options.filter(o => o !== room.currentQuestion.a);
                const newOptions = [room.currentQuestion.a, wrong[0], wrong[1]].sort(() => Math.random() - 0.5);
                io.to(rID).emit('passTurn', { toTeam: data.team === 'A' ? 'B' : 'A', newOptions, points: room.teams[data.team].points, isTimeout: true });
            } else {
                const correctAns = room.currentQuestion.a;
                room.currentQuestion = null;
                io.to(rID).emit('roundResult', { isCorrect: false, team: data.team, points: room.teams[data.team].points, name: data.name, correctAns: correctAns, isTimeout: true });
            }
            io.to(rID).emit('updateScores', { pointsA: room.teams['A'].points, pointsB: room.teams['B'].points });
            return;
        }

        const isCorrect = data.answer === room.currentQuestion.a;
        if (isCorrect) {
            room.teams[data.team].points += 50;
            const correctAns = room.currentQuestion.a;
            room.currentQuestion = null;
            io.to(rID).emit('roundResult', { isCorrect: true, team: data.team, points: room.teams[data.team].points, name: data.name, correctAns: correctAns });
        } else {
            room.teams[data.team].points -= 30;
            if (!room.turnTaken) {
                room.turnTaken = true;
                room.firstTeam = data.team;
                const wrong = room.currentQuestion.options.filter(o => o !== room.currentQuestion.a);
                const newOptions = [room.currentQuestion.a, wrong[0], wrong[1]].sort(() => Math.random() - 0.5);
                io.to(rID).emit('passTurn', { toTeam: data.team === 'A' ? 'B' : 'A', newOptions, points: room.teams[data.team].points });
            } else {
                const correctAns = room.currentQuestion.a;
                room.currentQuestion = null;
                io.to(rID).emit('roundResult', { isCorrect: false, team: data.team, points: room.teams[data.team].points, name: data.name, correctAns: correctAns });
            }
        }
        io.to(rID).emit('updateScores', { pointsA: room.teams['A'].points, pointsB: room.teams['B'].points });
    });

    socket.on('placeBid', (d) => io.to(socket.currentRoom).emit('updateBid', d));
    socket.on('winAuction', (d) => io.to(socket.currentRoom).emit('revealQuestion', d));
    
    // الخروج من الغرفة
    socket.on('leaveRoom', () => {
        if(socket.currentRoom) {
            socket.leave(socket.currentRoom);
            socket.currentRoom = null;
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('🚀 Server running on port ' + PORT));






















