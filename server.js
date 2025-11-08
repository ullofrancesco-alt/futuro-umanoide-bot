const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ============================================
// CONFIGURAZIONE - DATI REALI
// ============================================
const TELEGRAM_TOKEN = '8239600520:AAHMVAEsUu3Hdd4vD4KFH4KW48a-Q5WBsqY';
const ADMIN_CHAT_ID = '585681146';

// Base44 API - I TUOI DATI REALI
const BASE44_API = 'https://app.base44.com/api/apps/690e1a0262a871b277571301/entities';
const BASE44_API_KEY = '601a9651d7f9433d92341d73eb30398b';
const BASE44_APP_ID = '690e1a0262a871b277571301';

const CHECK_INTERVAL = 30000; // 30 secondi

// ============================================
// INIZIALIZZAZIONE
// ============================================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const app = express();
const notifiedRequests = new Set();

// ============================================
// FUNZIONE PRINCIPALE: Controlla Richieste Pending
// ============================================
async function checkPendingRequests() {
  try {
    console.log('🔍 Controllo nuove richieste...');
    
    const response = await axios.get(`${BASE44_API}/DepositRequest`, {
      headers: {
        'api_key': BASE44_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    const allRequests = response.data;
    const pendingRequests = allRequests.filter(req => req.status === 'pending');

    if (pendingRequests && pendingRequests.length > 0) {
      console.log(`📋 Trovate ${pendingRequests.length} richieste pending`);
      
      for (const req of pendingRequests) {
        if (!notifiedRequests.has(req.id)) {
          await sendRequestNotification(req);
          notifiedRequests.add(req.id);
          console.log(`✅ Notifica inviata per richiesta ${req.id}`);
        }
      }
    } else {
      console.log('📭 Nessuna richiesta pending');
    }
  } catch (error) {
    console.error('❌ Errore controllo richieste:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
  }
}

// ============================================
// INVIA NOTIFICA TELEGRAM CON BOTTONI
// ============================================
async function sendRequestNotification(request) {
  const type = request.request_type === 'deposit' ? 'DEPOSITO ⬇️' : 'PRELIEVO ⬆️';
  
  const message = `
🔔 NUOVA RICHIESTA ${type}

👤 Utente: ${request.user_email}
💰 Importo: ${request.amount} $ROBOT
📍 Wallet: ${request.wallet_address || 'N/A'}
🆔 ID: ${request.id}

⏰ Data: ${new Date(request.created_date).toLocaleString('it-IT')}
  `;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Approva', callback_data: `approve_${request.id}` },
        { text: '❌ Rifiuta', callback_data: `reject_${request.id}` }
      ]
    ]
  };

  // Aggiungi bottone PolygonScan solo se c'è wallet address
  if (request.wallet_address && request.wallet_address !== 'N/A') {
    keyboard.inline_keyboard.push([
      { 
        text: '🔍 Verifica PolygonScan', 
        url: `https://polygonscan.com/address/${request.wallet_address}` 
      }
    ]);
  }

  try {
    await bot.sendMessage(ADMIN_CHAT_ID, message, { 
      reply_markup: keyboard
    });
  } catch (error) {
    console.error('❌ Errore invio notifica Telegram:', error.message);
  }
}

// ============================================
// GESTIONE CLICK SUI BOTTONI
// ============================================
bot.on('callback_query', async (query) => {
  const data = query.data;
  const [action, requestId] = data.split('_');

  console.log(`🔘 Bottone premuto: ${action} per richiesta ${requestId}`);

  if (action === 'approve') {
    const success = await approveRequest(requestId);
    
    if (success) {
      await bot.answerCallbackQuery(query.id, { text: '✅ Richiesta approvata con successo!' });
      await bot.editMessageText(
        query.message.text + '\n\n✅ APPROVATO DA ADMIN', 
        {
          chat_id: ADMIN_CHAT_ID,
          message_id: query.message.message_id
        }
      );
    } else {
      await bot.answerCallbackQuery(query.id, { text: '❌ Errore durante approvazione!' });
    }
    
  } else if (action === 'reject') {
    const success = await rejectRequest(requestId);
    
    if (success) {
      await bot.answerCallbackQuery(query.id, { text: '❌ Richiesta rifiutata!' });
      await bot.editMessageText(
        query.message.text + '\n\n❌ RIFIUTATO DA ADMIN', 
        {
          chat_id: ADMIN_CHAT_ID,
          message_id: query.message.message_id
        }
      );
    } else {
      await bot.answerCallbackQuery(query.id, { text: '❌ Errore durante rifiuto!' });
    }
  }
});

// ============================================
// APPROVA RICHIESTA (LOGICA COMPLETA)
// ============================================
async function approveRequest(requestId) {
  try {
    console.log(`⏳ Approvazione richiesta ${requestId}...`);

    // 1. Leggi dettagli richiesta
    const reqResponse = await axios.get(
      `${BASE44_API}/DepositRequest/${requestId}`,
      {
        headers: {
          'api_key': BASE44_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    const request = reqResponse.data;
    console.log(`📄 Richiesta trovata: ${request.user_email} - ${request.amount} $ROBOT`);

    // 2. Leggi tutti i balance
    const balanceResponse = await axios.get(
      `${BASE44_API}/TokenBalance`,
      {
        headers: {
          'api_key': BASE44_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    const allBalances = balanceResponse.data;
    const userBalance = allBalances.find(b => b.user_email === request.user_email);

    // 3. Aggiorna o crea balance
    if (request.request_type === 'deposit') {
      if (userBalance) {
        // Aggiorna balance esistente
        await axios.put(
          `${BASE44_API}/TokenBalance/${userBalance.id}`,
          {
            balance: userBalance.balance + request.amount,
            total_deposited: (userBalance.total_deposited || 0) + request.amount
          },
          {
            headers: {
              'api_key': BASE44_API_KEY,
              'Content-Type': 'application/json'
            }
          }
        );
        console.log(`💰 Balance aggiornato: ${userBalance.balance} → ${userBalance.balance + request.amount}`);
      } else {
        // Crea nuovo balance (con bonus iniziale 1000)
        await axios.post(
          `${BASE44_API}/TokenBalance`,
          {
            user_email: request.user_email,
            balance: 1000 + request.amount,
            total_deposited: request.amount,
            total_won: 0,
            total_lost: 0,
            total_bets: 0
          },
          {
            headers: {
              'api_key': BASE44_API_KEY,
              'Content-Type': 'application/json'
            }
          }
        );
        console.log(`💰 Nuovo balance creato: ${1000 + request.amount} $ROBOT (1000 bonus + ${request.amount})`);
      }
    } else if (request.request_type === 'withdrawal') {
      // Prelievo: sottrai dal balance
      if (userBalance) {
        const newBalance = Math.max(0, userBalance.balance - request.amount);
        await axios.put(
          `${BASE44_API}/TokenBalance/${userBalance.id}`,
          {
            balance: newBalance
          },
          {
            headers: {
              'api_key': BASE44_API_KEY,
              'Content-Type': 'application/json'
            }
          }
        );
        console.log(`💸 Balance aggiornato (prelievo): ${userBalance.balance} → ${newBalance}`);
      } else {
        console.log('⚠️ Utente non ha balance, impossibile prelevare');
        return false;
      }
    }

    // 4. Aggiorna status richiesta ad "approved"
    await axios.put(
      `${BASE44_API}/DepositRequest/${requestId}`,
      {
        status: 'approved'
      },
      {
        headers: {
          'api_key': BASE44_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`✅ Richiesta ${requestId} approvata con successo!`);
    
    // 5. Invia messaggio di conferma all'utente (opzionale)
    try {
      await bot.sendMessage(
        ADMIN_CHAT_ID, 
        `✅ Deposito approvato!\n\n👤 ${request.user_email}\n💰 ${request.amount} $ROBOT accreditati`
      );
    } catch (e) {
      console.log('Info aggiuntiva non inviata');
    }

    return true;

  } catch (error) {
    console.error(`❌ Errore approvazione richiesta ${requestId}:`, error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
    }
    return false;
  }
}

// ============================================
// RIFIUTA RICHIESTA
// ============================================
async function rejectRequest(requestId) {
  try {
    console.log(`⏳ Rifiuto richiesta ${requestId}...`);

    await axios.put(
      `${BASE44_API}/DepositRequest/${requestId}`,
      {
        status: 'rejected'
      },
      {
        headers: {
          'api_key': BASE44_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log(`❌ Richiesta ${requestId} rifiutata!`);
    return true;

  } catch (error) {
    console.error(`❌ Errore rifiuto richiesta ${requestId}:`, error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    return false;
  }
}

// ============================================
// COMANDO /status
// ============================================
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (chatId.toString() !== ADMIN_CHAT_ID) {
    await bot.sendMessage(chatId, '⛔ Non autorizzato!');
    return;
  }

  const statusMessage = `
📊 STATUS BOT FUTURO UMANOIDE

✅ Bot attivo e in ascolto
⏰ Check database ogni 30 secondi
📋 Richieste monitorate: ${notifiedRequests.size}
🤖 Telegram Chat ID: ${ADMIN_CHAT_ID}
🔗 App ID: ${BASE44_APP_ID}

Comandi disponibili:
/status - Mostra questo messaggio
/clear - Cancella cache notifiche
/test - Invia notifica di test
  `;

  await bot.sendMessage(chatId, statusMessage);
});

// ============================================
// COMANDO /clear (pulisce cache)
// ============================================
bot.onText(/\/clear/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (chatId.toString() !== ADMIN_CHAT_ID) return;

  const count = notifiedRequests.size;
  notifiedRequests.clear();
  await bot.sendMessage(chatId, `🗑️ Cache cancellata! (${count} notifiche rimosse)`);
});

// ============================================
// COMANDO /test (test notifica)
// ============================================
bot.onText(/\/test/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (chatId.toString() !== ADMIN_CHAT_ID) return;

  const testMessage = `
🧪 TEST NOTIFICA

Questo è un messaggio di test per verificare
che il bot funzioni correttamente.

✅ Se vedi questo messaggio, il bot è attivo!
  `;

  await bot.sendMessage(chatId, testMessage);
});

// ============================================
// AVVIO BOT E SERVER
// ============================================

// Prima esecuzione immediata
console.log('🚀 Avvio iniziale...');
checkPendingRequests();

// Poi ogni 30 secondi
setInterval(checkPendingRequests, CHECK_INTERVAL);

// Endpoint HTTP per health check
app.get('/', (req, res) => {
  res.send('🤖 Bot Futuro Umanoide attivo!');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    bot: 'active',
    notifications: notifiedRequests.size,
    app_id: BASE44_APP_ID
  });
});

// Avvia server HTTP
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('🚀 ================================');
  console.log('🤖 BOT FUTURO UMANOIDE ATTIVO!');
  console.log('🚀 ================================');
  console.log(`📡 Server HTTP su porta ${PORT}`);
  console.log(`⏰ Monitoring ogni ${CHECK_INTERVAL/1000} secondi`);
  console.log(`📱 Admin Telegram ID: ${ADMIN_CHAT_ID}`);
  console.log(`🔗 App Base44 ID: ${BASE44_APP_ID}`);
  console.log('');
  
  // Invia messaggio di avvio
  bot.sendMessage(
    ADMIN_CHAT_ID, 
    '🤖 *Bot Futuro Umanoide avviato con successo!*\n\nUsa /status per info.\nUsa /test per verificare funzionamento.',
    { parse_mode: 'Markdown' }
  ).catch(err => console.error('Errore invio messaggio avvio:', err.message));
});

// Gestione errori bot
bot.on('polling_error', (error) => {
  console.error('❌ Polling error:', error.code, error.message);
});

bot.on('error', (error) => {
  console.error('❌ Bot error:', error.message);
});

// Gestione chiusura pulita
process.on('SIGINT', () => {
  console.log('\n👋 Chiusura bot...');
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Chiusura bot...');
  bot.stopPolling();
  process.exit(0);
});
