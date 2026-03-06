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

function normalizeArabic(text) {
    if (!text) return "";
    return text.replace(/[أإآ]/g, 'ا')
               .replace(/ة/g, 'ه')
               .replace(/[ىي]/g, 'ي')
               .replace(/[\u064B-\u065F]/g, '')
               .trim();
}

function startNewRound(rID) {
    const room = roomsData[rID];
    if(!room || questionBank.length === 0) return;

    room.currentRound++;
    
    // 🚀 حساب الألقاب عند انتهاء اللعبة
    if (room.currentRound > room.settings.maxRounds) {
        let playersArr = Object.values(room.players);
        let maxBluff = Math.max(...playersArr.map(p => p.bluffSuccesses));
        let maxTricked = Math.max(...playersArr.map(p => p.trickedCount));
        let maxCorrect = Math.max(...playersArr.map(p => p.correctCount));

        let biggestBluffer = maxBluff > 0 ? playersArr.find(p => p.bluffSuccesses === maxBluff).name : null;
        let biggestVictim = maxTricked > 0 ? playersArr.find(p => p.trickedCount === maxTricked).name : null;
        let biggestNerd = maxCorrect > 0 ? playersArr.find(p => p.correctCount === maxCorrect).name : null;

        io.to(rID).emit('gameOver', { 
            players: room.players,
            titles: { bluffer: biggestBluffer, victim: biggestVictim, nerd: biggestNerd }
        });
        return; 
    }

    const q = questionBank[Math.floor(Math.random() * questionBank.length)];
    room.currentQuestion = q; 
    room.bluffs = {}; 
    room.votes = {};  
    room.phase = 'bluffing'; 

    // إرسال تنبيه الجولة الحاسمة إذا كانت الأخيرة
    let isDecisive = (room.currentRound === room.settings.maxRounds);
    io.to(rID).emit('startBluffPhase', { fullQuestion: q, roundNumber: room.currentRound, isDecisive: isDecisive });
}

function startVotingPhase(rID, room) {
    room.phase = 'voting';
    let correctAns = room.currentQuestion.a;
    let allOptions = [correctAns];
    let normalizedCorrect = normalizeArabic(correctAns);

    for (let pid in room.bluffs) {
        let b = room.bluffs[pid].trim();
        if (b && normalizeArabic(b) !== normalizedCorrect && !allOptions.includes(b)) {
            allOptions.push(b);
        }
    }

    if (room.currentQuestion.options && Array.isArray(room.currentQuestion.options)) {
        let originalOpts = [...room.currentQuestion.options].sort(() => Math.random() - 0.5);
        for (let opt of originalOpts) {
            if (allOptions.length < 4 && !allOptions.includes(opt) && normalizeArabic(opt) !== normalizedCorrect) {
                allOptions.push(opt);
            }
        }
    }

    allOptions.sort(() => Math.random() - 0.5);
    room.currentOptions = allOptions; 

    let isDecisive = (room.currentRound === room.settings.maxRounds);
    io.to(rID).emit('startVotingPhase', { options: allOptions, isDecisive: isDecisive });
}

function evaluateRound(rID, room) {
    room.phase = 'results';
    let correctAns = room.currentQuestion.a;
    let results = {}; 
    
    // 🚀 تطبيق مضاعف النقاط للجولة الحاسمة
    let isDecisive = (room.currentRound === room.settings.maxRounds);
    let multiplier = isDecisive ? 2 : 1;

    for (let pid in room.players) {
        results[pid] = { name: room.players[pid].name, pointsGained: 0, votedFor: room.votes[pid], tricked: [] };
    }

    for (let voterId in room.votes) {
        let vote = room.votes[voterId];
        
        if (vote === correctAns) {
            room.players[voterId].points += (2 * multiplier); 
            room.players[voterId].correctCount += 1; // 🤓 زيادة عداد الدافور
            results[voterId].pointsGained += (2 * multiplier);
        } else if (vote && vote !== "TIMEOUT") {
            room.players[voterId].trickedCount += 1; // 🤡 زيادة عداد الضحية

            for (let blufferId in room.bluffs) {
                if (blufferId !== voterId && room.bluffs[blufferId] === vote) {
                    room.players[blufferId].points += (1 * multiplier); 
                    room.players[blufferId].bluffSuccesses += 1; // 🦊 زيادة عداد النصاب
                    results[blufferId].pointsGained += (1 * multiplier);
                    results[blufferId].tricked.push(room.players[voterId].name); 
                }
            }
        }
    }

    io.to(rID).emit('roundResult', { results: results, correctAns: correctAns });
    io.to(rID).emit('updateState', { players: room.players, leader: room.leader });
    room.currentQuestion = null;

    setTimeout(() => { if (roomsData[rID] && roomsData[rID].phase === 'results') startNewRound(rID); }, 7500);
}

