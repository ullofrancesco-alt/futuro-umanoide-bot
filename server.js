const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cron = require('node-cron');
const { ethers } = require('ethers');
require('dotenv').config();

// ============================================
// CONFIGURAZIONE
// ============================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8239600520:AAHMVAEsUu3Hdd4vD4KFH4KW48a-Q5WBsqY';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '585681146';

// Base44 API
const BASE44_API = 'https://app.base44.com/api/apps/690e1a0262a871b277571301/entities';
const BASE44_API_KEY = '601a9651d7f9433d92341d73eb30398b';

// Blockchain
const VAULT_ADDRESS = '0x78cFdE6e71Cf5cED4afFce5578D2223b51907a49';
const ROBOT_TOKEN_ADDRESS = '0xb0d2A7b1F1EC7D39409E1D671473020d20547B55';
const USDC_CONTRACT = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;

const CHECK_INTERVAL = 30000;

// ============================================
// INIZIALIZZAZIONE
// ============================================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const app = express();
const processedTransactions = new Set();
let lastCheckedBlock = 0;

console.log('🤖 Initializing Futuro Umanoide Backend v2.2...');
console.log('🏦 Vault Address:', VAULT_ADDRESS);
console.log('💰 USDC Contract:', USDC_CONTRACT);

// ============================================
// ✨ MONITORA SWAP USDC → $BOT
// ============================================
async function checkPendingSwaps() {
  try {
    console.log('💱 Checking pending USDC → $BOT swaps...');
    
    const response = await axios.get(`${BASE44_API}/DepositRequest`, {
      headers: { 'api_key': BASE44_API_KEY, 'Content-Type': 'application/json' },
      timeout: 10000
    });

    const requests = response.data;
    const pendingSwaps = requests.filter(r => 
      r.request_type === 'swap' && 
      r.status === 'pending' &&
      !processedTransactions.has(`swap_${r.id}`)
    );

    if (pendingSwaps.length === 0) {
      console.log('📭 No pending USDC → $BOT swaps');
      return;
    }

    console.log(`💱 Found ${pendingSwaps.length} pending USDC → $BOT swaps`);

    for (const swap of pendingSwaps) {
      await sendSwapNotification(swap);
      processedTransactions.add(`swap_${swap.id}`);
    }

  } catch (error) {
    console.error('❌ Error checking swaps:', error.message);
  }
}

async function sendSwapNotification(request) {
  const message = 
    `🔔 *SWAP USDC → $BOT* 💰\n\n` +
    `👤 Utente: ${request.user_email}\n` +
    `💵 USDC inviati: ${request.amount} USDC\n` +
    `🤖 $BOT da accreditare: ${request.bot_amount} $BOT\n` +
    `📊 Tasso: 1 USDC = ${request.exchange_rate} $BOT\n` +
    `📍 Wallet: \`${request.wallet_address || 'N/A'}\`\n` +
    `🆔 ID: ${request.id}\n\n` +
    `⏰ ${new Date(request.created_date).toLocaleString('it-IT')}\n\n` +
    `🔗 Verifica TX: \`${request.tx_hash}\``;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Approva Swap', callback_data: `approveswap_${request.id}` },
        { text: '❌ Rifiuta', callback_data: `rejectswap_${request.id}` }
      ],
      [
        { text: '🔍 Verifica TX su PolygonScan', url: `https://polygonscan.com/tx/${request.tx_hash}` }
      ]
    ]
  };

  try {
    await bot.sendMessage(ADMIN_CHAT_ID, message, { reply_markup: keyboard, parse_mode: 'Markdown' });
    console.log(`✅ USDC → $BOT swap notification sent for ${request.user_email}`);
  } catch (error) {
    console.error('❌ Error sending swap notification:', error.message);
  }
}

