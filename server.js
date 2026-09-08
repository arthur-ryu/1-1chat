const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 10 * 1024 * 1024 
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const mongoURI = process.env.MONGO_URI;
let db;

async function startServer() {
    try {
        const client = new MongoClient(mongoURI);
        await client.connect();
        db = client.db('chatapp');
        
        // DB 미리 깨우기 (웜업)
        await db.command({ ping: 1 });
        console.log('MongoDB 클라우드 데이터베이스 연결 및 웜업 성공!');

        try {
            await db.collection('messages').dropIndex("createdAt_1");
        } catch (e) {}

        await db.collection('messages').createIndex(
            { "createdAt": 1 }, 
            { expireAfterSeconds: 3 * 24 * 60 * 60 }
        );

        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    } catch (err) {
        console.error('데이터베이스 연결 실패:', err);
    }
}

startServer();

app.post('/api/signup', async (req, res) => {
    const { username, password } = req.body;
    try {
        const existingUser = await db.collection('users').findOne({ username });
        if (existingUser) {
            return res.json({ success: false, message: '이미 존재하는 닉네임입니다.' });
        }
        await db.collection('users').insertOne({ 
            username, 
            password, 
            lastActive: Date.now(),
            attendanceCount: 0,
            streak: 0,
            lastAttendanceDate: null
        });
        res.json({ success: true, message: '회원가입 성공! 로그인해주세요.' });
    } catch (err) {
        res.status(500).json({ success: false, message: '서버 에러 발생' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await db.collection('users').findOne({ username, password });
        if (user) {
            res.json({ success: true });
        } else {
            res.json({ success: false, message: '아이디 또는 비밀번호가 일치하지 않습니다.' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: '서버 에러 발생' });
    }
});

let onlineUsers = {}; 
let typingUsers = {}; 
let isRpsRunning = false;

// 한국 표준시(KST) YYYY-MM-DD 반환 헬퍼
function getKSTDateString(date = new Date()) {
    const kstDate = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const y = kstDate.getFullYear();
    const m = String(kstDate.getMonth() + 1).padStart(2, '0');
    const d = String(kstDate.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// 봇 메시지 브로드캐스트 및 DB 저장 유틸 함수
async function sendBotMessage(text) {
    const now = new Date();
    const timeString = now.toLocaleTimeString('ko-KR', {
        timeZone: 'Asia/Seoul',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });

    const messageData = {
        username: 'bot',
        message: text,
        time: timeString,
        image: null,
        replyTo: null,
        createdAt: now,
        readBy: ['bot']
    };

    try {
        const result = await db.collection('messages').insertOne(messageData);
        messageData._id = result.insertedId;
        io.emit('receive_message', messageData);
    } catch (err) {
        console.error('봇 메시지 저장/전송 에러:', err);
    }
}

// 봇 명령어 핸들러
async function handleBotCommands(commandText, senderUsername) {
    const cmd = commandText.trim();

    if (cmd === '/help') {
        const helpText = [
            '🤖 [봇 명령어 안내]',
            '• /가위바위보 : 5초 카운트다운 후 봇과 가위바위보를 진행합니다.',
            '• /출석체크 : 오늘의 출석을 체크하고 연속 출석일수를 확인합니다.',
            '• /출석랭킹 : 멤버들의 출석 누적 랭킹 TOP 10을 확인합니다.',
            '• /랜덤뽑기 : 전체 멤버 중 무작위 1명을 지목합니다.',
            '• /순서뽑기 : 전체 멤버의 순서를 무작위로 섞어 출력합니다.',
            '• /help : 명령어 목록을 확인합니다.'
        ].join('\n');
        await sendBotMessage(helpText);
        return true;
    }

    if (cmd === '/가위바위보') {
        if (isRpsRunning) {
            await sendBotMessage('⚠️ 이미 가위바위보 카운트다운이 진행 중입니다. 잠시만 기다려주세요!');
            return true;
        }
        isRpsRunning = true;
        await sendBotMessage('가위바위보를 시작합니다! (5초 뒤 결과 발표)');

        let count = 5;
        const intervalId = setInterval(async () => {
            if (count > 0) {
                await sendBotMessage(`${count}!`);
                count--;
            } else {
                clearInterval(intervalId);
                const choices = ['가위 ✌️', '바위 ✊', '보 🖐️'];
                const botChoice = choices[Math.floor(Math.random() * choices.length)];
                await sendBotMessage(`🔔 [결과 발표] 봇의 선택은 👉 ${botChoice} 입니다!`);
                isRpsRunning = false;
            }
        }, 1000);
        return true;
    }

    if (cmd === '/출석체크') {
        try {
            const user = await db.collection('users').findOne({ username: senderUsername });
            if (!user) return true;

            const today = getKSTDateString();
            const yesterdayDate = new Date();
            yesterdayDate.setDate(yesterdayDate.getDate() - 1);
            const yesterday = getKSTDateString(yesterdayDate);

            if (user.lastAttendanceDate === today) {
                await sendBotMessage(`@${senderUsername} 님은 이미 오늘 출석체크를 완료하셨습니다! (현재 연속: ${user.streak || 1}일째, 총 출석: ${user.attendanceCount || 1}회)`);
                return true;
            }

            let newStreak = 1;
            if (user.lastAttendanceDate === yesterday) {
                newStreak = (user.streak || 0) + 1;
            }

            const newTotal = (user.attendanceCount || 0) + 1;

            await db.collection('users').updateOne(
                { username: senderUsername },
                {
                    $set: {
                        lastAttendanceDate: today,
                        streak: newStreak,
                        attendanceCount: newTotal
                    }
                }
            );

            await sendBotMessage(`🎉 @${senderUsername} 님 출석체크 완료! (${newStreak}일 연속 출석 중 🔥 / 총 ${newTotal}회 출석)`);
        } catch (err) {
            console.error('출석체크 처리 실패:', err);
        }
        return true;
    }

    if (cmd === '/출석랭킹') {
        try {
            const topUsers = await db.collection('users')
                .find({ attendanceCount: { $gt: 0 } })
                .sort({ attendanceCount: -1, streak: -1 })
                .limit(10)
                .toArray();

            if (topUsers.length === 0) {
                await sendBotMessage('📊 아직 출석체크를 진행한 멤버가 없습니다. /출석체크 로 첫 기록을 남겨보세요!');
                return true;
            }

            const medal = ['🥇', '🥈', '🥉'];
            let rankText = '🏆 [출석체크 랭킹]\n';
            topUsers.forEach((u, idx) => {
                const rankPrefix = medal[idx] || `${idx + 1}위`;
                rankText += `${rankPrefix} ${u.username} : 총 ${u.attendanceCount}회 (연속 ${u.streak || 0}일)\n`;
            });

            await sendBotMessage(rankText.trim());
        } catch (err) {
            console.error('출석랭킹 조회 실패:', err);
        }
        return true;
    }

    if (cmd === '/랜덤뽑기') {
        try {
            const allMembers = await db.collection('users').find({}, { projection: { username: 1 } }).toArray();
            if (allMembers.length === 0) {
                await sendBotMessage('뽑을 멤버가 존재하지 않습니다.');
                return true;
            }
            const picked = allMembers[Math.floor(Math.random() * allMembers.length)].username;
            await sendBotMessage(`🎯 랜덤 당첨자: @${picked} 님 🎉`);
        } catch (err) {
            console.error('랜덤뽑기 실패:', err);
        }
        return true;
    }

    if (cmd === '/순서뽑기') {
        try {
            const allMembers = await db.collection('users').find({}, { projection: { username: 1 } }).toArray();
            if (allMembers.length === 0) {
                await sendBotMessage('순서를 정할 멤버가 존재하지 않습니다.');
                return true;
            }

            const shuffled = [...allMembers];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }

            let orderText = '🎲 [랜덤 순서 뽑기 결과]\n';
            shuffled.forEach((m, idx) => {
                orderText += `${idx + 1}. @${m.username}\n`;
            });

            await sendBotMessage(orderText.trim());
        } catch (err) {
            console.error('순서뽑기 실패:', err);
        }
        return true;
    }

    return false;
}

async function updateAllMembersActivity() {
    return await db.collection('users').find({}, { projection: { username: 1, lastActive: 1 } }).toArray();
}

async function broadcastUserList() {
    const onlineList = Object.values(onlineUsers);
    const allMembers = await updateAllMembersActivity();
    io.emit('update_user_list', { onlineList, allMembers });
}

io.on('connection', async (socket) => {
    const username = socket.handshake.query.username;

    if (username) {
        for (let id in onlineUsers) {
            if (onlineUsers[id] === username) {
                delete onlineUsers[id];
            }
        }
        onlineUsers[socket.id] = username;
        await db.collection('users').updateOne(
            { username },
            { $set: { lastActive: Date.now() } },
            { upsert: true }
        );
        broadcastUserList();
    }

    db.collection('messages').find().toArray().then(history => {
        socket.emit('load_history', history);
    }).catch(err => console.error(err));

    socket.on('send_message', async (data) => {
        if (username) {
            await db.collection('users').updateOne(
                { username },
                { $set: { lastActive: Date.now() } }
            );
            broadcastUserList();
        }

        const messageData = {
            username: data.username,
            message: data.message,
            time: data.time,
            image: data.image || null,      
            replyTo: data.replyTo || null,  
            createdAt: new Date(),
            readBy: [data.username]
        };
        
        try {
            const result = await db.collection('messages').insertOne(messageData);
            messageData._id = result.insertedId;
            io.emit('receive_message', messageData);

            // 봇 명령어 감지 및 수행
            if (data.message && data.message.startsWith('/')) {
                await handleBotCommands(data.message, data.username);
            }
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('mark_read', async (messageId) => {
        if (!username) return;
        try {
            const id = new ObjectId(messageId);
            const msg = await db.collection('messages').findOne({ _id: id });
            if (msg) {
                if (!msg.readBy) msg.readBy = [];
                if (!msg.readBy.includes(username)) {
                    msg.readBy.push(username);
                    await db.collection('messages').updateOne({ _id: id }, { $set: { readBy: msg.readBy } });
                    io.emit('message_read_updated', { messageId, readBy: msg.readBy });
                }
            }
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('delete_message', async (messageId) => {
        try {
            const id = new ObjectId(messageId);
            const msg = await db.collection('messages').findOne({ _id: id });
            if (msg && msg.username === username) {
                await db.collection('messages').deleteOne({ _id: id });
                io.emit('message_deleted', messageId);
            }
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('toggle_reaction', async ({ messageId, emoji }) => {
        if (!username) return;
        try {
            const id = new ObjectId(messageId);
            const msg = await db.collection('messages').findOne({ _id: id });
            if (!msg) return;

            if (!msg.reactions) {
                msg.reactions = {};
            }

            let existingEmojiFound = null;
            for (const [key, users] of Object.entries(msg.reactions)) {
                if (users.includes(username)) {
                    existingEmojiFound = key;
                    break;
                }
            }

            if (existingEmojiFound === emoji) {
                msg.reactions[emoji] = msg.reactions[emoji].filter(u => u !== username);
                if (msg.reactions[emoji].length === 0) {
                    delete msg.reactions[emoji];
                }
            } else {
                if (existingEmojiFound) {
                    msg.reactions[existingEmojiFound] = msg.reactions[existingEmojiFound].filter(u => u !== username);
                    if (msg.reactions[existingEmojiFound].length === 0) {
                        delete msg.reactions[existingEmojiFound];
                    }
                }
                if (!msg.reactions[emoji]) {
                    msg.reactions[emoji] = [];
                }
                if (!msg.reactions[emoji].includes(username)) {
                    msg.reactions[emoji].push(username);
                }
            }

            await db.collection('messages').updateOne(
                { _id: id },
                { $set: { reactions: msg.reactions } }
            );

            io.emit('reaction_updated', { messageId, reactions: msg.reactions });
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('typing', async (isTyping) => {
        if (username) {
            await db.collection('users').updateOne(
                { username },
                { $set: { lastActive: Date.now() } }
            );
            if (isTyping) {
                typingUsers[socket.id] = username;
            } else {
                delete typingUsers[socket.id];
            }
            io.emit('update_typing', Object.values(typingUsers));
        }
    });

    socket.on('disconnect', async () => {
        if (onlineUsers[socket.id]) {
            const leftUser = onlineUsers[socket.id];
            await db.collection('users').updateOne(
                { username: leftUser },
                { $set: { lastActive: Date.now() } }
            );
            delete onlineUsers[socket.id];
            broadcastUserList();
        }
        if (typingUsers[socket.id]) {
            delete typingUsers[socket.id];
            io.emit('update_typing', Object.values(typingUsers));
        }
    });
});
