const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// إحصائيات المخرج
let totalVisits = 0; 
let currentOnline = 0; 
const leaderMemory = {}; // 🧠 الذاكرة القوية لمنع التكرار للقائد في كل الغرف

function updateCounterAPI(action) {
    const url = `https://api.counterapi.dev/v1/sualistan_game_v1/total_visits${action}`;
    https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
            try {
                const parsed = JSON.parse(data);
                if (parsed.count !== undefined) totalVisits = parsed.count; 
            } catch (e) {}
        });
    }).on('error', (err) => {
        if (action === '/up') totalVisits++; 
    });
}

updateCounterAPI('');

app.get('/questions.json', (req, res) => {
    let qPath = path.join(__dirname, 'questions.json');
    if (!fs.existsSync(qPath)) qPath = path.join(__dirname, 'public', 'questions.json');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.sendFile(qPath);
});

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

let allQuestions = [];
try {
    let qPath = path.join(__dirname, 'questions.json');
    if (!fs.existsSync(qPath)) qPath = path.join(__dirname, 'public', 'questions.json');
    const rawData = fs.readFileSync(qPath, 'utf8');
    allQuestions = JSON.parse(rawData);
    console.log(`✅ تم تحميل ${allQuestions.length} سؤال بنجاح!`);
} catch (e) {
    console.error("⚠️ ملف الأسئلة غير موجود!", e);
}

const rooms = {};

function normalizeString(text) {
    if (!text) return "";
    return text.replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/[ىي]/g, 'ي').replace(/[\u064B-\u065F]/g, '').trim();
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