// ============================================
// ✨ NUOVO: MONITORA SWAP $BOT → USDC
// ============================================
async function checkPendingReverseSwaps() {
  try {
    console.log('💸 Checking pending $BOT → USDC swaps...');
    
    const response = await axios.get(`${BASE44_API}/DepositRequest`, {
      headers: { 'api_key': BASE44_API_KEY, 'Content-Type': 'application/json' },
      timeout: 10000
    });

    const requests = response.data;
    const pendingReverseSwaps = requests.filter(r => 
      r.request_type === 'swap_reverse' && 
      r.status === 'pending' &&
      !processedTransactions.has(`swap_reverse_${r.id}`)
    );

    if (pendingReverseSwaps.length === 0) {
      console.log('📭 No pending $BOT → USDC swaps');
      return;
    }

    console.log(`💸 Found ${pendingReverseSwaps.length} pending $BOT → USDC swaps`);

    for (const swap of pendingReverseSwaps) {
      await sendReverseSwapNotification(swap);
      processedTransactions.add(`swap_reverse_${swap.id}`);
    }

  } catch (error) {
    console.error('❌ Error checking reverse swaps:', error.message);
  }
}

async function sendReverseSwapNotification(request) {
  const message = 
    `🔔 *SWAP $BOT → USDC* 💸\n\n` +
    `👤 Utente: ${request.user_email}\n` +
    `🤖 $BOT venduti: ${request.amount} $BOT\n` +
    `💵 USDC da inviare: ${request.usdc_amount} USDC\n` +
    `📊 Tasso: 100 $BOT = 1 USDC\n` +
    `📍 Wallet: \`${request.wallet_address || 'N/A'}\`\n` +
    `🆔 ID: ${request.id}\n\n` +
    `⏰ ${new Date(request.created_date).toLocaleString('it-IT')}\n\n` +
    `💡 Balance utente GIÀ sottratto!`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Approva & Invia USDC', callback_data: `approvereverseswap_${request.id}` },
        { text: '❌ Rifiuta & Rimborsa', callback_data: `rejectreverseswap_${request.id}` }
      ],
      [
        { text: '🔍 Verifica Wallet', url: `https://polygonscan.com/address/${request.wallet_address}` }
      ]
    ]
  };

  try {
    await bot.sendMessage(ADMIN_CHAT_ID, message, { reply_markup: keyboard, parse_mode: 'Markdown' });
    console.log(`✅ $BOT → USDC swap notification sent for ${request.user_email}`);
  } catch (error) {
    console.error('❌ Error sending reverse swap notification:', error.message);
  }
}

