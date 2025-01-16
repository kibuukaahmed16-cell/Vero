import * as baileys from 'baileys';
import fs from 'fs-extra';
import pino from 'pino';
import cors from 'cors';
import express from 'express';
import { Boom } from '@hapi/boom';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { encryptSession } from './utils.js';
import { getSession, saveSession } from './db.js';

const app = express();

app.set('json spaces', 2);

app.use((req, res, next) => {
	res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
	res.setHeader('Pragma', 'no-cache');
	res.setHeader('Expires', '0');
	next();
});

app.use(cors());

let PORT = process.env.PORT || 8000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function generateAccessKey() {
	const formatNumber = num => num.toString().padStart(2, '0');
	const r1 = formatNumber(Math.floor(Math.random() * 100));
	const r2 = formatNumber(Math.floor(Math.random() * 100));
	const r3 = formatNumber(Math.floor(Math.random() * 100));
	const key = `XSTRO_${r1}_${r2}_${r3}`;
	return key;
}
const accessKey = generateAccessKey();

function clearFolder(folderPath) {
	if (!fs.existsSync(folderPath)) return;
	const contents = fs.readdirSync(folderPath);
	for (const item of contents) {
		const itemPath = join(folderPath, item);
		if (fs.statSync(itemPath).isDirectory()) {
			fs.rmSync(itemPath, { recursive: true, force: true });
		} else {
			fs.unlinkSync(itemPath);
		}
	}
}
clearFolder('./session');
app.get('/pair', async (req, res) => {
	let phone = req.query.phone;
	if (!phone) {
		return res.json({ error: 'Provide Valid Phone Number' });
	}
	const code = await getPairingCode(phone);
	res.json({ code: code });
});

app.get('/session', async (req, res) => {
	const accessKey = req.query.session;

	if (!accessKey) {
		return res.status(401).json({ error: 'No session provided' });
	}
	try {
		const sessionData = await getSession(accessKey);
		if (!sessionData) {
			return res.status(401).json({ error: 'Invalid session' });
		}
		res.json(sessionData);
	} catch (error) {
		res.status(500).json({ error: 'Server error' });
	}
});

async function getPairingCode(phone) {
	return new Promise(async (resolve, reject) => {
		try {
			const logger = pino({ level: 'silent' });
			const { state, saveCreds } = await baileys.useMultiFileAuthState('session');
			const { version } = await baileys.fetchLatestBaileysVersion();
			const buffer = await fetch('https://avatars.githubusercontent.com/u/188756392?v=4')
				.then(res => res.arrayBuffer())
				.then(Buffer.from);

			const conn = baileys.makeWASocket({
				version: version,
				printQRInTerminal: true,
				logger: logger,
				browser: baileys.Browsers.ubuntu('Chrome'),
				auth: {
					creds: state.creds,
					keys: baileys.makeCacheableSignalKeyStore(state.keys, logger)
				}
			});

			if (!conn.authState.creds.registered) {
				let phoneNumber = phone ? phone.replace(/[^0-9]/g, '') : '';
				if (phoneNumber.length < 11) return reject(new Error('Enter Valid Phone Number'));

				setTimeout(async () => {
					let code = await conn.requestPairingCode(phoneNumber);
					resolve(code);
				}, 3000);
			}

			conn.ev.on('creds.update', saveCreds);
			conn.ev.on('connection.update', async update => {
				console.log('Connection update:', update);
				const { connection, lastDisconnect } = update;

				if (connection === 'open') {
					await baileys.delay(10000);
					await conn.sendMessage(conn.user.id,{text: accessKey});

					const data = encryptSession('session/creds.json');
					await saveSession(accessKey, data);
					await baileys.delay(5000);
					clearFolder(join(__dirname, 'session'));
					process.send('reset');
				}

				if (connection === 'close') {
					const reason = new Boom(lastDisconnect?.error)?.output.statusCode;

					const resetReasons = [
						baileys.DisconnectReason.connectionClosed,
						baileys.DisconnectReason.connectionLost,
						baileys.DisconnectReason.timedOut,
						baileys.DisconnectReason.connectionReplaced
					];
					const resetWithClearStateReasons = [
						baileys.DisconnectReason.loggedOut,
						baileys.DisconnectReason.badSession
					];

					if (resetReasons.includes(reason)) {
						process.send('reset');
					} else if (resetWithClearStateReasons.includes(reason)) {
						clearFolder('./session');
						process.send('reset');
					} else if (reason === baileys.DisconnectReason.restartRequired) {
						getPairingCode();
					} else {
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
