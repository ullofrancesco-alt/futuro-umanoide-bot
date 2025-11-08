const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ============================================
// CONFIGURAZIONE - USA VARIABILI D'AMBIENTE
// ============================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8239600520:AAHMVAEsUu3Hdd4vD4KFH4KW48a-Q5WBsqY';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '585681146';

// Base44 API
const BASE44_API = process.env.BASE44_API || 'https://app.base44.com/api/apps/690e1a0262a871b277571301/entities';
const BASE44_API_KEY = process.env.BASE44_API_KEY || '601a9651d7f9433d92341d73eb30398b';
const BASE44_APP_ID = process.env.BASE44_APP_ID || '690e1a0262a871b277571301';

// Vault & PolygonScan
const VAULT_ADDRESS = process.env.VAULT_ADDRESS || '0x78cFdE6e71Cf5cED4afFce5578D2223b51907a49';
const ROBOT_TOKEN_ADDRESS = '0xb0d2A7b1F1EC7D39409E1D671473020d20547B55';
const POLYGONSCAN_API_KEY = process.env.POLYGONSCAN_API_KEY || 'YourPolygonScanAPIKey'; // Get free at polygonscan.com

const CHECK_INTERVAL = 30000; // 30 secondi

// ============================================
// INIZIALIZZAZIONE
// ============================================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const app = express();
const processedTransactions = new Set(); // Cache transazioni già processate

// ============================================
// FUNZIONE: Monitora Depositi al Vault
// ============================================
async function checkVaultDeposits() {
  try {
    console.log('🔍 Controllo depositi al vault...');
    
    // Leggi transazioni token in arrivo al vault
    const response = await axios.get('https://api.polygonscan.com/api', {
      params: {
        module: 'account',
        action: 'tokentx',
        contractaddress: ROBOT_TOKEN_ADDRESS,
        address: VAULT_ADDRESS,
        page: 1,
        offset: 100,
        sort: 'desc',
        apikey: POLYGONSCAN_API_KEY
      }
    });

    if (response.data.status !== '1') {
      console.log('⚠️ Errore PolygonScan API:', response.data.message);
      return;
    }

    const transactions = response.data.result;

    // Filtra transazioni recenti (ultima ora) e in arrivo al vault
    const recentTxs = transactions.filter(tx => {
      const txTime = parseInt(tx.timeStamp);
      const oneHourAgo = Date.now() / 1000 - 3600;
      return txTime > oneHourAgo && tx.to.toLowerCase() === VAULT_ADDRESS.toLowerCase();
    });

    console.log(`📊 Trovate ${recentTxs.length} transazioni recenti al vault`);

    for (const tx of recentTxs) {
      // Skip se già processata
      if (processedTransactions.has(tx.hash)) continue;

      const senderAddress = tx.from;
      const amount = parseInt(tx.value) / 1e18; // Converti da wei
      const txHash = tx.hash;

      console.log(`💰 Nuova transazione: ${senderAddress} → ${amount} $ROBOT`);

      // Cerca se esiste un utente con questo wallet nel database
      const userEmail = await findUserByWallet(senderAddress);

      if (userEmail) {
        // Utente registrato - accredita automaticamente
        await processAutoDeposit(userEmail, senderAddress, amount, txHash);
        processedTransactions.add(txHash);
      } else {
        // Wallet sconosciuto - notifica admin
        await bot.sendMessage(ADMIN_CHAT_ID,
          `⚠️ DEPOSITO DA WALLET SCONOSCIUTO\n\n` +
          `💰 Importo: ${amount} $ROBOT\n` +
          `📍 From: ${senderAddress}\n` +
          `🔗 ${getPolygonScanTxLink(txHash)}\n\n` +
          `❓ Wallet non associato a nessun utente registrato`
        );
        processedTransactions.add(txHash);
      }
    }

  } catch (error) {
    console.error('❌ Errore controllo vault:', error.message);
  }
}

