// server.js
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

// 킥(차단)된 사용자 관리 Set
const kickedUsers = new Set();
// IP 필터링(비공개 대상) 관리 Set
const ipFilteredUsers = new Set();
// 유저별 최근 접속 IP 매핑 (username -> IP)
const userIpMap = new Map();

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

// 킥되지 않은 정상 유저들에게만 메시지를 브로드캐스트하는 헬퍼
function emitToActiveUsers(event, data) {
    for (const [id, s] of io.sockets.sockets) {
        const u = s.handshake.query.username;
        if (!kickedUsers.has(u)) {
            s.emit(event, data);
        }
    }
}

// IP 문자열 정제 (IPv6 매핑 주소인 ::ffff: 제거)
function cleanIp(ipString) {
    if (!ipString) return '알 수 없음';
    let ip = ipString;
    if (ip.startsWith('::ffff:')) {
        ip = ip.replace('::ffff:', '');
    }
    if (ip === '::1') {
        ip = '127.0.0.1 (로컬호스트)';
    }
    return ip;
}

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
        emitToActiveUsers('receive_message', messageData);
    } catch (err) {
        console.error('봇 메시지 저장/전송 에러:', err);
    }
}

// 봇 명령어 핸들러
async function handleBotCommands(commandText, senderUsername) {
    const cmd = commandText.trim();

    if (cmd === '/help') {
        const helpLines = [
            '🤖 [봇 명령어 안내]',
            '• /가위바위보 : 5초 카운트다운 후 봇과 가위바위보를 진행합니다.',
            '• /출석체크 : 오늘의 출석을 체크하고 연속 출석일수를 확인합니다.',
            '• /출석랭킹 : 멤버들의 출석 누적 랭킹 TOP 10을 확인합니다.',
            '• /랜덤뽑기 : 전체 멤버 중 무작위 1명을 지목합니다.',
            '• /순서뽑기 : 전체 멤버의 순서를 무작위로 섞어 출력합니다.',
            '• /help : 명령어 목록을 확인합니다.'
        ];
        if (senderUsername === 'admin') {
            helpLines.push('--- [관리자 전용] ---');
            helpLines.push('• /kick @유저이름 : 유저를 채팅방에서 추방');
            helpLines.push('• /unkick @유저이름 : 추방된 유저 추방 해제');
            helpLines.push('• /klist : 추방된 유저 목록');
            helpLines.push('• /ip : IP 확인');
            helpLines.push('• /ip필터링 @유저이름 : 해당 유저의 IP 방지(필터) 토글');
            helpLines.push('• /ip필터목록 : IP 필터링 등록된 유저 목록');
        }
        await sendBotMessage(helpLines.join('\n'));
        return true;
    }

    // --- admin 전용 명령어: /kick, /unkick, /klist ---
    if (cmd.startsWith('/kick')) {
        if (senderUsername !== 'admin') {
            await sendBotMessage(`⚠️ /kick 명령어는 관리자 계정만 사용할 수 있습니다.`);
            return true;
        }

        const rawTarget = cmd.slice(5).trim();
        const target = rawTarget.replace(/^@/, '').trim();

        if (!target) {
            await sendBotMessage(`⚠️ 킥할 유저 닉네임을 입력해주세요. 예) /kick @홍길동`);
            return true;
        }

        if (target === 'admin') {
            await sendBotMessage(`⚠️ 관리자 계정은 킥할 수 없습니다.`);
            return true;
        }

        kickedUsers.add(target);

        for (let sId in typingUsers) {
            if (typingUsers[sId] === target) {
                delete typingUsers[sId];
            }
        }
        emitToActiveUsers('update_typing', Object.values(typingUsers));

        await sendBotMessage(`🚫 [관리자 안내] @${target} 님이 추방 처리되었습니다.`);
        return true;
    }

    if (cmd.startsWith('/unkick')) {
        if (senderUsername !== 'admin') {
            await sendBotMessage(`⚠️ /unkick 명령어는 관리자 계정만 사용할 수 있습니다.`);
            return true;
        }

        const rawTarget = cmd.slice(7).trim();
        const target = rawTarget.replace(/^@/, '').trim();

        if (!target) {
            await sendBotMessage(`⚠️ 추방 해제할 유저 닉네임을 입력해주세요. 예) /unkick @김은아`);
            return true;
        }

        if (kickedUsers.has(target)) {
            kickedUsers.delete(target);
            await sendBotMessage(`✅ [관리자 안내] @${target} 님의 추방이 해제되었습니다.`);
        } else {
            await sendBotMessage(`⚠️ @${target} 님은 현재 추방 목록에 없습니다.`);
        }
        return true;
    }

    if (cmd === '/klist') {
        if (senderUsername !== 'admin') {
            await sendBotMessage(`⚠️ /klist 명령어는 관리자 계정만 사용할 수 있습니다.`);
            return true;
        }

        if (kickedUsers.size === 0) {
            await sendBotMessage(`📋 현재 추방된 유저가 없습니다.`);
        } else {
            const listText = Array.from(kickedUsers).map((u, i) => `${i + 1}. @${u}`).join('\n');
            await sendBotMessage(`🚫 [추방(킥) 유저 목록]\n${listText}`);
        }
        return true;
    }

    // --- admin 전용 명령어: /ip, /ip필터링, /ip필터목록 ---
    if (cmd === '/ip') {
        if (senderUsername !== 'admin') {
            await sendBotMessage(`⚠️ /ip 명령어는 관리자 계정만 사용할 수 있습니다.`);
            return true;
        }

        try {
            // 직전 메시지를 찾아 해당 메시지를 읽은 유저 목록 추출
            const lastMsg = await db.collection('messages')
                .find({ username: { $ne: 'bot' } })
                .sort({ _id: -1 })
                .limit(1)
                .toArray();

            if (!lastMsg || lastMsg.length === 0) {
                await sendBotMessage('조회할 수 있는 최근 메시지가 없습니다.');
                return true;
            }

            const readUsers = (lastMsg[0].readBy || []).filter(u => u !== 'bot');

            if (readUsers.length === 0) {
                await sendBotMessage('최근 메시지를 읽은 유저가 아직 없습니다.');
                return true;
            }

            let ipReport = '🌐 [최근 메시지 읽은 유저 IP 목록]\n';
            readUsers.forEach((u, i) => {
                let displayIp;
                if (ipFilteredUsers.has(u)) {
                    displayIp = '[보호됨 / 필터링 적용]';
                } else {
                    const currentIp = userIpMap.get(u);
                    displayIp = currentIp ? cleanIp(currentIp) : '현재 미접속 (알 수 없음)';
                }
                ipReport += `${i + 1}. @${u} : ${displayIp}\n`;
            });

            await sendBotMessage(ipReport.trim());
        } catch (err) {
            console.error('IP 조회 실패:', err);
        }
        return true;
    }

    if (cmd.startsWith('/ip필터링')) {
        if (senderUsername !== 'admin') {
            await sendBotMessage(`⚠️ /ip필터링 명령어는 관리자 계정만 사용할 수 있습니다.`);
            return true;
        }

        const rawTarget = cmd.slice(6).trim();
        const target = rawTarget.replace(/^@/, '').trim();

        if (!target) {
            await sendBotMessage(`⚠️ 필터링할 유저 닉네임을 입력해주세요. 예) /ip필터링 @김은아`);
            return true;
        }

        if (ipFilteredUsers.has(target)) {
            ipFilteredUsers.delete(target);
            await sendBotMessage(`🔓 @${target} 님의 IP 필터링이 해제되었습니다. (이제 IP가 표시됩니다)`);
        } else {
            ipFilteredUsers.add(target);
            await sendBotMessage(`🛡️ @${target} 님을 IP 필터링 대상에 등록했습니다. (/ip 시 IP가 숨겨집니다)`);
        }
        return true;
    }

    if (cmd === '/ip필터목록') {
        if (senderUsername !== 'admin') {
            await sendBotMessage(`⚠️ /ip필터목록 명령어는 관리자 계정만 사용할 수 있습니다.`);
            return true;
        }

        if (ipFilteredUsers.size === 0) {
            await sendBotMessage(`현재 IP 필터링 등록된 유저가 없습니다.`);
        } else {
            const listText = Array.from(ipFilteredUsers).map((u, i) => `${i + 1}. @${u}`).join('\n');
            await sendBotMessage(`[IP 필터링 목록]\n${listText}`);
        }
        return true;
    }

    // --- 일반 유저용 명령어 ---
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
    emitToActiveUsers('update_user_list', { onlineList, allMembers });
}

