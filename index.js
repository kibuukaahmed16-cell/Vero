import * as baileys from 'baileys';
import fs from 'fs-extra';
import pino from 'pino';
import cors from 'cors';
import express from 'express';
import { Boom } from '@hapi/boom';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { encryptSession } from './utils.js';

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

const uploadFolder = join(__dirname, 'uploads');

function mkUpp() {
	if (!fs.existsSync(uploadFolder)) {
		fs.mkdirSync(uploadFolder);
	} 
}
mkUpp();
if (!fs.existsSync(uploadFolder)) {
	fs.mkdirSync(uploadFolder);
}
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

app.get('/uploads/:accessKey/:file', async (req, res) => {
	const { accessKey, file } = req.params;
	const filePath = join(uploadFolder, accessKey, file);
	try {
		await fs.access(filePath);
		res.sendFile(filePath);
	} catch {
		res.status(404).json({ error: 'File not found' });
	}
});

app.get('/session/:key', async (req, res) => {
	const accessKey = req.params.key;
	const folderPath = join(uploadFolder, accessKey);

	try {
		await fs.access(folderPath);
		const session = await fs.readdir(folderPath);
		res.json({
			accessKey: accessKey,
			files: session
		});
	} catch (error) {
		console.error('Error accessing folder:', error); // Debug: log any errors
		res.status(404).json({ error: 'Folder not found' });
	}
});

async function getPairingCode(phone) {
	return new Promise(async (resolve, reject) => {
		try {
			const logger = pino({ level: 'silent' });
			const { state, saveCreds } = await baileys.useMultiFileAuthState('session');
			const { version } = await baileys.fetchLatestBaileysVersion();
			const quoted = {
				key: {
					fromMe: false,
					participant: '0@s.whatsapp.net',
					remoteJid: '0@s.whatsapp.net'
				},
				message: {
					extendedTextMessage: {
						text: 'χѕтяσ м∂ вσт'
					}
				}
			};
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
					await conn.sendMessage(
						conn.user.id,
						{
							text: accessKey,
							contextInfo: {
								externalAdReply: {
									title: 'χѕтяσ м∂ вσт',
									body: 'sɪᴍᴘʟᴇ ᴡʜᴀтsᴀᴘᴘ ʙᴏт',
									thumbnail: buffer
								}
							}
						},
						{ quoted: quoted }
					);

					const sessionData = join(uploadFolder, accessKey);
					const oldSessionPath = join(__dirname, 'session');
					encryptSession('session/creds.json', sessionData);
					await baileys.delay(5000);
					clearFolder(oldSessionPath);
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