// ============================================
// ✨ PROCESSO AUTOMATICO SWAP $BOT → USDC
// ============================================
async function processReverseSwaps() {
  try {
    if (!ADMIN_PRIVATE_KEY) {
      console.log('⚠️ ADMIN_PRIVATE_KEY non configurata - reverse swaps manuali');
      return;
    }

    const requestsResponse = await axios.get(`${BASE44_API}/DepositRequest`, {
      headers: { 'api_key': BASE44_API_KEY },
      timeout: 10000
    });

    const requests = requestsResponse.data;
    const approvedReverseSwaps = requests.filter(r => 
      r.request_type === 'swap_reverse' &&
      r.status === 'approved' &&
      !r.processed
    );

    if (approvedReverseSwaps.length === 0) return;

    console.log(`💸 [REVERSE SWAP] Trovate ${approvedReverseSwaps.length} richieste approvate`);

    const provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
    const adminWallet = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);
    
    const ERC20_ABI = [
      'function transfer(address to, uint256 amount) returns (bool)',
      'function balanceOf(address owner) view returns (uint256)'
    ];

    const usdcContract = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, adminWallet);

    for (const req of approvedReverseSwaps) {
      try {
        console.log(`📤 Invio ${req.usdc_amount} USDC a ${req.wallet_address}...`);

        const amountWei = ethers.parseUnits(req.usdc_amount.toString(), 6); // USDC = 6 decimali!
        const adminBalance = await usdcContract.balanceOf(adminWallet.address);

        if (adminBalance < amountWei) {
          console.error(`❌ Saldo USDC vault insufficiente!`);
          await bot.sendMessage(ADMIN_CHAT_ID,
            `❌ *SALDO USDC VAULT INSUFFICIENTE*\n\n` +
            `Richiesto: ${req.usdc_amount} USDC\n` +
            `User: ${req.user_email}\n\n` +
            `⚠️ Ricarica USDC nel vault!`
          );
          continue;
        }

        const tx = await usdcContract.transfer(req.wallet_address, amountWei);
        console.log(`⏳ TX inviata: ${tx.hash}`);
        
        await tx.wait();
        console.log(`✅ TX confermata!`);

        await axios.put(
          `${BASE44_API}/DepositRequest/${req.id}`,
          { processed: true, tx_hash: tx.hash, admin_notes: `Auto-processed. TX: ${tx.hash}` },
          { headers: { 'api_key': BASE44_API_KEY }, timeout: 5000 }
        );

        await bot.sendMessage(ADMIN_CHAT_ID,
          `✅ *SWAP $BOT → USDC COMPLETATO*\n\n` +
          `👤 User: ${req.user_email}\n` +
          `💰 USDC inviati: ${req.usdc_amount} USDC\n` +
          `🤖 $BOT bruciati: ${req.amount} $BOT\n` +
          `📍 To: \`${req.wallet_address}\`\n` +
          `🔗 [TX](https://polygonscan.com/tx/${tx.hash})`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        );

        console.log(`✅ [REVERSE SWAP] Completato per ${req.user_email}`);

      } catch (error) {
        console.error(`❌ Errore reverse swap ${req.id}:`, error.message);
        
        await axios.put(
          `${BASE44_API}/DepositRequest/${req.id}`,
          { admin_notes: `Error: ${error.message}` },
          { headers: { 'api_key': BASE44_API_KEY } }
        );

        await bot.sendMessage(ADMIN_CHAT_ID,
          `❌ *ERRORE SWAP $BOT → USDC*\n\n` +
          `User: ${req.user_email}\n` +
          `Error: ${error.message}\n\n` +
          `⚠️ Verifica manualmente!`
        );
      }
    }

  } catch (error) {
    console.error('❌ [REVERSE SWAP] Errore generale:', error.message);
  }
}

// ... keep existing code (checkVaultDeposits, findUserByWallet, processAutoDeposit, cron jobs, withdrawals, etc.) ...

