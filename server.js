const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// للسماح بالوصول لملفات الصور والـ CSS والـ JS
app.use(express.static(__dirname)); 

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// 1. تحميل الأسئلة مع التأكد من المسار الصحيح للسيرفر
let questionBank = [];
let usedQuestions = []; 

try {
    const questionsPath = path.join(__dirname, 'questions.json');
    const data = fs.readFileSync(questionsPath, 'utf8');
    questionBank = JSON.parse(data);
    console.log(`✅ تم تحميل ${questionBank.length} سؤال بنجاح!`);
} catch (err) {
    console.error("❌ خطأ في تحميل ملف الأسئلة:", err);
}

let players = 0;
let teams = { 'أ': { points: 100 }, 'ب': { points: 100 } };

io.on('connection', (socket) => {
    players++;
    // توزيع عادل للفريقين
    const team = players % 2 !== 0 ? 'أ' : 'ب'; 
    
    // إبلاغ اللاعب بفريقه ونقاط البداية
    socket.emit('init', { team, pointsA: teams['أ'].points, pointsB: teams['ب'].points });

    // استقبال بيانات اللاعب عند الانضمام (الاسم والفريق)
    socket.on('playerJoin', (data) => {
        socket.playerName = data.name;
        socket.playerTeam = data.team;
        console.log(`👤 انضم البطل: ${data.name} لفريق ${data.team}`);
    });

    // 2. استقبال طلب المزاد مع المستوى المختار
    socket.on('requestAuction', (data) => {
        const level = data.level || 'medium';
        
        if (usedQuestions.length >= questionBank.length) usedQuestions = [];

        let q;
        const availableQuestions = questionBank.filter(item => !usedQuestions.includes(item.q));
        
        if (availableQuestions.length > 0) {
            q = availableQuestions[Math.floor(Math.random() * availableQuestions.length)];
        } else {
            q = questionBank[Math.floor(Math.random() * questionBank.length)];
            usedQuestions = [];
        }

        usedQuestions.push(q.q);
        
        io.emit('startAuction', { 
            hint: q.hint, 
            fullQuestion: q, 
            level: level 
        });
    });

    socket.on('placeBid', (data) => {
        // نمرر الاسم للسماح بظهور "المزايد الحالي"
        io.emit('updateBid', { 
            team: data.team, 
            amount: data.amount, 
            name: data.name 
        });
    });

    // 3. إرساء المزاد وتحديد مدة العداد بناءً على المستوى
    socket.on('winAuction', (data) => {
        let duration = 15;
        const level = data.level || 'medium';

        if (level === 'easy') duration = 20;
        else if (level === 'hard') duration = 10;

        io.emit('revealQuestion', { 
            question: data.question, 
            duration: duration 
        });
    });

    socket.on('submitAnswer', (data) => {
        const isCorrect = data.answer === data.correct;
        
        if(isCorrect) teams[data.team].points += 50;
        else teams[data.team].points -= 30;

        io.emit('roundResult', { 
            team: data.team, 
            playerName: data.name,
            isCorrect, 
            points: teams[data.team].points 
        });
    });

    socket.on('disconnect', () => { players--; });
});

// تعديل هام جداً ليعمل على Render (استخدام المنفذ المتاح أو 3000)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 مزاد سؤالستان المطور يعمل على المنفذ ${PORT}`));