io.on('connection', async (socket) => {
    const username = socket.handshake.query.username;

    // 접속 클라이언트 IP 추출 및 캐싱
    const rawIp = socket.handshake.headers['x-forwarded-for'] 
        ? socket.handshake.headers['x-forwarded-for'].split(',')[0].trim() 
        : socket.handshake.address;

    if (username) {
        userIpMap.set(username, rawIp);

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

    // 킥된 유저는 기존 내역을 불러오지 않음
    if (!kickedUsers.has(username)) {
        db.collection('messages').find().toArray().then(history => {
            socket.emit('load_history', history);
        }).catch(err => console.error(err));
    }

    // 1. 메시지 전송 (킥 유저 차단)
    socket.on('send_message', async (data) => {
        if (kickedUsers.has(username)) return;

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
            emitToActiveUsers('receive_message', messageData);

            // 봇 명령어 감지 및 수행
            if (data.message && data.message.startsWith('/')) {
                await handleBotCommands(data.message, data.username);
            }
        } catch (err) {
            console.error(err);
        }
    });

    // 2. 읽음 표시 처리 (킥 유저 차단)
    socket.on('mark_read', async (messageId) => {
        if (!username || kickedUsers.has(username)) return;
        try {
            const id = new ObjectId(messageId);
            const msg = await db.collection('messages').findOne({ _id: id });
            if (msg) {
                if (!msg.readBy) msg.readBy = [];
                if (!msg.readBy.includes(username)) {
                    msg.readBy.push(username);
                    await db.collection('messages').updateOne({ _id: id }, { $set: { readBy: msg.readBy } });
                    emitToActiveUsers('message_read_updated', { messageId, readBy: msg.readBy });
                }
            }
        } catch (err) {
            console.error(err);
        }
    });

    // 3. 메시지 삭제
    socket.on('delete_message', async (messageId) => {
        if (kickedUsers.has(username)) return;
        try {
            const id = new ObjectId(messageId);
            const msg = await db.collection('messages').findOne({ _id: id });
            if (msg && msg.username === username) {
                await db.collection('messages').deleteOne({ _id: id });
                emitToActiveUsers('message_deleted', messageId);
            }
        } catch (err) {
            console.error(err);
        }
    });

    // 4. 이모지 공감 반응
    socket.on('toggle_reaction', async ({ messageId, emoji }) => {
        if (!username || kickedUsers.has(username)) return;
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

            emitToActiveUsers('reaction_updated', { messageId, reactions: msg.reactions });
        } catch (err) {
            console.error(err);
        }
    });

    // 5. 타이핑 알림
    socket.on('typing', async (isTyping) => {
        if (kickedUsers.has(username)) return;
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
            emitToActiveUsers('update_typing', Object.values(typingUsers));
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
            emitToActiveUsers('update_typing', Object.values(typingUsers));
        }
    });
});
