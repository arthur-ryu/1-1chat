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

// /game 접속 라우트 매핑
app.get('/game', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

const mongoURI = process.env.MONGO_URI;
let db;

// 킥(차단)된 사용자 관리 Set
const kickedUsers = new Set();
// IP 필터링(비공개 대상) 관리 Set
const ipFilteredUsers = new Set();
// 유저별 최근 접속 IP 매핑 (username -> IP)
const userIpMap = new Map();

// 화면 공유 세션 상태
let currentScreenSharer = null;

// ================= 게임 상태 관리 (Game Hub) =================
let gameLobby = {
    votes: { mafia: new Set(), headsUp: new Set() },
    countdown: null,
    timer: 10,
    activeGame: null // 'mafia' | 'headsUp' | null
};

let mafiaState = {
    phase: 'idle', // 'roleReveal' | 'intro' | 'dayTalk' | 'dayVote' | 'night' | 'ended'
    players: [], // [{ socketId, username, role, isAlive, introDone }]
    introIndex: 0,
    timer: 0,
    interval: null,
    votes: {}, // voter -> targetUsername or 'skip'
    nightActions: { killTarget: null, healTarget: null }
};

let headsUpState = {
    phase: 'idle', // 'suggestWord' | 'explaining'
    players: [],
    targetUser: null,
    currentWord: '',
    suggestions: {}, // user -> word
    explainerIndex: 0,
    timer: 0,
    interval: null
};

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

function emitToActiveUsers(event, data) {
    for (const [id, s] of io.sockets.sockets) {
        const u = s.handshake.query.username;
        if (!kickedUsers.has(u)) {
            s.emit(event, data);
        }
    }
}

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

function getKSTDateString(date = new Date()) {
    const kstDate = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const y = kstDate.getFullYear();
    const m = String(kstDate.getMonth() + 1).padStart(2, '0');
    const d = String(kstDate.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

async function sendBotMessage(text, extraData = {}) {
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
        readBy: ['bot'],
        ...extraData
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
async function handleBotCommands(commandText, senderUsername, replyToData = null) {
    const cmd = commandText.trim();

    if (cmd === '/game') {
        await sendBotMessage(`🎮 게임 대기실이 열렸습니다! 아래 버튼을 눌러 게임에 참여하세요.`, {
            isGameLink: true
        });
        return true;
    }

    if (cmd === '/help') {
        const helpLines = [
            '🤖 [봇 명령어 안내]',
            '• /game : 미니게임(마피아 / 헤즈업) 투표 및 플레이 방으로 이동합니다.',
            '• /가위바위보 : 5초 카운트다운 후 봇과 가위바위보를 진행합니다.',
            '• /출석체크 : 오늘의 출석을 체크하고 연속 출석일수를 확인합니다.',
            '• /출석랭킹 : 멤버들의 출석 누적 랭킹 TOP 10을 확인합니다.',
            '• /랜덤뽑기 : 전체 멤버 중 무작위 1명을 지목합니다.',
            '• /순서뽑기 : 전체 멤버의 순서를 무작위로 섞어 출력합니다.',
            '• /help : 명령어 목록을 확인합니다.'
        ];
        if (senderUsername === 'admin') {
            helpLines.push('--- [관리자 전용] ---');
            helpLines.push('• /kick [@유저이름 또는 답장] : 유저 추방');
            helpLines.push('• /unkick @유저이름 : 킥 해제');
            helpLines.push('• /klist : 킥 목록');
            helpLines.push('• /alldel [답장 필수] : 답장 메시지부터 아래 메시지 전부 삭제');
            helpLines.push('• /ip : 실시간 접속자 IP 확인');
            helpLines.push('• /ip필터링 @유저이름 : IP 숨김 토글');
            helpLines.push('• /ip필터목록 : IP 필터링 등록 목록');
        }
        await sendBotMessage(helpLines.join('\n'));
        return true;
    }

    if (cmd.startsWith('/kick')) {
        if (senderUsername !== 'admin') {
            await sendBotMessage(`⚠️ /kick 명령어는 관리자 계정만 사용할 수 있습니다.`);
            return true;
        }
        let target = '';
        const rawTarget = cmd.slice(5).trim();
        if (rawTarget) target = rawTarget.replace(/^@/, '').trim();
        else if (replyToData && replyToData.username) target = replyToData.username;

        if (!target) {
            await sendBotMessage(`⚠️ 킥할 유저 닉네임을 입력하거나 답장해주세요.`);
            return true;
        }
        if (target === 'admin') {
            await sendBotMessage(`⚠️ 관리자 계정은 킥할 수 없습니다.`);
            return true;
        }
        kickedUsers.add(target);
        for (let sId in typingUsers) {
            if (typingUsers[sId] === target) delete typingUsers[sId];
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
        const target = cmd.slice(7).trim().replace(/^@/, '').trim();
        if (kickedUsers.has(target)) {
            kickedUsers.delete(target);
            await sendBotMessage(`✅ [관리자 안내] @${target} 님의 추방이 해제되었습니다.`);
        } else {
            await sendBotMessage(`⚠️ @${target} 님은 킥 목록에 없습니다.`);
        }
        return true;
    }

    if (cmd === '/klist') {
        if (senderUsername !== 'admin') {
            await sendBotMessage(`⚠️ /klist 명령어는 관리자 계정만 사용할 수 있습니다.`);
            return true;
        }
        if (kickedUsers.size === 0) {
            await sendBotMessage(`📋 현재 킥된 유저가 없습니다.`);
        } else {
            const listText = Array.from(kickedUsers).map((u, i) => `${i + 1}. @${u}`).join('\n');
            await sendBotMessage(`🚫 [추방 목록]\n${listText}`);
        }
        return true;
    }

    if (cmd === '/alldel') {
        if (senderUsername !== 'admin') {
            await sendBotMessage(`⚠️ /alldel 명령어는 관리자 계정만 사용할 수 있습니다.`);
            return true;
        }
        if (!replyToData) {
            await sendBotMessage(`⚠️ /alldel 은 삭제를 시작할 기준 메시지에 답장으로 입력해야 합니다.`);
            return true;
        }
        try {
            let targetMsg = null;
            if (replyToData.targetId) {
                targetMsg = await db.collection('messages').findOne({ _id: new ObjectId(replyToData.targetId) });
            }
            if (!targetMsg) {
                const query = { username: replyToData.username };
                if (replyToData.text === '[이미지]') query.image = { $ne: null };
                else query.message = replyToData.text;
                targetMsg = await db.collection('messages').findOne(query, { sort: { _id: -1 } });
            }
            if (targetMsg) {
                const messagesToDelete = await db.collection('messages').find({ createdAt: { $gte: targetMsg.createdAt } }).toArray();
                if (messagesToDelete.length > 0) {
                    const ids = messagesToDelete.map(m => m._id);
                    await db.collection('messages').deleteMany({ _id: { $in: ids } });
                    ids.forEach(id => emitToActiveUsers('message_deleted', id.toString()));
                    await sendBotMessage(`🗑️ 기준 메시지 포함 이후 ${messagesToDelete.length}개의 메시지가 삭제되었습니다.`);
                }
            }
        } catch (err) {
            console.error('alldel 에러:', err);
        }
        return true;
    }

    if (cmd === '/ip') {
        if (senderUsername !== 'admin') {
            await sendBotMessage(`⚠️ /ip 명령어는 관리자 계정만 사용할 수 있습니다.`);
            return true;
        }
        const activeUsers = Array.from(new Set(Object.values(onlineUsers)));
        let ipReport = `🌐 [실시간 접속자 IP 목록 (${activeUsers.length}명)]\n`;
        activeUsers.forEach((u, i) => {
            let displayIp = ipFilteredUsers.has(u) ? '[보호됨]' : (cleanIp(userIpMap.get(u)) || '확인 불가');
            ipReport += `${i + 1}. @${u} : ${displayIp}\n`;
        });
        await sendBotMessage(ipReport.trim());
        return true;
    }

    if (cmd.startsWith('/ip필터링')) {
        if (senderUsername !== 'admin') return true;
        const target = cmd.slice(6).trim().replace(/^@/, '').trim();
        if (ipFilteredUsers.has(target)) {
            ipFilteredUsers.delete(target);
            await sendBotMessage(`🔓 @${target} 님의 IP 필터링이 해제되었습니다.`);
        } else {
            ipFilteredUsers.add(target);
            await sendBotMessage(`🛡️ @${target} 님을 IP 필터링 대상에 등록했습니다.`);
        }
        return true;
    }

    if (cmd === '/ip필터목록') {
        if (senderUsername !== 'admin') return true;
        const listText = Array.from(ipFilteredUsers).map((u, i) => `${i + 1}. @${u}`).join('\n');
        await sendBotMessage(`[IP 필터링 목록]\n${listText || '없음'}`);
        return true;
    }

    if (cmd === '/가위바위보') {
        if (isRpsRunning) return true;
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
                await sendBotMessage(`🔔 [결과] 봇의 선택은 👉 ${choices[Math.floor(Math.random() * choices.length)]}`);
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
            const yDate = new Date(); yDate.setDate(yDate.getDate() - 1);
            const yesterday = getKSTDateString(yDate);
            if (user.lastAttendanceDate === today) {
                await sendBotMessage(`@${senderUsername} 님은 이미 오늘 출석체크를 완료하셨습니다!`);
                return true;
            }
            let newStreak = (user.lastAttendanceDate === yesterday) ? ((user.streak || 0) + 1) : 1;
            let newTotal = (user.attendanceCount || 0) + 1;
            await db.collection('users').updateOne({ username: senderUsername }, {
                $set: { lastAttendanceDate: today, streak: newStreak, attendanceCount: newTotal }
            });
            await sendBotMessage(`🎉 @${senderUsername} 님 출석체크 완료! (${newStreak}일 연속, 총 ${newTotal}회)`);
        } catch (e) {}
        return true;
    }

    if (cmd === '/출석랭킹') {
        try {
            const topUsers = await db.collection('users').find({ attendanceCount: { $gt: 0 } }).sort({ attendanceCount: -1 }).limit(10).toArray();
            let rankText = '🏆 [출석체크 랭킹]\n';
            topUsers.forEach((u, i) => { rankText += `${i + 1}위 @${u.username} (${u.attendanceCount}회)\n`; });
            await sendBotMessage(rankText.trim());
        } catch (e) {}
        return true;
    }

    if (cmd === '/랜덤뽑기') {
        const all = await db.collection('users').find({}, { projection: { username: 1 } }).toArray();
        if (all.length) await sendBotMessage(`🎯 당첨자: @${all[Math.floor(Math.random() * all.length)].username} 님 🎉`);
        return true;
    }

    if (cmd === '/순서뽑기') {
        const all = await db.collection('users').find({}, { projection: { username: 1 } }).toArray();
        if (all.length) {
            const shuffled = [...all].sort(() => Math.random() - 0.5);
            let t = '🎲 [랜덤 순서 뽑기]\n';
            shuffled.forEach((m, idx) => t += `${idx + 1}. @${m.username}\n`);
            await sendBotMessage(t.trim());
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

// ================= 게임 루프 로직 (Game Hub) =================
function startLobbyCountdown() {
    if (gameLobby.countdown) return;
    gameLobby.timer = 10;
    io.emit('game_lobby_timer', gameLobby.timer);

    gameLobby.countdown = setInterval(() => {
        gameLobby.timer--;
        io.emit('game_lobby_timer', gameLobby.timer);
        if (gameLobby.timer <= 0) {
            clearInterval(gameLobby.countdown);
            gameLobby.countdown = null;

            const mafiaCount = gameLobby.votes.mafia.size;
            const headsUpCount = gameLobby.votes.headsUp.size;
            const chosen = mafiaCount >= headsUpCount ? 'mafia' : 'headsUp';
            gameLobby.activeGame = chosen;

            io.emit('game_started', { game: chosen });
            if (chosen === 'mafia') initMafiaGame();
            else initHeadsUpGame();
        }
    }, 1000);
}

function initMafiaGame() {
    const sockets = Array.from(io.sockets.sockets.values());
    const players = sockets.map(s => ({
        socketId: s.id,
        username: s.handshake.query.username || '익명',
        role: '시민',
        isAlive: true
    }));

    if (players.length === 0) return;

    // 역할 분배
    const roles = ['마피아', '경찰', '의사'];
    const shuffled = [...players].sort(() => Math.random() - 0.5);
    roles.forEach((r, idx) => {
        if (shuffled[idx]) shuffled[idx].role = r;
    });

    mafiaState.players = shuffled;
    mafiaState.phase = 'roleReveal';
    mafiaState.introIndex = 0;

    // 각자에게 본인 역할 전송
    mafiaState.players.forEach(p => {
        io.to(p.socketId).emit('mafia_assigned_role', { role: p.role });
    });

    // 6초 룰렛 연출 후 자기소개 턴 시작
    setTimeout(() => {
        startMafiaIntroPhase();
    }, 6500);
}

function startMafiaIntroPhase() {
    mafiaState.phase = 'intro';
    const current = mafiaState.players[mafiaState.introIndex];
    if (!current) {
        startMafiaDayTalkPhase();
        return;
    }
    io.emit('mafia_turn_intro', {
        currentSpeaker: current.username,
        index: mafiaState.introIndex,
        total: mafiaState.players.length
    });
}

function startMafiaDayTalkPhase() {
    mafiaState.phase = 'dayTalk';
    mafiaState.timer = 20;
    io.emit('mafia_day_talk_start', { timer: mafiaState.timer });

    mafiaState.interval = setInterval(() => {
        mafiaState.timer--;
        io.emit('mafia_timer_update', { timer: mafiaState.timer, phase: '자유 토론' });
        if (mafiaState.timer <= 0) {
            clearInterval(mafiaState.interval);
            startMafiaDayVotePhase();
        }
    }, 1000);
}

function startMafiaDayVotePhase() {
    mafiaState.phase = 'dayVote';
    mafiaState.votes = {};
    mafiaState.timer = 15;
    const candidates = mafiaState.players.filter(p => p.isAlive).map(p => p.username);
    io.emit('mafia_vote_phase_start', { candidates, timer: mafiaState.timer });

    mafiaState.interval = setInterval(() => {
        mafiaState.timer--;
        io.emit('mafia_timer_update', { timer: mafiaState.timer, phase: '투표' });
        if (mafiaState.timer <= 0) {
            clearInterval(mafiaState.interval);
            finishMafiaDayVote();
        }
    }, 1000);
}

function finishMafiaDayVote() {
    const tally = {};
    Object.values(mafiaState.votes).forEach(t => {
        if (t !== 'skip') tally[t] = (tally[t] || 0) + 1;
    });
    let max = 0, executed = null;
    for (let u in tally) {
        if (tally[u] > max) { max = tally[u]; executed = u; }
    }

    if (executed && max > 1) {
        const victim = mafiaState.players.find(p => p.username === executed);
        if (victim) victim.isAlive = false;
        io.emit('mafia_executed', { username: executed, role: victim ? victim.role : '' });
    } else {
        io.emit('mafia_executed', { username: null });
    }

    setTimeout(startMafiaNightPhase, 4000);
}

function startMafiaNightPhase() {
    mafiaState.phase = 'night';
    mafiaState.nightActions = { killTarget: null, healTarget: null };
    mafiaState.timer = 15;

    const aliveUsers = mafiaState.players.filter(p => p.isAlive).map(p => p.username);
    io.emit('mafia_night_start', { candidates: aliveUsers, timer: mafiaState.timer });

    mafiaState.interval = setInterval(() => {
        mafiaState.timer--;
        io.emit('mafia_timer_update', { timer: mafiaState.timer, phase: '밤 스킬 사용' });
        if (mafiaState.timer <= 0) {
            clearInterval(mafiaState.interval);
            resolveMafiaNight();
        }
    }, 1000);
}

function resolveMafiaNight() {
    let killed = null;
    const { killTarget, healTarget } = mafiaState.nightActions;
    if (killTarget && killTarget !== healTarget) {
        killed = killTarget;
        const victim = mafiaState.players.find(p => p.username === killed);
        if (victim) victim.isAlive = false;
    }
    io.emit('mafia_night_result', { killed });
    setTimeout(startMafiaDayTalkPhase, 4000);
}

// 헤즈업 루프
function initHeadsUpGame() {
    const sockets = Array.from(io.sockets.sockets.values());
    headsUpState.players = sockets.map(s => ({
        socketId: s.id,
        username: s.handshake.query.username || '익명'
    }));

    if (headsUpState.players.length === 0) return;
    headsUpState.targetUser = headsUpState.players[0].username;
    headsUpState.phase = 'suggestWord';
    headsUpState.suggestions = {};
    headsUpState.timer = 10;

    io.emit('headsup_suggest_phase', {
        targetUser: headsUpState.targetUser,
        timer: headsUpState.timer
    });

    headsUpState.interval = setInterval(() => {
        headsUpState.timer--;
        io.emit('headsup_timer_update', { timer: headsUpState.timer });
        if (headsUpState.timer <= 0) {
            clearInterval(headsUpState.interval);
            const words = Object.values(headsUpState.suggestions);
            headsUpState.currentWord = words[Math.floor(Math.random() * words.length)] || '피카츄';
            startHeadsUpExplaining();
        }
    }, 1000);
}

function startHeadsUpExplaining() {
    headsUpState.phase = 'explaining';
    io.emit('headsup_explain_start', {
        targetUser: headsUpState.targetUser,
        word: headsUpState.currentWord
    });
}

// ================= 소켓 연결 =================
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
        await db.collection('users').updateOne(
            { username },
            { $set: { lastActive: Date.now() } },
            { upsert: true }
        );
        broadcastUserList();
    }

    if (!kickedUsers.has(username)) {
        db.collection('messages').find().toArray().then(history => {
            socket.emit('load_history', history);
        }).catch(err => console.error(err));
    }

    // 1. 메시지 전송
    socket.on('send_message', async (data) => {
        if (kickedUsers.has(username)) return;

        if (username) {
            await db.collection('users').updateOne({ username }, { $set: { lastActive: Date.now() } });
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

            if (data.message && data.message.startsWith('/')) {
                await handleBotCommands(data.message, data.username, data.replyTo);
            }
        } catch (err) {
            console.error(err);
        }
    });

    // 2. 화면 공유
    socket.on('start_screen_share', async () => {
        if (kickedUsers.has(username)) return;
        currentScreenSharer = { username, socketId: socket.id };
        await sendBotMessage(`📢 @${username} 님이 화면 공유를 시작하였습니다.`, {
            isScreenShareNotice: true,
            screenSharer: username
        });
    });

    socket.on('stop_screen_share', async () => {
        if (currentScreenSharer && currentScreenSharer.socketId === socket.id) {
            const sName = currentScreenSharer.username;
            currentScreenSharer = null;
            emitToActiveUsers('screen_share_closed');
            await sendBotMessage(`🛑 @${sName} 님의 화면 공유가 중지되었습니다.`);
        }
    });

    socket.on('request_join_screen', () => {
        if (currentScreenSharer) {
            io.to(currentScreenSharer.socketId).emit('screen_viewer_joined', { viewerSocketId: socket.id });
        }
    });

    socket.on('screen_offer', ({ viewerSocketId, offer }) => {
        io.to(viewerSocketId).emit('screen_offer_received', { sharerSocketId: socket.id, offer });
    });

    socket.on('screen_answer', ({ sharerSocketId, answer }) => {
        io.to(sharerSocketId).emit('screen_answer_received', { viewerSocketId: socket.id, answer });
    });

    socket.on('screen_ice_candidate', ({ targetSocketId, candidate }) => {
        io.to(targetSocketId).emit('screen_ice_candidate_received', { senderSocketId: socket.id, candidate });
    });

    // 3. 게임 투표 및 상호작용
    socket.on('game_vote', (type) => {
        if (type === 'mafia') {
            gameLobby.votes.headsUp.delete(username);
            gameLobby.votes.mafia.add(username);
        } else if (type === 'headsUp') {
            gameLobby.votes.mafia.delete(username);
            gameLobby.votes.headsUp.add(username);
        }

        io.emit('game_votes_updated', {
            mafia: gameLobby.votes.mafia.size,
            headsUp: gameLobby.votes.headsUp.size
        });

        startLobbyCountdown();
    });

    socket.on('mafia_intro_finish', () => {
        mafiaState.introIndex++;
        startMafiaIntroPhase();
    });

    socket.on('mafia_cast_vote', (target) => {
        mafiaState.votes[username] = target;
        io.emit('mafia_vote_received', { voter: username });
    });

    socket.on('mafia_night_action', ({ action, target }) => {
        if (action === 'kill') mafiaState.nightActions.killTarget = target;
        if (action === 'heal') mafiaState.nightActions.healTarget = target;
        if (action === 'investigate') {
            const tUser = mafiaState.players.find(p => p.username === target);
            socket.emit('mafia_investigate_result', {
                target,
                isMafia: tUser ? (tUser.role === '마피아') : false
            });
        }
    });

    socket.on('headsup_suggest_word', (word) => {
        headsUpState.suggestions[username] = word;
    });

    socket.on('game_chat_message', (msg) => {
        io.emit('game_chat_broadcast', { username, msg });
    });

    // 4. 읽음/삭제/리액션/타이핑/연결종료
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
        } catch (e) {}
    });

    socket.on('delete_message', async (messageId) => {
        if (kickedUsers.has(username)) return;
        try {
            const id = new ObjectId(messageId);
            const msg = await db.collection('messages').findOne({ _id: id });
            if (msg && msg.username === username) {
                await db.collection('messages').deleteOne({ _id: id });
                emitToActiveUsers('message_deleted', messageId);
            }
        } catch (e) {}
    });

    socket.on('toggle_reaction', async ({ messageId, emoji }) => {
        if (!username || kickedUsers.has(username)) return;
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
            emitToActiveUsers('reaction_updated', { messageId, reactions: msg.reactions });
        } catch (e) {}
    });

    socket.on('typing', async (isTyping) => {
        if (kickedUsers.has(username)) return;
        if (username) {
            await db.collection('users').updateOne({ username }, { $set: { lastActive: Date.now() } });
            if (isTyping) typingUsers[socket.id] = username;
            else delete typingUsers[socket.id];
            emitToActiveUsers('update_typing', Object.values(typingUsers));
        }
    });

    socket.on('disconnect', async () => {
        if (currentScreenSharer && currentScreenSharer.socketId === socket.id) {
            const sName = currentScreenSharer.username;
            currentScreenSharer = null;
            emitToActiveUsers('screen_share_closed');
            sendBotMessage(`🛑 @${sName} 님이 접속을 종료하여 화면 공유가 중지되었습니다.`);
        }
        if (onlineUsers[socket.id]) {
            const leftUser = onlineUsers[socket.id];
            await db.collection('users').updateOne({ username: leftUser }, { $set: { lastActive: Date.now() } });
            delete onlineUsers[socket.id];
            broadcastUserList();
        }
        if (typingUsers[socket.id]) {
            delete typingUsers[socket.id];
            emitToActiveUsers('update_typing', Object.values(typingUsers));
        }
    });
});