// ============================================
// CALLBACK BOTTONI TELEGRAM (AGGIORNATO)
// ============================================
bot.on('callback_query', async (query) => {
  const data = query.data;
  const parts = data.split('_');
  const action = parts[0];
  const requestId = parts.slice(1).join('_'); // Fix per ID con underscore

  console.log(`🔘 Button clicked: ${action} for request ${requestId}`);

  if (action === 'approveswap') {
    const success = await approveSwap(requestId);
    if (success) {
      await bot.answerCallbackQuery(query.id, { text: '✅ Swap approvato! $BOT accreditati' });
      await bot.editMessageText(query.message.text + '\n\n✅ *SWAP APPROVATO*', {
        chat_id: ADMIN_CHAT_ID,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      });
    } else {
      await bot.answerCallbackQuery(query.id, { text: '❌ Errore!' });
    }
  } else if (action === 'rejectswap') {
    const success = await rejectRequest(requestId);
    if (success) {
      await bot.answerCallbackQuery(query.id, { text: '❌ Rifiutato!' });
      await bot.editMessageText(query.message.text + '\n\n❌ *RIFIUTATO*', {
        chat_id: ADMIN_CHAT_ID,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      });
    } else {
      await bot.answerCallbackQuery(query.id, { text: '❌ Errore!' });
    }
  } else if (action === 'approvereverseswap') {
    const success = await approveReverseSwap(requestId);
    if (success) {
      await bot.answerCallbackQuery(query.id, { text: '✅ Approvato! USDC saranno inviati automaticamente' });
      await bot.editMessageText(query.message.text + '\n\n✅ *APPROVATO* - USDC in invio!', {
        chat_id: ADMIN_CHAT_ID,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      });
    } else {
      await bot.answerCallbackQuery(query.id, { text: '❌ Errore!' });
    }
  } else if (action === 'rejectreverseswap') {
    const success = await rejectReverseSwap(requestId);
    if (success) {
      await bot.answerCallbackQuery(query.id, { text: '❌ Rifiutato! $BOT rimborsati' });
      await bot.editMessageText(query.message.text + '\n\n❌ *RIFIUTATO* - $BOT rimborsati', {
        chat_id: ADMIN_CHAT_ID,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      });
    } else {
      await bot.answerCallbackQuery(query.id, { text: '❌ Errore!' });
    }
  } else if (action === 'approve') {
    const success = await approveWithdrawal(requestId);
    if (success) {
      await bot.answerCallbackQuery(query.id, { text: '✅ Approvato!' });
      await bot.editMessageText(query.message.text + '\n\n✅ *APPROVATO*', {
        chat_id: ADMIN_CHAT_ID,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      });
    } else {
      await bot.answerCallbackQuery(query.id, { text: '❌ Errore!' });
    }
  } else if (action === 'reject') {
    const success = await rejectRequest(requestId);
    if (success) {
      await bot.answerCallbackQuery(query.id, { text: '❌ Rifiutato!' });
      await bot.editMessageText(query.message.text + '\n\n❌ *RIFIUTATO*', {
        chat_id: ADMIN_CHAT_ID,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      });
    } else {
      await bot.answerCallbackQuery(query.id, { text: '❌ Errore!' });
    }
  }
});

async function approveSwap(requestId) {
  try {
    console.log(`⏳ Approving USDC → $BOT swap ${requestId}...`);
    const reqResponse = await axios.get(`${BASE44_API}/DepositRequest/${requestId}`, {
      headers: { 'api_key': BASE44_API_KEY },
      timeout: 5000
    });
    const request = reqResponse.data;
    const balanceResponse = await axios.get(`${BASE44_API}/TokenBalance`, {
      headers: { 'api_key': BASE44_API_KEY },
      timeout: 5000
    });
    const balances = balanceResponse.data;
    const userBalance = balances.find(b => b.user_email === request.user_email);
    if (userBalance) {
      await axios.put(
        `${BASE44_API}/TokenBalance/${userBalance.id}`,
        { balance: userBalance.balance + request.bot_amount, total_deposited: (userBalance.total_deposited || 0) + request.bot_amount },
        { headers: { 'api_key': BASE44_API_KEY }, timeout: 5000 }
      );
    } else {
      await axios.post(
        `${BASE44_API}/TokenBalance`,
        {
          user_email: request.user_email,
          wallet_address: request.wallet_address,
          balance: 1000 + request.bot_amount,
          total_deposited: request.bot_amount,
          total_won: 0,
          total_lost: 0,
          total_bets: 0
        },
        { headers: { 'api_key': BASE44_API_KEY }, timeout: 5000 }
      );
    }
    await axios.put(
      `${BASE44_API}/DepositRequest/${requestId}`,
      { status: 'approved', processed: true },
      { headers: { 'api_key': BASE44_API_KEY }, timeout: 5000 }
    );
    console.log(`✅ USDC → $BOT swap ${requestId} approved`);
    return true;
  } catch (error) {
    console.error('❌ Error approving swap:', error.message);
    return false;
  }
}

