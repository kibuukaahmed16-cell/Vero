import * as baileys from 'baileys';
import fs from 'fs-extra';
import pino from 'pino';
import cors from 'cors';
import express from 'express';
import { Boom } from '@hapi/boom';
import { dirname, join } from 'path';
import { rimraf } from 'rimraf';
import { fileURLToPath } from 'url';
import useSequelizeAuthState, { clearSessionData } from './utils.js';

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
let message = `
\`\`\`
Xstro Multi Device Pairing Success
Use the Accesskey Above for Xstro Bot
Please Don't Share to UnAuthorized Users
I won't ask you for your Session
\`\`\`
`;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const uploadFolder = join(__dirname, 'uploads');
if (!fs.existsSync(uploadFolder)) fs.mkdirSync(uploadFolder);

function generateAccessKey() {
	const formatNumber = num => num.toString().padStart(2, '0');
	const r1 = formatNumber(Math.floor(Math.random() * 100));
	const r2 = formatNumber(Math.floor(Math.random() * 100));
	const r3 = formatNumber(Math.floor(Math.random() * 100));
	return `XSTRO_${r1}_${r2}_${r3}`;
}
const accessKey = generateAccessKey();

app.get('/pair', async (req, res) => {
	let phone = req.query.phone;
	if (!phone) return res.json({ error: 'Provide Valid Phone Number' });
	const code = await getPairingCode(phone);
	res.json({ code: code });
});

app.get('/uploads/:accessKey/:file', async (req, res) => {
	const { accessKey, file } = req.params;
	const filePath = join(uploadFolder, accessKey, file);

	if (fs.existsSync(filePath)) {
		res.sendFile(filePath);
	} else {
		res.status(404).json({ error: 'File not found' });
	}
});

app.get('/session/:key', async (req, res) => {
	const accessKey = req.params.key;
	const folderPath = join(uploadFolder, accessKey);

	if (!fs.existsSync(folderPath)) return res.status(404).json({ error: 'Folder not found' });

	const files = await Promise.all(
		(
			await fs.readdir(folderPath)
		).map(async file => {
			return {
				name: file,
				url: `${req.protocol}://${req.get('host')}/uploads/${accessKey}/${file}`,
			};
		}),
	);

	res.json({
		accessKey: accessKey,
		files: files,
	});
});

async function getPairingCode(phone) {
	return new Promise(async (resolve, reject) => {
		try {
			const { state, saveCreds } = await useSequelizeAuthState(accessKey, pino({ level: 'silent' }));
			const { version } = await baileys.fetchLatestBaileysVersion();

			const conn = baileys.makeWASocket({
				version: version,
				printQRInTerminal: false,
				logger: pino({
					level: 'silent',
				}),
				browser: baileys.Browsers.ubuntu('Chrome'),
				auth: state,
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
				const { connection, lastDisconnect } = update;

				if (connection === 'open') {
					await baileys.delay(10000);
					await conn.sendMessage(conn.user.id, { text: accessKey });
					await conn.sendMessage(conn.user.id, { text: `AccessKey Assigned to ${conn.user.name}` });
					const newSessionPath = join(uploadFolder, accessKey);
					const dbPath = join(__dirname, 'database.db');
					const newDbPath = join(newSessionPath, 'database.db');

					try {
						await fs.copy(dbPath, newDbPath);
						await clearSessionData();
						process.send('reset');
					} catch (error) {
						console.error(error);
					}
				}

				if (connection === 'close') {
					const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
					const resetReasons = [baileys.DisconnectReason.connectionClosed, baileys.DisconnectReason.connectionLost, baileys.DisconnectReason.timedOut, baileys.DisconnectReason.connectionReplaced];
					const resetWithClearStateReasons = [baileys.DisconnectReason.loggedOut, baileys.DisconnectReason.badSession];
					if (resetReasons.includes(reason)) {
						process.send('reset');
					} else if (resetWithClearStateReasons.includes(reason)) {
						clearState();
						process.send('reset');
					} else if (reason === baileys.DisconnectReason.restartRequired) {
						getPairingCode();
					} else {
						process.send('reset');
					}
				}
			});

			conn.ev.on('messages.upsert', () => {});
		} catch (error) {
			throw new Error('An Error Occurred');
		}
	});
}

app.listen(PORT, () => {
	console.log('PORT:\nhttp://localhost:' + PORT + '');
});
