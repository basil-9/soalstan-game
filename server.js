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
        "type": "text", "hint": "تنبيه", "q": "يوجد خطأ في ملف الأسئلة.", "options": ["علم", "جاري التصحيح"], "a": "علم"
    }];
}

let roomsData = {};

// 1. بدء جولة جديدة (مرحلة التضليل)
function startNewRound(rID) {
    const room = roomsData[rID];
    if(!room || questionBank.length === 0) return;

    room.currentRound++;
    if (room.currentRound > room.settings.maxRounds) {
        io.to(rID).emit('gameOver', { players: room.players });
        delete roomsData[rID];
        return;
    }

    const q = questionBank[Math.floor(Math.random() * questionBank.length)];
    room.currentQuestion = q; 
    room.bluffs = {}; // لحفظ الإجابات المضللة
    room.votes = {};  // لحفظ التصويتات
    room.phase = 'bluffing'; 

    io.to(rID).emit('startBluffPhase', { fullQuestion: q, roundNumber: room.currentRound });
}

// 2. الانتقال لمرحلة التصويت (بعد ما الكل يكتب تضليله)
function startVotingPhase(rID, room) {
    room.phase = 'voting';
    let correctAns = room.currentQuestion.a;
    
    // جمع الإجابة الصحيحة مع كل التضليلات (مع منع التكرار)
    let allOptions = [correctAns];
    for (let pid in room.bluffs) {
        let b = room.bluffs[pid].trim();
        // إذا كتب إجابة صحيحة بالصدفة ما نكررها، أو لو اثنين كتبوا نفس التضليل
        if (b && !allOptions.includes(b)) {
            allOptions.push(b);
        }
    }

    // خلط الخيارات عشان ما ينعرف وين الصح
    allOptions.sort(() => Math.random() - 0.5);

    io.to(rID).emit('startVotingPhase', { options: allOptions });
}

// 3. تقييم الجولة (توزيع النقاط)
function evaluateRound(rID, room) {
    room.phase = 'results';
    let correctAns = room.currentQuestion.a;
    let results = {}; // لتسجيل من اختار ماذا ومن خدع من

    // تهيئة مصفوفة النتائج لكل لاعب
    for (let pid in room.players) {
        results[pid] = { name: room.players[pid].name, pointsGained: 0, votedFor: room.votes[pid], tricked: [] };
    }

    // حساب النقاط
    for (let voterId in room.votes) {
        let vote = room.votes[voterId];
        
        if (vote === correctAns) {
            // اللي يجاوب صح ياخذ نقطتين
            room.players[voterId].points += 2;
            results[voterId].pointsGained += 2;
        } else if (vote !== "TIMEOUT") {
            // دور مين صاحب هذي الإجابة المضللة عشان نعطيه نقطة
            for (let blufferId in room.bluffs) {
                if (blufferId !== voterId && room.bluffs[blufferId] === vote) {
                    room.players[blufferId].points += 1;
                    results[blufferId].pointsGained += 1;
                    results[blufferId].tricked.push(room.players[voterId].name); // حفظ اسم الضحية
                }
            }
        }
    }

    io.to(rID).emit('roundResult', { results: results, correctAns: correctAns });
    io.to(rID).emit('updateState', { players: room.players, leader: room.leader });
    room.currentQuestion = null;

    // انتقال تلقائي بعد 6 ثواني (عشان يقرأون مين خدع مين وتصير ضحك)
    setTimeout(() => { if (roomsData[rID] && !roomsData[rID].currentQuestion) startNewRound(rID); }, 6000);
}

io.on('connection', (socket) => {
    
    socket.on('joinRoom', (data) => {
        const { roomID, name, settings } = data;
        if (!roomID) return;

        if(socket.currentRoom) socket.leave(socket.currentRoom);
        socket.join(roomID);
        socket.currentRoom = roomID;

        if (!roomsData[roomID]) {
            let maxRnds = settings ? settings.maxRounds : 10;
            roomsData[roomID] = {
                players: {}, 
                leader: socket.id,
                settings: settings || { roundTime: 30, maxRounds: maxRnds },
                currentQuestion: null, 
                currentRound: 0,
                phase: 'idle',
                bluffs: {},
                votes: {}
            };
        }
        
        const room = roomsData[roomID];
        if (!room.leader || !room.players[room.leader]) room.leader = socket.id;

        // النقاط تبدأ من 0 في النظام الجديد
        room.players[socket.id] = { name: name || 'لاعب', points: 0 };
        io.to(roomID).emit('updateState', { players: room.players, leader: room.leader, settings: room.settings });
    });

    // القائد يضغط بدء اللعبة
    socket.on('requestGameStart', () => {
        const rID = socket.currentRoom;
        if (rID && roomsData[rID] && roomsData[rID].leader === socket.id) startNewRound(rID);
    });

    // استقبال الإجابة المضللة
    socket.on('submitBluff', (data) => {
        const rID = socket.currentRoom;
        const room = roomsData[rID];
        if(!room || room.phase !== 'bluffing') return;

        room.bluffs[socket.id] = data.bluff || "تأخر في الإجابة " + Math.floor(Math.random()*100);
        io.to(rID).emit('playerActed', { id: socket.id, action: 'bluffed' });

        if (Object.keys(room.bluffs).length === Object.keys(room.players).length) {
            startVotingPhase(rID, room);
        }
    });

    // التايم أوت لمرحلة التضليل
    socket.on('timeoutBluffAll', () => {
        const rID = socket.currentRoom;
        const room = roomsData[rID];
        if(!room || room.phase !== 'bluffing') return;

        for(let pid in room.players) {
            if (!room.bluffs[pid]) room.bluffs[pid] = "إجابة عشوائية " + Math.floor(Math.random()*1000);
        }
        startVotingPhase(rID, room);
    });

    // استقبال التصويت
    socket.on('submitVote', (data) => {
        const rID = socket.currentRoom;
        const room = roomsData[rID];
        if(!room || room.phase !== 'voting') return;

        room.votes[socket.id] = data.vote;
        io.to(rID).emit('playerActed', { id: socket.id, action: 'voted' });

        if (Object.keys(room.votes).length === Object.keys(room.players).length) {
            evaluateRound(rID, room);
        }
    });

    // التايم أوت لمرحلة التصويت
    socket.on('timeoutVoteAll', () => {
        const rID = socket.currentRoom;
        const room = roomsData[rID];
        if(!room || room.phase !== 'voting') return;

        for(let pid in room.players) {
            if (!room.votes[pid]) room.votes[pid] = "TIMEOUT";
        }
        evaluateRound(rID, room);
    });

    function handleLeave(sock) {
        const rID = sock.currentRoom;
        if(rID && roomsData[rID]) {
            delete roomsData[rID].players[sock.id];
            let remainingPlayers = Object.keys(roomsData[rID].players);
            if(remainingPlayers.length === 0) {
                delete roomsData[rID];
            } else {
                if(roomsData[rID].leader === sock.id) roomsData[rID].leader = remainingPlayers[0];
                io.to(rID).emit('updateState', { players: roomsData[rID].players, leader: roomsData[rID].leader });
            }
            sock.leave(rID);
            sock.currentRoom = null;
        }
    }

    socket.on('leaveRoom', () => handleLeave(socket));
    socket.on('disconnect', () => handleLeave(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('🚀 Fibbage/Bluff Server is running!'));
