io.on('connection', (socket) => {
    updateCounterAPI('/up');
    currentOnline++;

    socket.on('requestAdminStats', (pin) => {
        if (pin === '1234') {
            socket.emit('adminStatsResponse', { online: currentOnline, total: totalVisits });
        } else {
            socket.emit('adminStatsError', 'الرقم السري غير صحيح! ⛔');
        }
    });

    socket.on('joinRoom', (data) => {
        const { roomID, name, avatar, settings } = data;
        socket.join(roomID);
        socket.roomID = roomID;
        socket.playerName = name; 

        if (!rooms[roomID]) {
            rooms[roomID] = {
                id: roomID,
                leader: socket.id,
                players: {},
                settings: settings,
                currentRound: 0,
                questions: [],
                bluffs: {},
                votes: {},
                stats: {},
                phase: 'lobby', 
                currentQuestionPayload: null,
                currentOptionsPayload: null,
                pointsHistory: {}, 
                savedStats: {},
                savedBluffs: {},
                savedVotes: {}
            };
        }

        const room = rooms[roomID];
        let playerPoints = 0;
        let playerStats = { trickedOthers: 0, gotTricked: 0, correctAnswers: 0 };

        if (room.pointsHistory && room.pointsHistory[name] !== undefined) {
            playerPoints = room.pointsHistory[name];
            if (room.savedStats && room.savedStats[name]) playerStats = room.savedStats[name];
            if (room.savedBluffs && room.savedBluffs[name]) room.bluffs[socket.id] = room.savedBluffs[name];
            if (room.savedVotes && room.savedVotes[name]) room.votes[socket.id] = room.savedVotes[name];
        }

        let ghostId = Object.keys(room.players).find(id => room.players[id].name === name);
        if (ghostId) {
            playerPoints = room.players[ghostId].points;
            playerStats = room.stats[ghostId] || playerStats;
            if (room.bluffs[ghostId]) room.bluffs[socket.id] = room.bluffs[ghostId];
            if (room.votes[ghostId]) room.votes[socket.id] = room.votes[ghostId];
            
            if (room.leader === ghostId) room.leader = socket.id;
            
            delete room.players[ghostId];
            delete room.stats[ghostId];
            delete room.bluffs[ghostId];
            delete room.votes[ghostId];
        }

        room.players[socket.id] = { id: socket.id, name: name, avatar: avatar, points: playerPoints };
        room.stats[socket.id] = playerStats;

        io.to(roomID).emit('updateState', { players: room.players, leader: room.leader });

        if (room.phase === 'bluff' && room.currentQuestionPayload) {
            socket.emit('startBluffPhase', room.currentQuestionPayload);
        } else if (room.phase === 'vote' && room.currentOptionsPayload) {
            socket.emit('startVotingPhase', room.currentOptionsPayload);
        }
    });

    socket.on('requestGameStart', () => {
        const room = rooms[socket.roomID];
        if (room && room.leader === socket.id) {
            let pool = allQuestions;
            
            if (room.settings.categories && room.settings.categories.length > 0) {
                pool = allQuestions.filter(q => {
                    let cat = q.category || q.hint || q.type;
                    return room.settings.categories.some(c => cat.includes(c));
                });
            }

            // 🧠 السيرفر يتذكر أسئلة القائد عشان ما يكررها أبداً
            let leaderName = normalizeString(room.players[room.leader].name);
            if (!leaderMemory[leaderName]) leaderMemory[leaderName] = [];
            
            let unplayedPool = pool.filter(q => !leaderMemory[leaderName].includes(q.q));

            // إذا خلصت الأسئلة، يصفر الذاكرة ويسحب من جديد
            if (unplayedPool.length < room.settings.maxRounds) {
                leaderMemory[leaderName] = []; 
                unplayedPool = pool;
            }

            room.questions = shuffleArray([...unplayedPool]).slice(0, room.settings.maxRounds);
            room.questions.forEach(q => leaderMemory[leaderName].push(q.q));

            room.currentRound = 0;
            
            Object.keys(room.players).forEach(pid => {
                room.players[pid].points = 0;
                room.stats[pid] = { trickedOthers: 0, gotTricked: 0, correctAnswers: 0 };
            });

            startNextRound(room);
        }
    });

    function startNextRound(room) {
        room.bluffs = {};
        room.votes = {};
        room.currentRound++;

        if (room.currentRound > room.settings.maxRounds) {
            return endGame(room);
        }

        const isDecisive = (room.currentRound === room.settings.maxRounds);
        const q = room.questions[room.currentRound - 1];

        room.phase = 'bluff';
        room.currentQuestionPayload = { roundNumber: room.currentRound, fullQuestion: q, isDecisive: isDecisive };
        
        io.to(room.id).emit('startBluffPhase', room.currentQuestionPayload);
    }

    socket.on('submitBluff', (data) => {
        const room = rooms[socket.roomID];
        if (room) {
            room.bluffs[socket.id] = data.bluff;
            io.to(room.id).emit('playerActed', { id: socket.id, action: 'bluffed' });

            if (Object.keys(room.bluffs).length === Object.keys(room.players).length) {
                proceedToVoting(room);
            }
        }
    });

    socket.on('timeoutBluffAll', () => {
        const room = rooms[socket.roomID];
        if (room && room.leader === socket.id) proceedToVoting(room);
    });

    function proceedToVoting(room) {
        if (room.phase !== 'bluff') return; // 🛠️ منع التكرار البرمجي المزدوج
        room.phase = 'vote';
        
        const q = room.questions[room.currentRound - 1];
        let options = [q.a]; 
        
        for (let pid in room.bluffs) {
            let b = room.bluffs[pid];
            if (normalizeString(b) !== normalizeString(q.a) && !options.includes(b)) {
                options.push(b);
            }
        }
        
        if (options.length < 4 && q.options) {
            for (let op of q.options) {
                if (!options.includes(op) && normalizeString(op) !== normalizeString(q.a)) {
                    options.push(op);
                    if (options.length >= 4) break;
                }
            }
        }

        room.currentOptionsPayload = { options: shuffleArray(options) };
        io.to(room.id).emit('startVotingPhase', room.currentOptionsPayload);
    }

    socket.on('submitVote', (data) => {
        const room = rooms[socket.roomID];
        if (room) {
            room.votes[socket.id] = data.vote;
            io.to(room.id).emit('playerActed', { id: socket.id, action: 'voted' });

            if (Object.keys(room.votes).length === Object.keys(room.players).length) {
                calculateResults(room);
            }
        }
    });

    socket.on('timeoutVoteAll', () => {
        const room = rooms[socket.roomID];
        if (room && room.leader === socket.id) calculateResults(room);
    });

    function calculateResults(room) {
        if (room.phase !== 'vote') return; // 🛠️ منع التكرار (7/5) والتعليق نهائياً
        room.phase = 'result';
        
        const q = room.questions[room.currentRound - 1];
        const isDecisive = (room.currentRound === room.settings.maxRounds);
        const correctPoints = isDecisive ? 100 : 50;
        const trickPoints = isDecisive ? 40 : 20;

        let roundData = {};
        for (let pid in room.players) {
            roundData[pid] = { name: room.players[pid].name, pointsGained: 0, votedFor: room.votes[pid] || null, tricked: [] };
        }

        for (let voterId in room.votes) {
            let vote = room.votes[voterId];
            
            if (normalizeString(vote) === normalizeString(q.a)) {
                room.players[voterId].points += correctPoints;
                roundData[voterId].pointsGained += correctPoints;
                room.stats[voterId].correctAnswers++;
            } else {
                for (let blufferId in room.bluffs) {
                    if (blufferId !== voterId && normalizeString(vote) === normalizeString(room.bluffs[blufferId])) {
                        room.players[blufferId].points += trickPoints;
                        roundData[blufferId].pointsGained += trickPoints;
                        roundData[blufferId].tricked.push(room.players[voterId].name);
                        
                        room.stats[blufferId].trickedOthers++;
                        room.stats[voterId].gotTricked++;
                        break;
                    }
                }
            }
        }

        io.to(room.id).emit('roundResult', { results: roundData, correctAns: q.a });
        io.to(room.id).emit('updateState', { players: room.players, leader: room.leader });

        setTimeout(() => { 
            if (rooms[room.id] && rooms[room.id].phase === 'result') {
                startNextRound(rooms[room.id]); 
            }
        }, 6000); 
    }

    function endGame(room) {
        room.phase = 'lobby';
        let titles = { bluffer: null, victim: null, nerd: null };
        let maxTricks = 0, maxVictim = 0, maxCorrect = 0;

        for (let pid in room.stats) {
            if (room.stats[pid].trickedOthers > maxTricks && room.stats[pid].trickedOthers >= 2) {
                maxTricks = room.stats[pid].trickedOthers;
                titles.bluffer = room.players[pid].name;
            }
            if (room.stats[pid].gotTricked > maxVictim && room.stats[pid].gotTricked >= 2) {
                maxVictim = room.stats[pid].gotTricked;
                titles.victim = room.players[pid].name;
            }
            if (room.stats[pid].correctAnswers > maxCorrect && room.stats[pid].correctAnswers >= 3) {
                maxCorrect = room.stats[pid].correctAnswers;
                titles.nerd = room.players[pid].name;
            }
        }

        io.to(room.id).emit('gameOver', { players: room.players, titles: titles });
    }

    socket.on('restartGame', () => {
        const room = rooms[socket.roomID];
        if (room && room.leader === socket.id) {
            io.to(room.id).emit('gameRestarted');
        }
    });

    socket.on('leaveRoom', () => {
        handleDisconnect(socket);
    });

    socket.on('disconnect', () => {
        currentOnline--;
        if (currentOnline < 0) currentOnline = 0; 
        handleDisconnect(socket);
    });

    function handleDisconnect(sock) {
        if (sock.roomID && rooms[sock.roomID]) {
            const room = rooms[sock.roomID];
            
            if (room.players[sock.id]) {
                room.pointsHistory = room.pointsHistory || {};
                room.pointsHistory[room.players[sock.id].name] = room.players[sock.id].points;
                
                room.savedStats = room.savedStats || {};
                room.savedStats[room.players[sock.id].name] = room.stats[sock.id];
                
                room.savedBluffs = room.savedBluffs || {};
                if(room.bluffs[sock.id]) room.savedBluffs[room.players[sock.id].name] = room.bluffs[sock.id];
                
                room.savedVotes = room.savedVotes || {};
                if(room.votes[sock.id]) room.savedVotes[room.players[sock.id].name] = room.votes[sock.id];
            }

            delete room.players[sock.id];
            
            if (room.leader === sock.id) {
                const remaining = Object.keys(room.players);
                if (remaining.length > 0) room.leader = remaining[0];
            }
            
            if (Object.keys(room.players).length === 0) {
                delete rooms[sock.roomID];
            } else {
                io.to(sock.roomID).emit('updateState', { players: room.players, leader: room.leader });
                
                if (room.phase === 'bluff' && Object.keys(room.bluffs).length === Object.keys(room.players).length) {
                    proceedToVoting(room);
                } else if (room.phase === 'vote' && Object.keys(room.votes).length === Object.keys(room.players).length) {
                    calculateResults(room);
                }
            }
        }
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 السيرفر شغال على البورت ${PORT}`);
});
