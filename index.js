import makeWASocket, { 
  useMultiFileAuthState, 
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import express from 'express'
import axios from 'axios'
import pino from 'pino'
import qrcode from 'qrcode'

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 8080
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || ''

let sock = null
let latestQR = null

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log('QR Code reçu, disponible sur /qr')
      latestQR = await qrcode.toDataURL(qr)
    }

    if (connection === 'close') {
      const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
      console.log('Connexion fermée, reconnexion:', shouldReconnect)
      if (shouldReconnect) connectToWhatsApp()
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp connecté !')
      latestQR = null
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const from = msg.key.remoteJid
    const text = msg.message.conversation || 
                 msg.message.extendedTextMessage?.text || 
                 ''

    if (!text) return

    console.log(`Message reçu de ${from}: ${text}`)

    if (N8N_WEBHOOK_URL) {
      try {
        await axios.post(N8N_WEBHOOK_URL, { from, text, timestamp: Date.now() })
      } catch (err) {
        console.error('Erreur envoi N8n:', err.message)
      }
    }
  })
}

app.get('/qr', (req, res) => {
  if (latestQR) {
    res.send(`<html><body><h2>Scanne ce QR avec WhatsApp</h2><img src="${latestQR}" /></body></html>`)
  } else {
    res.send('<html><body><h2>✅ WhatsApp déjà connecté !</h2></body></html>')
  }
})

app.post('/send', async (req, res) => {
  const { to, message } = req.body
  if (!sock) return res.status(500).json({ error: 'WhatsApp non connecté' })
  try {
    await sock.sendMessage(to + '@s.whatsapp.net', { text: message })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/health', (req, res) => res.json({ status: 'ok' }))

app.listen(PORT, () => console.log(`🚀 Serveur démarré sur port ${PORT}`))
connectToWhatsApp()