async function approveReverseSwap(requestId) {
  try {
    console.log(`⏳ Approving $BOT → USDC swap ${requestId}...`);
    await axios.put(
      `${BASE44_API}/DepositRequest/${requestId}`,
      { status: 'approved' },
      { headers: { 'api_key': BASE44_API_KEY }, timeout: 5000 }
    );
    console.log(`✅ $BOT → USDC swap ${requestId} approved - USDC will be sent automatically`);
    return true;
  } catch (error) {
    console.error('❌ Error approving reverse swap:', error.message);
    return false;
  }
}

async function rejectReverseSwap(requestId) {
  try {
    console.log(`⏳ Rejecting $BOT → USDC swap ${requestId}...`);
    const reqResponse = await axios.get(`${BASE44_API}/DepositRequest/${requestId}`, {
      headers: { 'api_key': BASE44_API_KEY },
      timeout: 5000
    });
    const request = reqResponse.data;
    
    // Rimborsa $BOT
    const balanceResponse = await axios.get(`${BASE44_API}/TokenBalance`, {
      headers: { 'api_key': BASE44_API_KEY },
      timeout: 5000
    });
    const balances = balanceResponse.data;
    const userBalance = balances.find(b => b.user_email === request.user_email);
    
    if (userBalance) {
      await axios.put(
        `${BASE44_API}/TokenBalance/${userBalance.id}`,
        { balance: userBalance.balance + request.amount },
        { headers: { 'api_key': BASE44_API_KEY }, timeout: 5000 }
      );
    }
    
    await axios.put(
      `${BASE44_API}/DepositRequest/${requestId}`,
      { status: 'rejected', admin_notes: '$BOT refunded to user' },
      { headers: { 'api_key': BASE44_API_KEY }, timeout: 5000 }
    );
    console.log(`❌ $BOT → USDC swap ${requestId} rejected - $BOT refunded`);
    return true;
  } catch (error) {
    console.error('❌ Error rejecting reverse swap:', error.message);
    return false;
  }
}

// ... keep existing code (approveWithdrawal, rejectRequest, telegram commands, health check, cron, startup) ...

// ============================================
// AVVIO
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('🚀 ================================');
  console.log('🤖 FUTURO UMANOIDE BACKEND V2.2');
  console.log('🚀 ================================');
  console.log(`📡 HTTP Server: ${PORT}`);
  console.log(`🏦 Vault: ${VAULT_ADDRESS}`);
  console.log(`💰 USDC: ${USDC_CONTRACT}`);
  console.log(`⏰ Check interval: ${CHECK_INTERVAL/1000}s`);
  console.log(`💸 Auto-withdrawals: ${ADMIN_PRIVATE_KEY ? '✅' : '❌'}`);
  console.log('');
  setupCronJobs();
  setInterval(checkVaultDeposits, CHECK_INTERVAL);
  setInterval(checkPendingWithdrawals, CHECK_INTERVAL);
  setInterval(checkPendingSwaps, CHECK_INTERVAL);
  setInterval(checkPendingReverseSwaps, CHECK_INTERVAL); // ✨ NUOVO
  setInterval(processWithdrawals, 60000);
  setInterval(processReverseSwaps, 60000); // ✨ NUOVO
  setTimeout(() => {
    checkVaultDeposits();
    checkPendingWithdrawals();
    checkPendingSwaps();
    checkPendingReverseSwaps(); // ✨ NUOVO
    processWithdrawals();
    processReverseSwaps(); // ✨ NUOVO
  }, 5000);
  bot.sendMessage(ADMIN_CHAT_ID, '🤖 *Backend v2.2 Avviato!*\n\n✅ USDC → $BOT\n✅ $BOT → USDC\n✅ Withdrawals automatici\n✅ Cron betting\n\nSistema 100% automatico!', { parse_mode: 'Markdown' }).catch(err => console.log('⚠️ Start conversation with bot first'));
});

bot.on('polling_error', (error) => { console.error('❌ Polling error:', error.code); });
process.on('SIGTERM', () => { console.log('👋 Shutting down...'); bot.stopPolling(); process.exit(0); });
