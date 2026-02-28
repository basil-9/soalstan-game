const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname)); 

// قراءة ملف الأسئلة - تأكد من وجود ملف questions.json في نفس المجلد
let questionBank = [];
try {
    questionBank = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
} catch (err) {
    console.error("خطأ في قراءة ملف الأسئلة:", err);
}

let roomsData = {};

io.on('connection', (socket) => {
    // معالجة دخول الغرفة وتعيين القادة بناءً على التصميم الجديد
    socket.on('joinRoom', (data) => {
        const { room, name, team, settings } = data; // استخدام room ليتطابق مع index.html
        const roomID = room;
        
        socket.join(roomID);
        socket.currentRoom = roomID;

        // إنشاء بيانات الغرفة إذا لم تكن موجودة
        if (!roomsData[roomID]) {
            roomsData[roomID] = {
                teams: { 
                    'أ': { points: 100, leader: socket.id }, 
                    'ب': { points: 100, leader: null } 
                },
                settings: settings || { roundTime: 30, maxRounds: 10 },
                currentQuestion: null,
                turnTaken: false
            };
        } else if (!roomsData[roomID].teams[team].leader) {
            // تعيين القائد للفريق إذا كان المنصب شاغراً
            roomsData[roomID].teams[team].leader = socket.id;
        }

        const roomData = roomsData[roomID];
        
        // إرسال البيانات الأولية للواجهة لتحديث النقاط وحالة القائد
        socket.emit('init', { 
            pointsA: roomData.teams['أ'].points, 
            pointsB: roomData.teams['ب'].points, 
            isLeader: socket.id === roomData.teams[team].leader, 
            settings: roomData.settings 
        });
    });

    // طلب مزاد جديد (سؤال جديد) من قبل القائد
    socket.on('requestAuction', () => {
        const room = roomsData[socket.currentRoom];
        if (!room) return;

        const q = questionBank[Math.floor(Math.random() * questionBank.length)];
        room.currentQuestion = q;
        room.turnTaken = false;
        
        // إرسال التلميح للجميع لبدء المزاد
        io.to(socket.currentRoom).emit('startAuction', { 
            hint: q.hint, 
            fullQuestion: q 
        });
    });

    // معالجة الإجابات وتحديث النقاط (كسب 50 أو خسارة 30)
    socket.on('submitAnswer', (data) => {
        const room = roomsData[socket.currentRoom];
        if (!room) return;

        const isCorrect = data.answer === room.currentQuestion.a;
        
        if (isCorrect) {
            room.teams[data.team].points += 50;
            io.to(socket.currentRoom).emit('roundResult', { 
                isCorrect: true, 
                team: data.team, 
                points: room.teams[data.team].points, 
                name: data.name, 
                correctAns: room.currentQuestion.a 
            });
        } else {
            room.teams[data.team].points -= 30;
            
            // إذا كان هذا أول خطأ، يتم نقل السؤال للفريق الآخر مع حذف إجابة
            if (!room.turnTaken) {
                room.turnTaken = true;
                const wrongOptions = room.currentQuestion.options.filter(o => o !== room.currentQuestion.a);
                const newOptions = [room.currentQuestion.a, wrongOptions[0], wrongOptions[1]].sort(() => Math.random() - 0.5);
                
                io.to(socket.currentRoom).emit('passTurn', { 
                    toTeam: data.team === 'أ' ? 'ب' : 'أ', 
                    newOptions: newOptions, 
                    points: room.teams[data.team].points 
                });
            } else {
                // إذا أخطأ الفريقان، تنتهي الجولة
                io.to(socket.currentRoom).emit('roundResult', { 
                    isCorrect: false, 
                    team: data.team, 
                    points: room.teams[data.team].points, 
                    name: data.name, 
                    correctAns: room.currentQuestion.a 
                });
            }
        }
    });

    // أحداث المزاد (إرساء السؤال وتحديث المزايدة)
    socket.on('winAuction', (d) => io.to(socket.currentRoom).emit('revealQuestion', d));
    socket.on('placeBid', (d) => io.to(socket.currentRoom).emit('updateBid', d));

    // تنظيف البيانات عند الخروج (اختياري)
    socket.on('disconnect', () => {
        console.log('لاعب غادر الغرفة');
    });
});

// تشغيل السيرفر على البورت المحدد
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`سيرفر لعبة سؤالستان يعمل على: http://localhost:${PORT}`);
});






