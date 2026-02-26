const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs'); 

const app = express();
const server = http.createServer(app);

// إعداد Socket.io للسماح بالاتصال من أي مكان (CORS) لضمان عمل الرابط
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(__dirname)); 

app.get('/', (req, res) => { 
    res.sendFile(path.join(__dirname, 'index.html')); 
});

let questionBank = [];
let usedQuestions = []; 

// تحميل الأسئلة بمسار آمن للسيرفر
try {
    const questionsPath = path.join(__dirname, 'questions.json');
    if (fs.existsSync(questionsPath)) {
        const data = fs.readFileSync(questionsPath, 'utf8');
        questionBank = JSON.parse(data);
        console.log(`✅ تم تحميل ${questionBank.length} سؤال`);
    }
} catch (err) { console.error("❌ خطأ في الملف:", err); }

let teams = { 'أ': { points: 100 }, 'ب': { points: 100 } };

io.on('connection', (socket) => {
    socket.emit('init', { pointsA: teams['أ'].points, pointsB: teams['ب'].points });

    socket.on('playerJoin', (data) => {
        socket.join(data.team);
        console.log(`👤 ${data.name} دخل فريق ${data.team}`);
    });

    socket.on('requestAuction', (data) => {
        if (questionBank.length === 0) return;
        const q = questionBank[Math.floor(Math.random() * questionBank.length)];
        io.emit('startAuction', { hint: q.hint, fullQuestion: q, level: data.level });
    });

    socket.on('placeBid', (data) => {
        io.emit('updateBid', data);
    });

    socket.on('winAuction', (data) => {
        let duration = data.level === 'easy' ? 20 : (data.level === 'hard' ? 10 : 15);
        io.emit('revealQuestion', { question: data.question, duration });
    });

    socket.on('submitAnswer', (data) => {
        const isCorrect = data.answer === data.correct;
        teams[data.team].points += isCorrect ? 50 : -30;
        io.emit('roundResult', { 
            playerName: data.name, 
            isCorrect, 
            team: data.team, 
            points: teams[data.team].points 
        });
    });
});

// المنفذ الديناميكي لـ Render
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 السيرفر يعمل على منفذ ${PORT}`));

