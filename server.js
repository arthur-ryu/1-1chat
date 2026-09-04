const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');

const app = express();
const server = http.createServer(app);
// 이미지 전송을 위해 대용량(10MB) 데이터 수신 허용 설정 추가
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
        console.log('MongoDB 클라우드 데이터베이스 연결 성공!');

        // ★ [추가된 부분] 3일(3일 * 24시간 * 60분 * 60초)이 지난 메시지 자동 삭제 TTL 인덱스 설정
        // 기존에 메시지 컬렉션이 있다면 자동으로 인덱스가 적용됩니다.
        await db.collection('messages').createIndex(
            { "createdAt": 1 }, 
            { expireAfterSeconds: 3 * 24 * 60 * 60 }
        );
        console.log('3일 지난 메시지 자동 삭제(TTL) 설정 완료!');

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
        await db.collection('users').insertOne({ username, password });
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
let typingUsers = {}; // 입력 중인 유저들을 관리하는 객체

io.on('connection', (socket) => {
    const username = socket.handshake.query.username;

    if (username) {
        for (let id in onlineUsers) {
            if (onlineUsers[id] === username) {
                delete onlineUsers[id];
            }
        }
        onlineUsers[socket.id] = username;
        io.emit('update_user_list', Object.values(onlineUsers));
    }

    db.collection('messages').find().toArray().then(history => {
        socket.emit('load_history', history);
    }).catch(err => console.error(err));

    socket.on('send_message', async (data) => {
        const messageData = {
            username: data.username,
            message: data.message,
            time: data.time,
            image: data.image || null,      
            replyTo: data.replyTo || null,  
            createdAt: new Date() // ★ [추가된 부분] TTL 인덱스 기준이 될 현재 서버 시간 저장
        };
        
        try {
            const result = await db.collection('messages').insertOne(messageData);
            messageData._id = result.insertedId;
            io.emit('receive_message', messageData);
        } catch (err) {
            console.error(err);
        }
    });

    // 메시지 삭제 처리
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

    // 입력 중 상태 처리
    socket.on('typing', (isTyping) => {
        if (username) {
            if (isTyping) {
                typingUsers[socket.id] = username;
            } else {
                delete typingUsers[socket.id];
            }
            io.emit('update_typing', Object.values(typingUsers));
        }
    });

    socket.on('disconnect', () => {
        if (onlineUsers[socket.id]) {
            delete onlineUsers[socket.id];
            io.emit('update_user_list', Object.values(onlineUsers));
        }
        if (typingUsers[socket.id]) {
            delete typingUsers[socket.id];
            io.emit('update_typing', Object.values(typingUsers));
        }
    });
});