function getSmartFallbackBluff(question) {
    if (question.options && Array.isArray(question.options)) {
        let wrongOptions = question.options.filter(o => o !== question.a);
        if (wrongOptions.length > 0) return wrongOptions[Math.floor(Math.random() * wrongOptions.length)];
    }
    return "إجابة غير متوقعة";
}

io.on('connection', (socket) => {
    
    socket.on('joinRoom', (data) => {
        const roomID = data.roomID.trim().toUpperCase(); 
        const name = data.name.trim() || 'لاعب';
        const settings = data.settings;
        const avatar = data.avatar; 
        if (!roomID) return;

        if(socket.currentRoom) socket.leave(socket.currentRoom);
        socket.join(roomID);
        socket.currentRoom = roomID;

        if (!roomsData[roomID]) {
            let maxRnds = settings ? settings.maxRounds : 10;
            roomsData[roomID] = {
                players: {}, leader: socket.id, settings: settings || { roundTime: 30, maxRounds: maxRnds },
                currentQuestion: null, currentRound: 0, phase: 'idle', bluffs: {}, votes: {}, currentOptions: []
            };
        }
        
        const room = roomsData[roomID];
        if (!room.leader || !room.players[room.leader]) room.leader = socket.id;

        // 🚀 إضافة عدادات الإحصائيات للاعب الجديد
        room.players[socket.id] = { name: name, points: 0, avatar: avatar, bluffSuccesses: 0, trickedCount: 0, correctCount: 0 };
        io.to(roomID).emit('updateState', { players: room.players, leader: room.leader, settings: room.settings });
    });

    socket.on('requestGameStart', () => {
        const rID = socket.currentRoom;
        if (rID && roomsData[rID] && roomsData[rID].leader === socket.id) startNewRound(rID);
    });

    socket.on('restartGame', () => {
        const rID = socket.currentRoom;
        const room = roomsData[rID];
        if(room && room.leader === socket.id) {
            room.currentRound = 0;
            room.currentQuestion = null;
            room.phase = 'idle';
            room.bluffs = {};
            room.votes = {};
            room.currentOptions = [];
            // تصفير النقاط والإحصائيات
            for(let pid in room.players) {
                room.players[pid].points = 0;
                room.players[pid].bluffSuccesses = 0;
                room.players[pid].trickedCount = 0;
                room.players[pid].correctCount = 0;
            }
            io.to(rID).emit('gameRestarted');
            io.to(rID).emit('updateState', { players: room.players, leader: room.leader, settings: room.settings });
        }
    });

    socket.on('submitBluff', (data) => {
        const rID = socket.currentRoom;
        const room = roomsData[rID];
        if(!room || room.phase !== 'bluffing') return;

        let finalBluff = data.bluff ? data.bluff : getSmartFallbackBluff(room.currentQuestion);
        room.bluffs[socket.id] = finalBluff;
        
        io.to(rID).emit('playerActed', { id: socket.id, action: 'bluffed' });

        if (Object.keys(room.bluffs).length === Object.keys(room.players).length) startVotingPhase(rID, room);
    });

    socket.on('timeoutBluffAll', () => {
        const rID = socket.currentRoom;
        const room = roomsData[rID];
        if(!room || room.phase !== 'bluffing') return;

        for(let pid in room.players) {
            if (!room.bluffs[pid]) room.bluffs[pid] = getSmartFallbackBluff(room.currentQuestion);
        }
        startVotingPhase(rID, room);
    });

    socket.on('submitVote', (data) => {
        const rID = socket.currentRoom;
        const room = roomsData[rID];
        if(!room || room.phase !== 'voting') return;

        room.votes[socket.id] = data.vote;
        io.to(rID).emit('playerActed', { id: socket.id, action: 'voted' });

        if (Object.keys(room.votes).length === Object.keys(room.players).length) evaluateRound(rID, room);
    });

    socket.on('timeoutVoteAll', () => {
        const rID = socket.currentRoom;
        const room = roomsData[rID];
        if(!room || room.phase !== 'voting') return;

        for(let pid in room.players) {
            if (!room.votes[pid]) {
                let randomOpt = room.currentOptions[Math.floor(Math.random() * room.currentOptions.length)];
                room.votes[pid] = randomOpt;
            }
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
server.listen(PORT, () => console.log('🚀 Server is running!'));;





