// ============================================
// FUNZIONE: Trova Utente per Wallet
// ============================================
async function findUserByWallet(walletAddress) {
  try {
    // Cerca nelle richieste deposito per associare wallet → email
    const response = await axios.get(`${BASE44_API}/DepositRequest`, {
      headers: {
        'api_key': BASE44_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    const requests = response.data;
    const matchingRequest = requests.find(r => 
      r.wallet_address && 
      r.wallet_address.toLowerCase() === walletAddress.toLowerCase()
    );

    return matchingRequest ? matchingRequest.user_email : null;

  } catch (error) {
    console.error('Errore ricerca utente:', error.message);
    return null;
  }
}

// ============================================
// FUNZIONE: Processa Deposito Automatico
// ============================================
async function processAutoDeposit(userEmail, walletAddress, amount, txHash) {
  try {
    console.log(`✅ Auto-deposito per ${userEmail}: ${amount} $ROBOT`);

    // 1. Leggi balance utente
    const balanceResponse = await axios.get(`${BASE44_API}/TokenBalance`, {
      headers: {
        'api_key': BASE44_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    const balances = balanceResponse.data;
    const userBalance = balances.find(b => b.user_email === userEmail);

    // 2. Aggiorna o crea balance
    if (userBalance) {
      await axios.put(
        `${BASE44_API}/TokenBalance/${userBalance.id}`,
        {
          balance: userBalance.balance + amount,
          total_deposited: (userBalance.total_deposited || 0) + amount
        },
        {
          headers: {
            'api_key': BASE44_API_KEY,
            'Content-Type': 'application/json'
          }
        }
      );
      console.log(`💰 Balance aggiornato: ${userBalance.balance} → ${userBalance.balance + amount}`);
    } else {
      await axios.post(
        `${BASE44_API}/TokenBalance`,
        {
          user_email: userEmail,
          balance: 1000 + amount, // Bonus iniziale + deposito
          total_deposited: amount,
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
      console.log(`💰 Nuovo balance creato: ${1000 + amount} $ROBOT`);
    }

    // 3. Crea record deposito approvato
    await axios.post(
      `${BASE44_API}/DepositRequest`,
      {
        user_email: userEmail,
        wallet_address: walletAddress,
        amount: amount,
        status: 'approved',
        request_type: 'deposit',
        admin_notes: `Auto-approvato - TX: ${txHash}`
      },
      {
        headers: {
          'api_key': BASE44_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    // 4. Notifica admin su Telegram
    await bot.sendMessage(ADMIN_CHAT_ID,
      `✅ DEPOSITO AUTO-APPROVATO\n\n` +
      `👤 Utente: ${userEmail}\n` +
      `💰 Importo: ${amount} $ROBOT\n` +
      `📍 Wallet: ${walletAddress}\n` +
      `🔗 TX: ${getPolygonScanTxLink(txHash)}\n\n` +
      `✨ Saldo aggiornato automaticamente!`
    );

    return true;

  } catch (error) {
    console.error('❌ Errore auto-deposito:', error.message);
    return false;
  }
}

// ============================================
// FUNZIONE: Controlla Richieste Prelievo Pending
// ============================================
async function checkPendingRequests() {
  try {
    console.log('🔍 Controllo richieste prelievo pending...');
    
    const response = await axios.get(`${BASE44_API}/DepositRequest`, {
      headers: {
        'api_key': BASE44_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    const allRequests = response.data;
    const pendingWithdrawals = allRequests.filter(r => 
      r.status === 'pending' && r.request_type === 'withdrawal'
    );

    if (pendingWithdrawals.length > 0) {
      console.log(`📋 Trovate ${pendingWithdrawals.length} richieste prelievo pending`);
      
      for (const req of pendingWithdrawals) {
        await sendWithdrawalNotification(req);
      }
    }

  } catch (error) {
    console.error('❌ Errore controllo prelievi:', error.message);
  }
}

// ============================================
// INVIA NOTIFICA PRELIEVO
// ============================================
async function sendWithdrawalNotification(request) {
  const message = `
🔔 RICHIESTA PRELIEVO ⬆️

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

  if (request.wallet_address) {
    keyboard.inline_keyboard.push([
      { 
        text: '🔍 Verifica PolygonScan', 
        url: `https://polygonscan.com/address/${request.wallet_address}` 
      }
    ]);
  }

  try {
    await bot.sendMessage(ADMIN_CHAT_ID, message, { reply_markup: keyboard });
  } catch (error) {
    console.error('❌ Errore invio notifica:', error.message);
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
    const success = await approveWithdrawal(requestId);
    
    if (success) {
      await bot.answerCallbackQuery(query.id, { text: '✅ Prelievo approvato!' });
      await bot.editMessageText(
        query.message.text + '\n\n✅ APPROVATO - Invia manualmente i token!', 
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
      await bot.answerCallbackQuery(query.id, { text: '❌ Prelievo rifiutato!' });
      await bot.editMessageText(
        query.message.text + '\n\n❌ RIFIUTATO', 
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
// APPROVA PRELIEVO (solo database, invio manuale)
// ============================================
async function approveWithdrawal(requestId) {
  try {
    console.log(`⏳ Approvazione prelievo ${requestId}...`);

    // Leggi richiesta
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

    // Leggi balance utente
    const balanceResponse = await axios.get(
      `${BASE44_API}/TokenBalance`,
      {
        headers: {
          'api_key': BASE44_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    const balances = balanceResponse.data;
    const userBalance = balances.find(b => b.user_email === request.user_email);

    if (!userBalance || userBalance.balance < request.amount) {
      console.log('⚠️ Balance insufficiente');
      return false;
    }

    // Sottrai dal balance
    await axios.put(
      `${BASE44_API}/TokenBalance/${userBalance.id}`,
      {
        balance: userBalance.balance - request.amount
      },
      {
        headers: {
          'api_key': BASE44_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    // Aggiorna richiesta
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

    console.log(`✅ Prelievo ${requestId} approvato - Invia ${request.amount} $ROBOT a ${request.wallet_address}`);
    return true;

  } catch (error) {
    console.error('❌ Errore approvazione prelievo:', error.message);
    return false;
  }
}

// ============================================
// RIFIUTA RICHIESTA
// ============================================
async function rejectRequest(requestId) {
  try {
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
    console.error('❌ Errore rifiuto:', error.message);
    return false;
  }
}

// ============================================
// UTILITY: Link PolygonScan
// ============================================
function getPolygonScanTxLink(txHash) {
  return `https://polygonscan.com/tx/${txHash}`;
}

// ============================================
// COMANDI TELEGRAM
// ============================================
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (chatId.toString() !== ADMIN_CHAT_ID) return;

  const statusMessage = `
📊 STATUS BOT FUTURO UMANOIDE

✅ Bot attivo e in ascolto
⏰ Check vault ogni 30 secondi
🏦 Vault: ${VAULT_ADDRESS}
📋 TX processate: ${processedTransactions.size}

Comandi:
/status - Questo messaggio
/vault - Info vault
/clear - Cancella cache TX
  `;

  await bot.sendMessage(chatId, statusMessage);
});

bot.onText(/\/vault/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (chatId.toString() !== ADMIN_CHAT_ID) return;

  await bot.sendMessage(chatId,
    `🏦 INFO VAULT\n\n` +
    `📍 Address:\n\`${VAULT_ADDRESS}\`\n\n` +
    `🔗 PolygonScan:\nhttps://polygonscan.com/address/${VAULT_ADDRESS}`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/clear/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (chatId.toString() !== ADMIN_CHAT_ID) return;

  const count = processedTransactions.size;
  processedTransactions.clear();
  await bot.sendMessage(chatId, `🗑️ Cache cancellata! (${count} TX rimosse)`);
});

// ============================================
// AVVIO BOT E SERVER
// ============================================
console.log('🚀 Avvio bot...');

// Controlli periodici
setInterval(checkVaultDeposits, CHECK_INTERVAL); // Depositi automatici
setInterval(checkPendingRequests, CHECK_INTERVAL); // Prelievi manuali

// Prima esecuzione immediata
checkVaultDeposits();
checkPendingRequests();

app.get('/', (req, res) => {
  res.send('🤖 Bot Futuro Umanoide + Vault System attivo!');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    vault: VAULT_ADDRESS,
    processed_tx: processedTransactions.size
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('🚀 ================================');
  console.log('🤖 BOT FUTURO UMANOIDE ATTIVO!');
  console.log('🚀 ================================');
  console.log(`📡 Server HTTP su porta ${PORT}`);
  console.log(`🏦 Vault: ${VAULT_ADDRESS}`);
  console.log(`⏰ Monitoring ogni ${CHECK_INTERVAL/1000}s`);
  console.log('');
  
  bot.sendMessage(ADMIN_CHAT_ID, 
    '🤖 *Bot + Vault System avviato!*\n\n' +
    '✅ Depositi automatici attivi\n' +
    '✅ Prelievi notificati\n\n' +
    'Usa /vault per info vault',
    { parse_mode: 'Markdown' }
  ).catch(err => console.log('Avvia conversazione con bot prima'));
});

bot.on('polling_error', (error) => {
  console.error('❌ Polling error:', error.code);
});
