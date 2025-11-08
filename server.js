const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ============================================
// CONFIGURAZIONE - USA VARIABILI D'AMBIENTE
// ============================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8239600520:AAHMVAEsUu3Hdd4vD4KFH4KW48a-Q5WBsqY';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '585681146';

// Base44 API
const BASE44_API = 'https://app.base44.com/api/apps/690e1a0262a871b277571301/entities';
const BASE44_API_KEY = '601a9651d7f9433d92341d73eb30398b';

// Vault Configuration
const VAULT_ADDRESS = '0x78cFdE6e71Cf5cED4afFce5578D2223b51907a49';
const ROBOT_TOKEN_ADDRESS = '0xb0d2A7b1F1EC7D39409E1D671473020d20547B55';

const CHECK_INTERVAL = 30000; // 30 secondi

// ============================================
// INIZIALIZZAZIONE
// ============================================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const app = express();
const processedTransactions = new Set();
let lastCheckedBlock = 0;

console.log('🤖 Initializing bot...');
console.log('🏦 Vault Address:', VAULT_ADDRESS);

// ============================================
// FUNZIONE: Monitora Depositi al Vault
// ============================================
async function checkVaultDeposits() {
  try {
    console.log('🔍 Checking vault deposits...');
    
    // Chiama PolygonScan API SENZA API KEY (5 calls/sec free!)
    const response = await axios.get('https://api.polygonscan.com/api', {
      params: {
        module: 'account',
        action: 'tokentx',
        contractaddress: ROBOT_TOKEN_ADDRESS,
        address: VAULT_ADDRESS,
        page: 1,
        offset: 50,
        sort: 'desc',
        startblock: lastCheckedBlock > 0 ? lastCheckedBlock : 0
      },
      timeout: 10000
    });

    if (response.data.status !== '1') {
      if (response.data.message === 'No transactions found') {
        console.log('📭 No new transactions');
        return;
      }
      console.log('⚠️ PolygonScan API response:', response.data.message);
      return;
    }

    const transactions = response.data.result;
    
    if (!transactions || transactions.length === 0) {
      console.log('📭 No transactions found');
      return;
    }

    // Aggiorna ultimo blocco controllato
    if (transactions.length > 0) {
      const latestBlock = Math.max(...transactions.map(tx => parseInt(tx.blockNumber)));
      if (latestBlock > lastCheckedBlock) {
        lastCheckedBlock = latestBlock;
      }
    }

    // Filtra solo transazioni IN ARRIVO al vault (to = vault address)
    const incomingTxs = transactions.filter(tx => 
      tx.to.toLowerCase() === VAULT_ADDRESS.toLowerCase() &&
      !processedTransactions.has(tx.hash)
    );

    if (incomingTxs.length === 0) {
      console.log('📭 No new incoming transactions');
      return;
    }

    console.log(`💰 Found ${incomingTxs.length} new incoming transactions`);

    for (const tx of incomingTxs) {
      const senderAddress = tx.from;
      const amount = parseFloat(tx.value) / 1e18; // Converti da wei
      const txHash = tx.hash;
      const blockNumber = tx.blockNumber;

      console.log(`\n💵 New deposit:`);
      console.log(`   From: ${senderAddress}`);
      console.log(`   Amount: ${amount} $ROBOT`);
      console.log(`   TX: ${txHash.slice(0, 10)}...`);

      // Cerca utente con questo wallet
      const userEmail = await findUserByWallet(senderAddress);

      if (userEmail) {
        console.log(`   ✅ User found: ${userEmail}`);
        await processAutoDeposit(userEmail, senderAddress, amount, txHash);
      } else {
        console.log(`   ⚠️ Unknown wallet - notifying admin`);
        await bot.sendMessage(ADMIN_CHAT_ID,
          `⚠️ *DEPOSITO DA WALLET SCONOSCIUTO*\n\n` +
          `💰 Importo: ${amount} $ROBOT\n` +
          `📍 From: \`${senderAddress}\`\n` +
          `📦 Block: ${blockNumber}\n` +
          `🔗 [Verifica TX](https://polygonscan.com/tx/${txHash})\n\n` +
          `❓ Wallet non associato a nessun utente`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        );
      }

      processedTransactions.add(txHash);
    }

  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      console.error('⏱️ Timeout checking vault - will retry');
    } else {
      console.error('❌ Error checking vault:', error.message);
    }
  }
}

