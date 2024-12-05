import * as baileys from 'baileys';
import fs from 'fs-extra';
import pino from 'pino';
import cors from 'cors';
import express from 'express';
import NodeCache from 'node-cache';
import { Boom } from '@hapi/boom';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import useSequelizeAuthState, { clearSessionData } from './utils.js';

const app = express();

app.set('json spaces', 2);

app.use((req, res, next) => {
	res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
	res.setHeader('Pragma', 'no-cache');
	res.setHeader('Expires', '0');
	console.log('Headers set to no-cache.');
	next();
});

app.use(cors());
console.log('CORS enabled.');

let PORT = process.env.PORT || 8000;
let message = `
\`\`\`
Xstro Multi Device Pairing Success
Use the Accesskey Above for Xstro Bot
Please Don't Share to UnAuthorized Users
I won't ask you for your Session
\`\`\`
`;
console.log('Message set:', message);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const uploadFolder = join(__dirname, 'uploads');
if (!fs.existsSync(uploadFolder)) {
	fs.mkdirSync(uploadFolder);
	console.log('Upload folder created:', uploadFolder);
} else {
	console.log('Upload folder already exists:', uploadFolder);
}

function generateAccessKey() {
	console.log('Generating access key...');
	const formatNumber = num => num.toString().padStart(2, '0');
	const r1 = formatNumber(Math.floor(Math.random() * 100));
	const r2 = formatNumber(Math.floor(Math.random() * 100));
	const r3 = formatNumber(Math.floor(Math.random() * 100));
	const key = `XSTRO_${r1}_${r2}_${r3}`;
	console.log('Generated access key:', key);
	return key;
}
const accessKey = generateAccessKey();

app.get('/pair', async (req, res) => {
	let phone = req.query.phone;
	console.log('Pair request for phone:', phone);
	if (!phone) {
		console.log('No phone number provided.');
		return res.json({ error: 'Provide Valid Phone Number' });
	}
	const code = await getPairingCode(phone);
	console.log('Pairing code:', code);
	res.json({ code: code });
});

app.get('/uploads/:accessKey/:file', async (req, res) => {
	const { accessKey, file } = req.params;
	console.log('Upload request:', accessKey, file);
	const filePath = join(uploadFolder, accessKey, file);

	if (fs.existsSync(filePath)) {
		console.log('File found:', filePath);
		res.sendFile(filePath);
	} else {
		console.log('File not found:', filePath);
		res.status(404).json({ error: 'File not found' });
	}
});

app.get('/session/:key', async (req, res) => {
	const accessKey = req.params.key;
	console.log('Session request for key:', accessKey);
	const folderPath = join(uploadFolder, accessKey);

	if (!fs.existsSync(folderPath)) {
		console.log('Folder not found:', folderPath);
		return res.status(404).json({ error: 'Folder not found' });
	}

	const files = await Promise.all(
		(
			await fs.readdir(folderPath)
		).map(async file => {
			const url = `${req.protocol}://${req.get('host')}/uploads/${accessKey}/${file}`;
			console.log('File URL:', url);
			return {
				name: file,
				url: url,
			};
		}),
	);

	console.log('Files in session:', files);
	res.json({
		accessKey: accessKey,
		files: files,
	});
});

async function getPairingCode(phone) {
	console.log('Getting pairing code for phone:', phone);
	return new Promise(async (resolve, reject) => {
		try {
			const logger = pino({ level: 'silent' });
			const { state, saveCreds } = await useSequelizeAuthState(accessKey, pino({ level: 'silent' }));
			const { version } = await baileys.fetchLatestBaileysVersion();
			const cache = new NodeCache();
			console.log('Baileys version:', version);

			const conn = baileys.makeWASocket({
				version: version,
				printQRInTerminal: true,
				logger: logger,
				browser: baileys.Browsers.ubuntu('Chrome'),
				auth: {
					creds: state.creds,
					keys: baileys.makeCacheableSignalKeyStore(state.keys, logger, cache),
				},
			});

			if (!conn.authState.creds.registered) {
				let phoneNumber = phone ? phone.replace(/[^0-9]/g, '') : '';
				console.log('Formatted phone number:', phoneNumber);
				if (phoneNumber.length < 11) return reject(new Error('Enter Valid Phone Number'));

				setTimeout(async () => {
					let code = await conn.requestPairingCode(phoneNumber);
					console.log('Requested pairing code:', code);
					resolve(code);
				}, 3000);
			}

			conn.ev.on('creds.update', saveCreds);
			console.log('Listening for creds updates.');

			conn.ev.on('connection.update', async update => {
				console.log('Connection update:', update);
				const { connection, lastDisconnect } = update;

				if (connection === 'open') {
					console.log('Connection open.');
					console.log(connection);
					await baileys.delay(10000);
					await conn.sendMessage(conn.user.id, { text: accessKey });
					await conn.sendMessage(conn.user.id, { text: `AccessKey Assigned to ${conn.user.name}` });
					const newSessionPath = join(uploadFolder, accessKey);
					const dbPath = join(__dirname, 'database.db');
					const newDbPath = join(newSessionPath, 'database.db');
					await baileys.delay(10000);
					try {
						await fs.copy(dbPath, newDbPath);
						console.log('Database copied to session path.');
						await clearSessionData();
						console.log('Session data cleared.');
						process.send('reset');
					} catch (error) {
						console.error('Error copying database:', error);
					}
				}

				if (connection === 'close') {
					console.log('Connection closed.');
					const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
					console.log('Close reason:', reason);

					const resetReasons = [baileys.DisconnectReason.connectionClosed, baileys.DisconnectReason.connectionLost, baileys.DisconnectReason.timedOut, baileys.DisconnectReason.connectionReplaced];
					const resetWithClearStateReasons = [baileys.DisconnectReason.loggedOut, baileys.DisconnectReason.badSession];

					if (resetReasons.includes(reason)) {
						console.log('Resetting connection.');
						process.send('reset');
					} else if (resetWithClearStateReasons.includes(reason)) {
						console.log('Clearing state and resetting connection.');
						clearState();
						process.send('reset');
					} else if (reason === baileys.DisconnectReason.restartRequired) {
						console.log('Restart required, getting new pairing code.');
						getPairingCode();
					} else {
						console.log('Other reason, resetting.');
						process.send('reset');
					}
				}
			});

			conn.ev.on('messages.upsert', msg => {
				if (msg.type === 'notify') {
					console.log(JSON.parse(JSON.stringify(msg.messages[0])));
				}
			});
		} catch (error) {
			console.error('Error occurred:', error);
			reject(new Error('An Error Occurred'));
		}
	});
}

app.listen(PORT, () => {
	console.log('Server running at:\nhttp://localhost:' + PORT);
});
