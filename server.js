const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { MongoClient, ServerApiVersion } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const uri = "mongodb+srv://yozohryu_db_user:W2oRPjmzPDm7Euch@yujiho.zqpdfaw.mongodb.net/?appName=yujiho";

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

let db, usersCollection, messagesCollection;

async function startServer() {
    try {
        await client.connect();
        db = client.db('my_chat_app');
        usersCollection = db.collection('users');
        messagesCollection = db.collection('messages');
        console.log("MongoDB 클라우드 데이터베이스 연결 성공!");

        // 회원가입 API
        app.post('/api/signup', async (req, res) => {
            const { username, password } = req.body;
            if (!username || !password) {
                return res.json({ success: false, message: '닉네임과 비밀번호를 입력해주세요.' });
            }

            const existingUser = await usersCollection.findOne({ username });
            if (existingUser) {
                return res.json({ success: false, message: '이미 존재하는 닉네임입니다.' });
            }

            await usersCollection.insertOne({ username, password });
            res.json({ success: true, message: '회원가입 완료! 로그인해주세요.' });
        });

        // 로그인 API
        app.post('/api/login', async (req, res) => {
            const { username, password } = req.body;
            if (!username || !password) {
                return res.json({ success: false, message: '닉네임과 비밀번호를 입력해주세요.' });
            }

            const user = await usersCollection.findOne({ username, password });
            if (!user) {
                return res.json({ success: false, message: '닉네임 또는 비밀번호가 틀렸습니다.' });
            }

            res.json({ success: true, message: '로그인 성공!' });
        });

        // Socket.io 실시간 채팅
        io.on('connection', async (socket) => {
            // 접속 시 최근 채팅 100개 불러오기
            const history = await messagesCollection.find().sort({ _id: -1 }).limit(100).toArray();
            socket.emit('load_history', history.reverse());

            socket.on('send_message', async (data) => {
                const timeStr = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
                const messageData = {
                    username: data.username,
                    message: data.message,
                    time: timeStr
                };

                await messagesCollection.insertOne(messageData);
                io.emit('receive_message', messageData);
            });
        });

        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });

    } catch (err) {
        console.error("데이터베이스 연결 실패:", err);
    }
}

startServer();