// ============================================
// FUNZIONE: Trova Utente per Wallet
// ============================================
async function findUserByWallet(walletAddress) {
  try {
    const response = await axios.get(`${BASE44_API}/DepositRequest`, {
      headers: {
        'api_key': BASE44_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });

    const requests = response.data;
    
    // Cerca nelle richieste precedenti
    const matchingRequest = requests.find(r => 
      r.wallet_address && 
      r.wallet_address.toLowerCase() === walletAddress.toLowerCase()
    );

    return matchingRequest ? matchingRequest.user_email : null;

  } catch (error) {
    console.error('Error finding user:', error.message);
    return null;
  }
}

// ============================================
// FUNZIONE: Processa Deposito Automatico
// ============================================
async function processAutoDeposit(userEmail, walletAddress, amount, txHash) {
  try {
    console.log(`   🔄 Processing auto-deposit for ${userEmail}`);

    // 1. Leggi balance utente
    const balanceResponse = await axios.get(`${BASE44_API}/TokenBalance`, {
      headers: {
        'api_key': BASE44_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 5000
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
          },
          timeout: 5000
        }
      );
      console.log(`   💰 Balance updated: ${userBalance.balance} → ${userBalance.balance + amount}`);
    } else {
      await axios.post(
        `${BASE44_API}/TokenBalance`,
        {
          user_email: userEmail,
          balance: 1000 + amount,
          total_deposited: amount,
          total_won: 0,
          total_lost: 0,
          total_bets: 0
        },
        {
          headers: {
            'api_key': BASE44_API_KEY,
            'Content-Type': 'application/json'
          },
          timeout: 5000
        }
      );
      console.log(`   💰 New balance created: ${1000 + amount} $ROBOT`);
    }

    // 3. Crea record deposito
    await axios.post(
      `${BASE44_API}/DepositRequest`,
      {
        user_email: userEmail,
        wallet_address: walletAddress,
        amount: amount,
        status: 'approved',
        request_type: 'deposit',
        admin_notes: `Auto-approved - TX: ${txHash}`
      },
      {
        headers: {
          'api_key': BASE44_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );

    // 4. Notifica admin
    await bot.sendMessage(ADMIN_CHAT_ID,
      `✅ *DEPOSITO AUTO-APPROVATO*\n\n` +
      `👤 Utente: ${userEmail}\n` +
      `💰 Importo: ${amount} $ROBOT\n` +
      `📍 Wallet: \`${walletAddress}\`\n` +
      `🔗 [Verifica TX](https://polygonscan.com/tx/${txHash})\n\n` +
      `✨ Saldo aggiornato automaticamente!`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );

    console.log(`   ✅ Auto-deposit completed!`);
    return true;

  } catch (error) {
    console.error('   ❌ Error processing auto-deposit:', error.message);
    
    // Notifica admin dell'errore
    await bot.sendMessage(ADMIN_CHAT_ID,
      `❌ *ERRORE AUTO-DEPOSITO*\n\n` +
      `User: ${userEmail}\n` +
      `Amount: ${amount} $ROBOT\n` +
      `Error: ${error.message}\n\n` +
      `⚠️ Approva manualmente dal dashboard!`
    ).catch(e => console.error('Failed to send error notification'));
    
    return false;
  }
}

// ============================================
// FUNZIONE: Check Prelievi Pending
// ============================================
async function checkPendingWithdrawals() {
  try {
    console.log('🔍 Checking pending withdrawals...');
    
    const response = await axios.get(`${BASE44_API}/DepositRequest`, {
      headers: {
        'api_key': BASE44_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });

    const requests = response.data;
    const pendingWithdrawals = requests.filter(r => 
      r.status === 'pending' && 
      r.request_type === 'withdrawal' &&
      !processedTransactions.has(`withdrawal_${r.id}`)
    );

    if (pendingWithdrawals.length > 0) {
      console.log(`📋 Found ${pendingWithdrawals.length} pending withdrawals`);
      
      for (const req of pendingWithdrawals) {
        await sendWithdrawalNotification(req);
        processedTransactions.add(`withdrawal_${req.id}`);
      }
    }

  } catch (error) {
    console.error('❌ Error checking withdrawals:', error.message);
  }
}

// ============================================
// INVIA NOTIFICA PRELIEVO
// ============================================
async function sendWithdrawalNotification(request) {
  const message = 
    `🔔 *RICHIESTA PRELIEVO* ⬆️\n\n` +
    `👤 Utente: ${request.user_email}\n` +
    `💰 Importo: ${request.amount} $ROBOT\n` +
    `📍 Wallet: \`${request.wallet_address || 'N/A'}\`\n` +
    `🆔 ID: ${request.id}\n\n` +
    `⏰ ${new Date(request.created_date).toLocaleString('it-IT')}`;

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
        text: '🔍 Verifica Wallet', 
        url: `https://polygonscan.com/address/${request.wallet_address}` 
      }
    ]);
  }

  try {
    await bot.sendMessage(ADMIN_CHAT_ID, message, { 
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('❌ Error sending notification:', error.message);
  }
}

// ============================================
// GESTIONE CALLBACK BOTTONI
// ============================================
bot.on('callback_query', async (query) => {
  const data = query.data;
  const [action, requestId] = data.split('_');

  console.log(`🔘 Button clicked: ${action} for request ${requestId}`);

  if (action === 'approve') {
    const success = await approveWithdrawal(requestId);
    
    if (success) {
      await bot.answerCallbackQuery(query.id, { text: '✅ Prelievo approvato!' });
      await bot.editMessageText(
        query.message.text + '\n\n✅ *APPROVATO* - Invia manualmente i token dal vault!', 
        {
          chat_id: ADMIN_CHAT_ID,
          message_id: query.message.message_id,
          parse_mode: 'Markdown'
        }
      );
    } else {
      await bot.answerCallbackQuery(query.id, { text: '❌ Errore approvazione!' });
    }
    
  } else if (action === 'reject') {
    const success = await rejectRequest(requestId);
    
    if (success) {
      await bot.answerCallbackQuery(query.id, { text: '❌ Prelievo rifiutato!' });
      await bot.editMessageText(
        query.message.text + '\n\n❌ *RIFIUTATO*', 
        {
          chat_id: ADMIN_CHAT_ID,
          message_id: query.message.message_id,
          parse_mode: 'Markdown'
        }
      );
    } else {
      await bot.answerCallbackQuery(query.id, { text: '❌ Errore rifiuto!' });
    }
  }
});

// ============================================
// APPROVA PRELIEVO
// ============================================
async function approveWithdrawal(requestId) {
  try {
    console.log(`⏳ Approving withdrawal ${requestId}...`);

    const reqResponse = await axios.get(
      `${BASE44_API}/DepositRequest/${requestId}`,
      {
        headers: {
          'api_key': BASE44_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );

    const request = reqResponse.data;

    const balanceResponse = await axios.get(
      `${BASE44_API}/TokenBalance`,
      {
        headers: {
          'api_key': BASE44_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );

    const balances = balanceResponse.data;
    const userBalance = balances.find(b => b.user_email === request.user_email);

    if (!userBalance || userBalance.balance < request.amount) {
      console.log('⚠️ Insufficient balance');
      await bot.sendMessage(ADMIN_CHAT_ID, 
        `⚠️ Balance insufficiente per ${request.user_email}!\n` +
        `Richiesto: ${request.amount}\n` +
        `Disponibile: ${userBalance?.balance || 0}`
      );
      return false;
    }

    // Sottrai balance
    await axios.put(
      `${BASE44_API}/TokenBalance/${userBalance.id}`,
      {
        balance: userBalance.balance - request.amount
      },
      {
        headers: {
          'api_key': BASE44_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );

    // Approva richiesta
    await axios.put(
      `${BASE44_API}/DepositRequest/${requestId}`,
      {
        status: 'approved'
      },
      {
        headers: {
          'api_key': BASE44_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );

    await bot.sendMessage(ADMIN_CHAT_ID,
      `📤 *AZIONE RICHIESTA*\n\n` +
      `Invia manualmente dal vault:\n` +
      `💰 Amount: ${request.amount} $ROBOT\n` +
      `📍 To: \`${request.wallet_address}\`\n\n` +
      `✅ Balance già sottratto dal database`,
      { parse_mode: 'Markdown' }
    );

    console.log(`✅ Withdrawal ${requestId} approved`);
    return true;

  } catch (error) {
    console.error('❌ Error approving withdrawal:', error.message);
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
        },
        timeout: 5000
      }
    );

    console.log(`❌ Request ${requestId} rejected`);
    return true;

  } catch (error) {
    console.error('❌ Error rejecting:', error.message);
    return false;
  }
}

// ============================================
// COMANDI TELEGRAM
// ============================================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  
  await bot.sendMessage(chatId,
    `🤖 *Bot Futuro Umanoide + Vault System*\n\n` +
    `✅ Bot attivo e operativo\n` +
    `🏦 Vault: \`${VAULT_ADDRESS}\`\n\n` +
    `Comandi disponibili:\n` +
    `/status - Info bot\n` +
    `/vault - Info vault\n` +
    `/stats - Statistiche`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (chatId.toString() !== ADMIN_CHAT_ID) return;

  const statusMessage = 
    `📊 *STATUS BOT*\n\n` +
    `✅ Bot attivo\n` +
    `⏰ Check ogni 30s\n` +
    `🏦 Vault: \`${VAULT_ADDRESS}\`\n` +
    `📋 TX cache: ${processedTransactions.size}\n` +
    `📦 Last block: ${lastCheckedBlock}`;

  await bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/vault/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (chatId.toString() !== ADMIN_CHAT_ID) return;

  await bot.sendMessage(chatId,
    `🏦 *INFO VAULT*\n\n` +
    `📍 Address:\n\`${VAULT_ADDRESS}\`\n\n` +
    `🪙 Token: $ROBOT\n` +
    `🔗 [Verifica PolygonScan](https://polygonscan.com/address/${VAULT_ADDRESS})`,
    { parse_mode: 'Markdown', disable_web_page_preview: true }
  );
});

bot.onText(/\/clear/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (chatId.toString() !== ADMIN_CHAT_ID) return;

  const count = processedTransactions.size;
  processedTransactions.clear();
  await bot.sendMessage(chatId, `🗑️ Cache cleared! (${count} TX removed)`);
});

// ============================================
// HEALTH CHECK ENDPOINT
// ============================================
app.get('/', (req, res) => {
  res.send('🤖 Bot Futuro Umanoide + Vault System - Active!');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    vault: VAULT_ADDRESS,
    processed_tx: processedTransactions.size,
    last_block: lastCheckedBlock,
    uptime: process.uptime()
  });
});

// ============================================
// AVVIO
// ============================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('');
  console.log('🚀 ================================');
  console.log('🤖 BOT ACTIVE!');
  console.log('🚀 ================================');
  console.log(`📡 HTTP Server: ${PORT}`);
  console.log(`🏦 Vault: ${VAULT_ADDRESS}`);
  console.log(`⏰ Check interval: ${CHECK_INTERVAL/1000}s`);
  console.log(`📊 API: No key needed (free tier)`);
  console.log('');
  
  // Start monitoring
  setInterval(checkVaultDeposits, CHECK_INTERVAL);
  setInterval(checkPendingWithdrawals, CHECK_INTERVAL);
  
  // Initial check
  setTimeout(() => {
    checkVaultDeposits();
    checkPendingWithdrawals();
  }, 5000);
  
  bot.sendMessage(ADMIN_CHAT_ID, 
    '🤖 *Bot + Vault System Avviato!*\n\n' +
    '✅ Depositi automatici attivi\n' +
    '✅ Prelievi notificati\n' +
    '✅ Nessuna API key richiesta\n\n' +
    'Usa /vault per info',
    { parse_mode: 'Markdown' }
  ).catch(err => console.log('⚠️ Start conversation with bot first'));
});

bot.on('polling_error', (error) => {
  console.error('❌ Polling error:', error.code);
});

process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully...');
  bot.stopPolling();
  process.exit(0);
});
