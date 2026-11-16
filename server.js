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

app.get('/game', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

const mongoURI = process.env.MONGO_URI;
let db;

const kickedUsers = new Set();
const ipFilteredUsers = new Set();
const userIpMap = new Map();

let currentScreenSharer = null;

// ================= 마피아 게임 상태 관리 =================
let gameSockets = new Map(); // socketId -> username
let mafiaGame = {
    isRunning: false,
    phase: 'idle',
    players: [],
    introIndex: 0,
    timer: 0,
    interval: null,
    votes: {},     
    nightActions: { killTarget: null, healTarget: null }
};

let lobbyCountdown = null;
let lobbyTimer = 5;

function clearMafiaTimers() {
    if (mafiaGame.interval) {
        clearInterval(mafiaGame.interval);
        mafiaGame.interval = null;
    }
    if (lobbyCountdown) {
        clearInterval(lobbyCountdown);
        lobbyCountdown = null;
    }
}

function checkLobbyStart() {
    const currentCount = gameSockets.size;
    if (mafiaGame.isRunning && currentCount < 4) {
        abortMafiaGame('참가자가 나가 4명 미만이 되어 게임이 중단되었습니다.');
        return;
    }
    if (mafiaGame.isRunning) return;

    io.emit('mafia_lobby_status', {
        currentCount,
        requiredCount: 4,
        canStart: currentCount >= 4
    });

    if (currentCount >= 4) {
        if (!lobbyCountdown) {
            lobbyTimer = 5;
            io.emit('mafia_lobby_timer', lobbyTimer);
            lobbyCountdown = setInterval(() => {
                lobbyTimer--;
                io.emit('mafia_lobby_timer', lobbyTimer);
                if (lobbyTimer <= 0) {
                    clearInterval(lobbyCountdown);
                    lobbyCountdown = null;
                    startMafiaGame();
                }
            }, 1000);
        }
    } else {
        if (lobbyCountdown) {
            clearInterval(lobbyCountdown);
            lobbyCountdown = null;
            io.emit('mafia_lobby_timer', null);
        }
    }
}

function abortMafiaGame(reason) {
    clearMafiaTimers();
    mafiaGame.isRunning = false;
    mafiaGame.phase = 'idle';
    mafiaGame.players = [];
    io.emit('mafia_game_aborted', { reason });
    checkLobbyStart();
}

function startMafiaGame() {
    clearMafiaTimers();
    mafiaGame.isRunning = true;
    mafiaGame.phase = 'roleReveal';
    mafiaGame.introIndex = 0;
    mafiaGame.votes = {};
    mafiaGame.nightActions = { killTarget: null, healTarget: null };

    const entries = Array.from(gameSockets.entries());
    const players = entries.map(([sId, uName]) => ({
        socketId: sId,
        username: uName,
        role: '시민',
        isAlive: true
    }));

    const shuffled = [...players].sort(() => Math.random() - 0.5);
    const assignedRoles = ['마피아', '경찰', '의사'];
    assignedRoles.forEach((role, idx) => {
        if (shuffled[idx]) shuffled[idx].role = role;
    });

    mafiaGame.players = shuffled;
    io.emit('mafia_game_started');

    mafiaGame.players.forEach(p => {
        io.to(p.socketId).emit('mafia_assigned_role', { role: p.role });
    });

    setTimeout(() => {
        if (mafiaGame.isRunning) startIntroPhase();
    }, 6500);
}

function startIntroPhase() {
    if (!mafiaGame.isRunning) return;
    mafiaGame.phase = 'intro';
    const current = mafiaGame.players[mafiaGame.introIndex];

    if (!current || mafiaGame.introIndex >= mafiaGame.players.length) {
        startDayTalkPhase();
        return;
    }

    io.emit('mafia_turn_intro', {
        currentSpeaker: current.username,
        index: mafiaGame.introIndex,
        total: mafiaGame.players.length
    });
}

function startDayTalkPhase() {
    if (!mafiaGame.isRunning) return;
    clearMafiaTimers();
    mafiaGame.phase = 'dayTalk';
    mafiaGame.timer = 20;

    io.emit('mafia_day_talk_start', { timer: mafiaGame.timer });

    mafiaGame.interval = setInterval(() => {
        if (!mafiaGame.isRunning) return clearMafiaTimers();
        mafiaGame.timer--;
        io.emit('mafia_timer_update', { timer: mafiaGame.timer, phase: '자유 토론' });
        if (mafiaGame.timer <= 0) {
            clearMafiaTimers();
            startDayVotePhase();
        }
    }, 1000);
}

function startDayVotePhase() {
    if (!mafiaGame.isRunning) return;
    clearMafiaTimers();
    mafiaGame.phase = 'dayVote';
    mafiaGame.votes = {};
    mafiaGame.timer = 15;

    const candidates = mafiaGame.players.filter(p => p.isAlive).map(p => p.username);
    io.emit('mafia_vote_phase_start', { candidates, timer: mafiaGame.timer });

    mafiaGame.interval = setInterval(() => {
        if (!mafiaGame.isRunning) return clearMafiaTimers();
        mafiaGame.timer--;
        io.emit('mafia_timer_update', { timer: mafiaGame.timer, phase: '처형 투표' });
        if (mafiaGame.timer <= 0) {
            clearMafiaTimers();
            finishDayVote();
        }
    }, 1000);
}

function finishDayVote() {
    if (!mafiaGame.isRunning) return;
    const tally = {};
    Object.values(mafiaGame.votes).forEach(t => {
        if (t !== 'skip') tally[t] = (tally[t] || 0) + 1;
    });

    let max = 0, executed = null;
    for (let u in tally) {
        if (tally[u] > max) { max = tally[u]; executed = u; }
    }

    if (executed && max > 1) {
        const victim = mafiaGame.players.find(p => p.username === executed);
        if (victim) victim.isAlive = false;
        io.emit('mafia_executed', { username: executed, role: victim ? victim.role : '' });
    } else {
        io.emit('mafia_executed', { username: null });
    }

    if (checkGameEnd()) return;

    setTimeout(() => {
        if (mafiaGame.isRunning) startNightPhase();
    }, 4000);
}

function startNightPhase() {
    if (!mafiaGame.isRunning) return;
    clearMafiaTimers();
    mafiaGame.phase = 'night';
    mafiaGame.nightActions = { killTarget: null, healTarget: null };
    mafiaGame.timer = 15;

    const aliveUsers = mafiaGame.players.filter(p => p.isAlive).map(p => p.username);
    io.emit('mafia_night_start', { candidates: aliveUsers, timer: mafiaGame.timer });

    mafiaGame.interval = setInterval(() => {
        if (!mafiaGame.isRunning) return clearMafiaTimers();
        mafiaGame.timer--;
        io.emit('mafia_timer_update', { timer: mafiaGame.timer, phase: '밤 스킬 사용' });
        if (mafiaGame.timer <= 0) {
            clearMafiaTimers();
            resolveNightPhase();
        }
    }, 1000);
}

function resolveNightPhase() {
    if (!mafiaGame.isRunning) return;
    let killed = null;
    const { killTarget, healTarget } = mafiaGame.nightActions;
    if (killTarget && killTarget !== healTarget) {
        killed = killTarget;
        const victim = mafiaGame.players.find(p => p.username === killed);
        if (victim) victim.isAlive = false;
    }

    io.emit('mafia_night_result', { killed });
    if (checkGameEnd()) return;

    setTimeout(() => {
        if (mafiaGame.isRunning) startDayTalkPhase();
    }, 4000);
}

function checkGameEnd() {
    const aliveMafia = mafiaGame.players.filter(p => p.isAlive && p.role === '마피아').length;
    const aliveCitizens = mafiaGame.players.filter(p => p.isAlive && p.role !== '마피아').length;

    if (aliveMafia === 0) {
        endMafiaGame('시민 팀 승리! 모든 마피아가 소탕되었습니다. 🎉');
        return true;
    } else if (aliveMafia >= aliveCitizens) {
        endMafiaGame('마피아 팀 승리! 마피아가 도시를 장악했습니다. 😈');
        return true;
    }
    return false;
}

function endMafiaGame(resultText) {
    clearMafiaTimers();
    mafiaGame.isRunning = false;
    mafiaGame.phase = 'ended';
    io.emit('mafia_game_ended', { resultText });
}

// ================= Express 및 기본 서버 =================
async function startServer() {
    try {
        const client = new MongoClient(mongoURI);
        await client.connect();
        db = client.db('chatapp');
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
        server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
    } catch (err) {
        console.error('데이터베이스 연결 실패:', err);
    }
}

startServer();

app.post('/api/signup', async (req, res) => {
    const { username, password } = req.body;
    try {
        const existingUser = await db.collection('users').findOne({ username });
        if (existingUser) return res.json({ success: false, message: '이미 존재하는 닉네임입니다.' });
        await db.collection('users').insertOne({ 
            username, 
            password, 
            lastActive: Date.now(), 
            attendanceCount: 0, 
            streak: 0, 
            lastAttendanceDate: null,
            friends: [], // 친구 목록
            rooms: ['general'] // 참여 중인 방 목록 (기본 전체방 'general')
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
            // 기본 방 'general'이 없으면 추가
            if (!user.rooms) {
                await db.collection('users').updateOne({ username }, { $set: { rooms: ['general'], friends: [] } });
                user.rooms = ['general'];
                user.friends = [];
            }
            res.json({ success: true, friends: user.friends || [], rooms: user.rooms || ['general'] });
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

function emitToActiveUsers(event, data) {
    for (const [id, s] of io.sockets.sockets) {
        const u = s.handshake.query.username;
        if (!kickedUsers.has(u)) s.emit(event, data);
    }
}

// 특정 방에만 전송
function emitToRoom(roomName, event, data) {
    io.to(roomName).emit(event, data);
}

function cleanIp(ipString) {
    if (!ipString) return '알 수 없음';
    let ip = ipString;
    if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');
    if (ip === '::1') ip = '127.0.0.1 (로컬호스트)';
    return ip;
}

function getKSTDateString(date = new Date()) {
    const kstDate = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const y = kstDate.getFullYear();
    const m = String(kstDate.getMonth() + 1).padStart(2, '0');
    const d = String(kstDate.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

async function sendBotMessage(text, extraData = {}, room = 'general') {
    const now = new Date();
    const timeString = now.toLocaleTimeString('ko-KR', {
        timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: true
    });

    const messageData = {
        room: room,
        username: 'bot',
        message: text,
        time: timeString,
        image: null,
        replyTo: null,
        createdAt: now,
        readBy: ['bot'],
        ...extraData
    };

    try {
        const result = await db.collection('messages').insertOne(messageData);
        messageData._id = result.insertedId;
        emitToRoom(room, 'receive_message', messageData);
    } catch (err) {
        console.error('봇 메시지 전송 에러:', err);
    }
}

async function handleBotCommands(commandText, senderUsername, replyToData = null, room = 'general') {
    const cmd = commandText.trim();
    if (cmd === '/game') {
        await sendBotMessage(`🎮 마피아 게임 대기실이 열렸습니다! 아래 버튼을 눌러 이동하세요.`, { isGameLink: true }, room);
        return true;
    }
    // 기타 명령어 처리 생략 또는 동일 유지 (room 인자 추가 전송 가능)
    return false;
}

io.on('connection', async (socket) => {
    const username = socket.handshake.query.username;
    const rawIp = socket.handshake.headers['x-forwarded-for'] 
        ? socket.handshake.headers['x-forwarded-for'].split(',')[0].trim() 
        : socket.handshake.address;

    if (username) {
        userIpMap.set(username, rawIp);
        for (let id in onlineUsers) {
            if (onlineUsers[id] === username) delete onlineUsers[id];
        }
        onlineUsers[socket.id] = username;
        socket.join('general'); // 기본적으로 general 방 입장

        const userDoc = await db.collection('users').findOne({ username });
        if (userDoc && userDoc.rooms) {
            userDoc.rooms.forEach(r => socket.join(r));
        }

        await db.collection('users').updateOne({ username }, { $set: { lastActive: Date.now() } }, { upsert: true });
        
        // 유저 접속 시 최신 친구 목록 및 방 목록 전송
        socket.emit('init_user_data', {
            friends: userDoc ? userDoc.friends || [] : [],
            rooms: userDoc ? userDoc.rooms || ['general'] : ['general']
        });
    }

    if (!kickedUsers.has(username)) {
        db.collection('messages').find().toArray().then(history => socket.emit('load_history', history)).catch(err => console.error(err));
    }

    // 방 변경 또는 참여
    socket.on('join_room', (roomName) => {
        socket.join(roomName);
    });

    // 친구 검색 API
    socket.on('search_users', async (keyword, callback) => {
        try {
            const regex = new RegExp(keyword, 'i');
            const users = await db.collection('users').find({ 
                username: { $regex: regex, $ne: username } 
            }, { projection: { username: 1 } }).limit(10).toArray();
            callback(users.map(u => u.username));
        } catch (e) {
            callback([]);
        }
    });

    // 친구 추가
    socket.on('add_friend', async (friendName, callback) => {
        try {
            const target = await db.collection('users').findOne({ username: friendName });
            if (!target) {
                return callback({ success: false, message: '존재하지 않는 유저입니다.' });
            }
            const me = await db.collection('users').findOne({ username });
            if (me.friends && me.friends.includes(friendName)) {
                return callback({ success: false, message: '이미 친구로 등록된 유저입니다.' });
            }

            await db.collection('users').updateOne({ username }, { $push: { friends: friendName } });
            
            // 상대방 목록에도 나를 친구로 자동 추가 (원하시면 양방향, 아니면 단방향)
            await db.collection('users').updateOne({ username: friendName }, { $addToSet: { friends: username } });

            const updatedMe = await db.collection('users').findOne({ username });
            callback({ success: true, friends: updatedMe.friends });
        } catch (e) {
            callback({ success: false, message: '서버 오류' });
        }
    });

    // 1:1 대화방 생성 또는 기존 방 열기
    socket.on('get_or_create_dm', async (friendName, callback) => {
        try {
            // 방 이름 규칙: 두 유저 이름을 알파벳/가나다 순으로 정렬하여 조합
            const sorted = [username, friendName].sort();
            const roomName = `dm_${sorted[0]}_${sorted[1]}`;

            // 양쪽 유저의 rooms 목록에 해당 방 추가
            await db.collection('users').updateOne({ username }, { $addToSet: { rooms: roomName } });
            await db.collection('users').updateOne({ username: friendName }, { $addToSet: { rooms: roomName } });

            socket.join(roomName);
            callback({ success: true, roomName });
        } catch (e) {
            callback({ success: false });
        }
    });

    // 단체 톡방 생성 (+ 버튼)
    socket.on('create_group_room', async ({ roomTitle, selectedFriends }, callback) => {
        try {
            const roomId = 'group_' + new ObjectId();
            const members = [username, ...selectedFriends];

            // 모든 참여 유저의 rooms 목록에 새 방 추가
            await db.collection('users').updateMany(
                { username: { $in: members } },
                { $push: { rooms: roomId } }
            );

            // 방 정보 별도 저장 혹은 메시지 연동용
            await db.collection('rooms').insertOne({
                roomId,
                title: roomTitle,
                members,
                createdAt: new Date()
            });

            members.forEach(m => {
                // 온라인 상태인 유저에게 소켓 방 join 시키기 알림 등 처리 가능
            });
            socket.join(roomId);

            callback({ success: true, roomId, roomTitle });
        } catch (e) {
            callback({ success: false });
        }
    });

    // 메시지 전송 (특정 룸 단위)
    socket.on('send_message', async (data) => {
        if (kickedUsers.has(username)) return;

        const room = data.room || 'general';
        const messageData = {
            room: room,
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
            emitToRoom(room, 'receive_message', messageData);

            if (data.message && data.message.startsWith('/')) {
                await handleBotCommands(data.message, data.username, data.replyTo, room);
            }
        } catch (err) {
            console.error(err);
        }
    });

    socket.on('mark_read', async ({ messageId, room }) => {
        if (!username || kickedUsers.has(username)) return;
        try {
            const id = new ObjectId(messageId);
            const msg = await db.collection('messages').findOne({ _id: id });
            if (msg) {
                if (!msg.readBy) msg.readBy = [];
                if (!msg.readBy.includes(username)) {
                    msg.readBy.push(username);
                    await db.collection('messages').updateOne({ _id: id }, { $set: { readBy: msg.readBy } });
                    emitToRoom(room || msg.room || 'general', 'message_read_updated', { messageId, readBy: msg.readBy });
                }
            }
        } catch (e) {}
    });

    // 기타 이벤트들 (delete_message, toggle_reaction 등) 유지
    socket.on('delete_message', async ({ messageId, room }) => {
        try {
            const id = new ObjectId(messageId);
            await db.collection('messages').deleteOne({ _id: id });
            emitToRoom(room || 'general', 'message_deleted', messageId);
        } catch (e) {}
    });

    socket.on('toggle_reaction', async ({ messageId, emoji, room }) => {
        try {
            const id = new ObjectId(messageId);
            const msg = await db.collection('messages').findOne({ _id: id });
            if (!msg) return;
            if (!msg.reactions) msg.reactions = {};

            let found = null;
            for (const [k, uList] of Object.entries(msg.reactions)) {
                if (uList.includes(username)) { found = k; break; }
            }

            if (found === emoji) {
                msg.reactions[emoji] = msg.reactions[emoji].filter(u => u !== username);
                if (!msg.reactions[emoji].length) delete msg.reactions[emoji];
            } else {
                if (found) {
                    msg.reactions[found] = msg.reactions[found].filter(u => u !== username);
                    if (!msg.reactions[found].length) delete msg.reactions[found];
                }
                if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
                msg.reactions[emoji].push(username);
            }

            await db.collection('messages').updateOne({ _id: id }, { $set: { reactions: msg.reactions } });
            emitToRoom(room || msg.room || 'general', 'reaction_updated', { messageId, reactions: msg.reactions });
        } catch (e) {}
    });

    socket.on('disconnect', async () => {
        if (gameSockets.has(socket.id)) {
            gameSockets.delete(socket.id);
            checkLobbyStart();
        }
        if (onlineUsers[socket.id]) {
            delete onlineUsers[socket.id];
        }
    });
});
