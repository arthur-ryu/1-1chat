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
        await db.collection('users').insertOne({ username, password, lastActive: Date.now() });
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
            readBy: [data.username] // 오직 보낸 사람만 포함
        };
        
        try {
            const result = await db.collection('messages').insertOne(messageData);
            messageData._id = result.insertedId;
            io.emit('receive_message', messageData);
        } catch (err) {
            console.error(err);
        }
    });

    // ★ [핵심 수정] 오직 '전달받은 단 하나의 마지막 메시지'에만 확실하게 리드 체크 반영
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
                    // 전체 브로드캐스트 대신 해당 메시지 갱신 이벤트만 명시적으로 송신
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
