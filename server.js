const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- إحصائيات المخرج ---
let totalVisits = 0; 
let currentOnline = 0; 

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
    
    // منع الكاش عشان المتصفح يسحب الأسئلة الجديدة دائماً
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

        if (!rooms[roomID]) {
            rooms[roomID] = {
                id: roomID,
                leader: socket.id,
                players: {},
                settings: settings,
                currentRound: 0,
                questions: [],
                playedQuestions: [], // 🧠 ذاكرة الغرفة عشان ما يتكرر السؤال
                bluffs: {},
                votes: {},
                stats: {} 
            };
        }

        rooms[roomID].players[socket.id] = { id: socket.id, name: name, avatar: avatar, points: 0 };
        io.to(roomID).emit('updateState', { players: rooms[roomID].players, leader: rooms[roomID].leader });
    });

    socket.on('requestGameStart', () => {
        const room = rooms[socket.roomID];
        if (room && room.leader === socket.id) {
            let pool = allQuestions;
            
            // 1. فلترة التصنيفات
            if (room.settings.categories && room.settings.categories.length > 0) {
                pool = allQuestions.filter(q => {
                    let cat = q.category || q.hint || q.type;
                    return room.settings.categories.some(c => cat.includes(c));
                });
            }

            // 2. فلترة الأسئلة اللي انلعبت قبل كذا في نفس الغرفة! (يمنع التكرار)
            let unplayedPool = pool.filter(q => !room.playedQuestions.includes(q.q));

            // 3. إذا خلصت الأسئلة اللي ما انلعبت، صفر الذاكرة وارجع خذ من جديد
            if (unplayedPool.length < room.settings.maxRounds) {
                room.playedQuestions = []; // تصفير الذاكرة
                unplayedPool = pool;
            }

            // 4. خلط وسحب الأسئلة
            room.questions = shuffleArray([...unplayedPool]).slice(0, room.settings.maxRounds);
            
            // 5. حفظ الأسئلة المسحوبة في الذاكرة عشان ما تتكرر الجيم الجاي
            room.questions.forEach(q => room.playedQuestions.push(q.q));

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

        io.to(room.id).emit('startBluffPhase', {
            roundNumber: room.currentRound,
            fullQuestion: q,
            isDecisive: isDecisive
        });
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

        io.to(room.id).emit('startVotingPhase', { options: shuffleArray(options) });
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

        setTimeout(() => { startNextRound(room); }, 6000); 
    }

    function endGame(room) {
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

    socket.on('disconnect', () => {
        currentOnline--;
        if (currentOnline < 0) currentOnline = 0; 
        
        if (socket.roomID && rooms[socket.roomID]) {
            const room = rooms[socket.roomID];
            delete room.players[socket.id];
            
            if (room.leader === socket.id) {
                const remaining = Object.keys(room.players);
                if (remaining.length > 0) room.leader = remaining[0];
            }
            
            if (Object.keys(room.players).length === 0) delete rooms[socket.roomID];
            else io.to(socket.roomID).emit('updateState', { players: room.players, leader: room.leader });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 السيرفر شغال على البورت ${PORT}`);
});



