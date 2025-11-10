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

const CHECK_INTERVAL = 30000; // 30 secondi

// ============================================
// INIZIALIZZAZIONE
// ============================================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const app = express();
const processedTransactions = new Set();
let lastCheckedBlock = 0;

console.log('🤖 Initializing Futuro Umanoide Backend v2.1...');
console.log('🏦 Vault Address:', VAULT_ADDRESS);
console.log('💰 USDC Contract:', USDC_CONTRACT);

// ============================================
// ✨ NUOVO: Monitora Swap USDC → $BOT
// ============================================
async function checkPendingSwaps() {
  try {
    console.log('💱 Checking pending USDC swaps...');
    
    const response = await axios.get(`${BASE44_API}/DepositRequest`, {
      headers: {
        'api_key': BASE44_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    const requests = response.data;
    const pendingSwaps = requests.filter(r => 
      r.request_type === 'swap' && 
      r.status === 'pending' &&
      !processedTransactions.has(`swap_${r.id}`)
    );

    if (pendingSwaps.length === 0) {
      console.log('📭 No pending swaps');
      return;
    }

    console.log(`💱 Found ${pendingSwaps.length} pending swaps`);

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
        { 
          text: '🔍 Verifica TX su PolygonScan', 
          url: `https://polygonscan.com/tx/${request.tx_hash}` 
        }
      ]
    ]
  };

  try {
    await bot.sendMessage(ADMIN_CHAT_ID, message, { 
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    });
    console.log(`✅ Swap notification sent for ${request.user_email}`);
  } catch (error) {
    console.error('❌ Error sending swap notification:', error.message);
  }
}

// ============================================
// FUNZIONE: Monitora Depositi $BOT (ESISTENTE)
// ============================================
async function checkVaultDeposits() {
  try {
    console.log('🔍 Checking vault deposits...');
    
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

    if (transactions.length > 0) {
      const latestBlock = Math.max(...transactions.map(tx => parseInt(tx.blockNumber)));
      if (latestBlock > lastCheckedBlock) {
        lastCheckedBlock = latestBlock;
      }
    }

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
      const amount = parseFloat(tx.value) / 1e18;
      const txHash = tx.hash;
      const blockNumber = tx.blockNumber;

      console.log(`\n💵 New deposit:`);
      console.log(`   From: ${senderAddress}`);
      console.log(`   Amount: ${amount} $BOT`);
      console.log(`   TX: ${txHash.slice(0, 10)}...`);

      const userEmail = await findUserByWallet(senderAddress);

      if (userEmail) {
        console.log(`   ✅ User found: ${userEmail}`);
        await processAutoDeposit(userEmail, senderAddress, amount, txHash);
      } else {
        console.log(`   ⚠️ Unknown wallet - notifying admin`);
        await bot.sendMessage(ADMIN_CHAT_ID,
          `⚠️ *DEPOSITO DA WALLET SCONOSCIUTO*\n\n` +
          `💰 Importo: ${amount} $BOT\n` +
          `📍 From: \`${senderAddress}\`\n` +
          `📦 Block: ${blockNumber}\n` +
          `🔗 [Verifica TX](https://polygonscan.com/tx/${txHash})\n\n` +
          `❓ Wallet non associato - chiedi all'utente di collegarlo`,
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

async function findUserByWallet(walletAddress) {
  try {
    const balanceResponse = await axios.get(`${BASE44_API}/TokenBalance`, {
      headers: {
        'api_key': BASE44_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });

    const balances = balanceResponse.data;
    const matchingBalance = balances.find(b => 
      b.wallet_address && 
      b.wallet_address.toLowerCase() === walletAddress.toLowerCase()
    );

    if (matchingBalance) {
      return matchingBalance.user_email;
    }

    const requestResponse = await axios.get(`${BASE44_API}/DepositRequest`, {
      headers: {
        'api_key': BASE44_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });

    const requests = requestResponse.data;
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

async function processAutoDeposit(userEmail, walletAddress, amount, txHash) {
  try {
    console.log(`   🔄 Processing auto-deposit for ${userEmail}`);

    const balanceResponse = await axios.get(`${BASE44_API}/TokenBalance`, {
      headers: {
        'api_key': BASE44_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });

    const balances = balanceResponse.data;
    const userBalance = balances.find(b => b.user_email === userEmail);

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
          wallet_address: walletAddress,
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
      console.log(`   💰 New balance created: ${1000 + amount} $BOT`);
    }

    await axios.post(
      `${BASE44_API}/DepositRequest`,
      {
        user_email: userEmail,
        wallet_address: walletAddress,
        amount: amount,
        status: 'approved',
        request_type: 'deposit',
        processed: true,
        tx_hash: txHash,
        admin_notes: `Auto-approved by blockchain listener - TX: ${txHash}`
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
      `✅ *DEPOSITO AUTO-APPROVATO*\n\n` +
      `👤 Utente: ${userEmail}\n` +
      `💰 Importo: ${amount} $BOT\n` +
      `📍 Wallet: \`${walletAddress}\`\n` +
      `🔗 [Verifica TX](https://polygonscan.com/tx/${txHash})\n\n` +
      `✨ Saldo aggiornato automaticamente!`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );

    console.log(`   ✅ Auto-deposit completed!`);
    return true;

  } catch (error) {
    console.error('   ❌ Error processing auto-deposit:', error.message);
    
    await bot.sendMessage(ADMIN_CHAT_ID,
      `❌ *ERRORE AUTO-DEPOSITO*\n\n` +
      `User: ${userEmail}\n` +
      `Amount: ${amount} $BOT\n` +
      `Error: ${error.message}\n\n` +
      `⚠️ Approva manualmente!`
    ).catch(e => console.error('Failed to send error notification'));
    
    return false;
  }
}

// ============================================
// Cron Jobs, Withdrawals, etc. (RESTO DEL CODICE)
// ============================================
async function createDailyPool() {
  console.log('🎯 [CRON] Creazione pool giornaliero...');
  try {
    const now = new Date();
    const closesAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const response = await axios.post(
      `${BASE44_API}/BettingMarket`,
      {
        title: "Chi sarà il protagonista del prossimo prompt?",
        description: "Scommetti se il prossimo prompt pubblicato riguarderà un grande player (Tesla, Unitree) o uno sviluppatore medio-piccolo della community",
        option_a: "Grande Player (Tesla, Unitree, Meta, ecc.)",
        option_b: "Sviluppatore Medio-Piccolo / Community",
        status: "active",
        opens_at: now.toISOString(),
        closes_at: closesAt.toISOString(),
        total_back_a: 0,
        total_lay_a: 0,
        total_back_b: 0,
        total_lay_b: 0
      },
      {
        headers: { 'api_key': BASE44_API_KEY, 'Content-Type': 'application/json' },
        timeout: 10000
      }
    );
    console.log('✅ [CRON] Pool creato:', response.data.id);
    await bot.sendMessage(ADMIN_CHAT_ID,
      `🎯 *POOL GIORNALIERO CREATO*\n\n📅 Chiusura: ${closesAt.toLocaleString('it-IT')}\n⏰ Risoluzione automatica tra 24h`,
      { parse_mode: 'Markdown' }
    );
    return response.data;
  } catch (error) {
    console.error('❌ [CRON] Errore creazione pool:', error.message);
    await bot.sendMessage(ADMIN_CHAT_ID, `❌ Errore creazione pool: ${error.message}`);
    throw error;
  }
}

async function resolveAndPublish() {
  console.log('🤖 [CRON] Risoluzione pool + pubblicazione...');
  try {
    const convoResponse = await axios.get(`${BASE44_API}/Conversation`, {
      headers: { 'api_key': BASE44_API_KEY },
      timeout: 10000
    });
    const conversations = convoResponse.data;
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentConvos = conversations.filter(c => {
      const convoDate = new Date(c.created_date);
      return convoDate > last24h && (c.relevance_score >= 70 || c.practical_value >= 70);
    });
    if (recentConvos.length === 0) {
      console.log('⚠️ Nessuna conversazione di qualità');
      await bot.sendMessage(ADMIN_CHAT_ID, '⚠️ Nessuna conversazione nelle ultime 24h - pool non risolto');
      return;
    }
    const bestConvo = recentConvos.sort((a, b) => 
      Math.max(b.relevance_score, b.practical_value) - Math.max(a.relevance_score, a.practical_value)
    )[0];
    const industryCategories = ['tesla_optimus', 'unitree_robots', 'meta_ai', 'industry_news', 'breakthrough_tech'];
    const winner = industryCategories.includes(bestConvo.category) ? 'A' : 'B';
    console.log(`🏆 Best convo selected. Winner: Option ${winner}`);
    const today = new Date().toISOString().split('T')[0];
    await axios.post(
      `${BASE44_API}/DailyHighlight`,
      {
        date: today,
        conversation_id: bestConvo.id,
        category: bestConvo.category,
        difficulty_level: bestConvo.difficulty_level || "intermediate",
        title: bestConvo.user_message.substring(0, 80),
        summary: bestConvo.ai_response.substring(0, 200),
        impact_score: Math.max(bestConvo.relevance_score, bestConvo.practical_value),
        user_message: bestConvo.user_message,
        ai_response: bestConvo.ai_response,
        language: bestConvo.language || "it",
        acceleration_days: 1,
        practical_value: bestConvo.practical_value || 0,
        actionable_steps: bestConvo.key_insights || []
      },
      { headers: { 'api_key': BASE44_API_KEY }, timeout: 10000 }
    );
    console.log('✅ Highlight pubblicato');
    const marketsResponse = await axios.get(`${BASE44_API}/BettingMarket`, {
      headers: { 'api_key': BASE44_API_KEY },
      timeout: 10000
    });
    const markets = marketsResponse.data;
    const activePool = markets.find(m => m.status === 'active' && m.title.includes("protagonista"));
    if (!activePool) {
      console.log('⚠️ Nessun pool attivo');
      return;
    }
    const betsResponse = await axios.get(`${BASE44_API}/UserBet`, {
      headers: { 'api_key': BASE44_API_KEY },
      timeout: 10000
    });
    const allBets = betsResponse.data;
    const marketBets = allBets.filter(b => b.market_id === activePool.id);
    const winningBets = marketBets.filter(b => b.option === winner && b.bet_type === 'back');
    const totalBackA = activePool.total_back_a || 0;
    const totalBackB = activePool.total_back_b || 0;
    const winningPool = winner === 'A' ? totalBackA : totalBackB;
    const losingPool = winner === 'A' ? totalBackB : totalBackA;
    let totalPaid = 0;
    for (const bet of winningBets) {
      const winShare = (bet.amount / winningPool) * losingPool;
      const totalPayout = bet.amount + winShare;
      await axios.put(
        `${BASE44_API}/UserBet/${bet.id}`,
        { status: "won", payout: totalPayout },
        { headers: { 'api_key': BASE44_API_KEY }, timeout: 5000 }
      );
      const balances = (await axios.get(`${BASE44_API}/TokenBalance`, {
        headers: { 'api_key': BASE44_API_KEY }
      })).data;
      const userBalance = balances.find(b => b.user_email === bet.user_email);
      if (userBalance) {
        await axios.put(
          `${BASE44_API}/TokenBalance/${userBalance.id}`,
          { balance: userBalance.balance + totalPayout, total_won: userBalance.total_won + winShare },
          { headers: { 'api_key': BASE44_API_KEY }, timeout: 5000 }
        );
      }
      totalPaid += winShare;
    }
    const losingBets = marketBets.filter(b => b.option !== winner || b.bet_type === 'lay');
    for (const bet of losingBets) {
      await axios.put(`${BASE44_API}/UserBet/${bet.id}`, { status: "lost" }, { headers: { 'api_key': BASE44_API_KEY }, timeout: 5000 });
    }
    await axios.put(
      `${BASE44_API}/BettingMarket/${activePool.id}`,
      { status: "resolved", winning_option: winner, resolved_at: new Date().toISOString() },
      { headers: { 'api_key': BASE44_API_KEY }, timeout: 5000 }
    );
    console.log(`✅ Pool risolto! Vincitore: Opzione ${winner}`);
    console.log(`💰 Pagati ${winningBets.length} vincitori (tot: ${totalPaid.toFixed(2)} $BOT)`);
    await bot.sendMessage(ADMIN_CHAT_ID,
      `✅ *POOL RISOLTO AUTOMATICAMENTE*\n\n🏆 Vincitore: Opzione ${winner}\n💰 Vincitori pagati: ${winningBets.length}\n💵 Totale distribuito: ${totalPaid.toFixed(2)} $BOT\n📊 Highlight pubblicato in timeline`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('❌ [CRON] Errore risoluzione:', error.message);
    await bot.sendMessage(ADMIN_CHAT_ID, `❌ Errore risoluzione pool: ${error.message}`);
  }
}

async function processWithdrawals() {
  try {
    if (!ADMIN_PRIVATE_KEY) {
      console.log('⚠️ ADMIN_PRIVATE_KEY non configurata - withdrawals manuali');
      return;
    }
    const requestsResponse = await axios.get(`${BASE44_API}/DepositRequest`, {
      headers: { 'api_key': BASE44_API_KEY },
      timeout: 10000
    });
    const requests = requestsResponse.data;
    const pendingWithdrawals = requests.filter(r => r.request_type === 'withdrawal' && r.status === 'approved' && !r.processed);
    if (pendingWithdrawals.length === 0) return;
    console.log(`💸 [WITHDRAWAL] Trovate ${pendingWithdrawals.length} richieste`);
    const provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
    const adminWallet = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);
    const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)', 'function balanceOf(address owner) view returns (uint256)'];
    const robotContract = new ethers.Contract(ROBOT_TOKEN_ADDRESS, ERC20_ABI, adminWallet);
    for (const req of pendingWithdrawals) {
      try {
        console.log(`📤 Invio ${req.amount} $BOT a ${req.wallet_address}...`);
        const amountWei = ethers.parseUnits(req.amount.toString(), 18);
        const adminBalance = await robotContract.balanceOf(adminWallet.address);
        if (adminBalance < amountWei) {
          console.error(`❌ Saldo admin insufficiente!`);
          await bot.sendMessage(ADMIN_CHAT_ID, `❌ *SALDO VAULT INSUFFICIENTE*\n\nRichiesto: ${req.amount} $BOT\nUser: ${req.user_email}`);
          continue;
        }
        const tx = await robotContract.transfer(req.wallet_address, amountWei);
        console.log(`⏳ TX inviata: ${tx.hash}`);
        await tx.wait();
        console.log(`✅ TX confermata!`);
        await axios.put(
          `${BASE44_API}/DepositRequest/${req.id}`,
          { processed: true, tx_hash: tx.hash, admin_notes: `Auto-processed. TX: ${tx.hash}` },
          { headers: { 'api_key': BASE44_API_KEY }, timeout: 5000 }
        );
        await bot.sendMessage(ADMIN_CHAT_ID,
          `✅ *PRELIEVO AUTOMATICO COMPLETATO*\n\n👤 User: ${req.user_email}\n💰 Amount: ${req.amount} $BOT\n📍 To: \`${req.wallet_address}\`\n🔗 [TX](https://polygonscan.com/tx/${tx.hash})`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        );
        console.log(`✅ [WITHDRAWAL] Completato per ${req.user_email}`);
      } catch (error) {
        console.error(`❌ Errore withdrawal ${req.id}:`, error.message);
        await axios.put(`${BASE44_API}/DepositRequest/${req.id}`, { admin_notes: `Error: ${error.message}` }, { headers: { 'api_key': BASE44_API_KEY } });
      }
    }
  } catch (error) {
    console.error('❌ [WITHDRAWAL] Errore generale:', error.message);
  }
}

async function checkPendingWithdrawals() {
  try {
    const response = await axios.get(`${BASE44_API}/DepositRequest`, {
      headers: { 'api_key': BASE44_API_KEY },
      timeout: 5000
    });
    const requests = response.data;
    const pendingWithdrawals = requests.filter(r => r.status === 'pending' && r.request_type === 'withdrawal' && !processedTransactions.has(`withdrawal_${r.id}`));
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

async function sendWithdrawalNotification(request) {
  const message = 
    `🔔 *RICHIESTA PRELIEVO* ⬆️\n\n` +
    `👤 Utente: ${request.user_email}\n` +
    `💰 Importo: ${request.amount} $BOT\n` +
    `📍 Wallet: \`${request.wallet_address || 'N/A'}\`\n` +
    `🆔 ID: ${request.id}\n\n` +
    `⏰ ${new Date(request.created_date).toLocaleString('it-IT')}`;
  const keyboard = {
    inline_keyboard: [[{ text: '✅ Approva', callback_data: `approve_${request.id}` }, { text: '❌ Rifiuta', callback_data: `reject_${request.id}` }]]
  };
  if (request.wallet_address) {
    keyboard.inline_keyboard.push([{ text: '🔍 Verifica Wallet', url: `https://polygonscan.com/address/${request.wallet_address}` }]);
  }
  try {
    await bot.sendMessage(ADMIN_CHAT_ID, message, { reply_markup: keyboard, parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Error sending notification:', error.message);
  }
}

// ============================================
// ✨ CALLBACK BOTTONI (CON SUPPORTO SWAP)
// ============================================
bot.on('callback_query', async (query) => {
  const data = query.data;
  const parts = data.split('_');
  const action = parts[0];
  const requestId = parts[1];
  console.log(`🔘 Button clicked: ${action} for request ${requestId}`);

  if (action === 'approveswap') {
    const success = await approveSwap(requestId);
    if (success) {
      await bot.answerCallbackQuery(query.id, { text: '✅ Swap approvato! $BOT accreditati' });
      await bot.editMessageText(query.message.text + '\n\n✅ *SWAP APPROVATO* - $BOT accreditati!', {
        chat_id: ADMIN_CHAT_ID,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      });
    } else {
      await bot.answerCallbackQuery(query.id, { text: '❌ Errore approvazione!' });
    }
  } else if (action === 'rejectswap') {
    const success = await rejectRequest(requestId);
    if (success) {
      await bot.answerCallbackQuery(query.id, { text: '❌ Swap rifiutato!' });
      await bot.editMessageText(query.message.text + '\n\n❌ *SWAP RIFIUTATO*', {
        chat_id: ADMIN_CHAT_ID,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      });
    } else {
      await bot.answerCallbackQuery(query.id, { text: '❌ Errore rifiuto!' });
    }
  } else if (action === 'approve') {
    const success = await approveWithdrawal(requestId);
    if (success) {
      await bot.answerCallbackQuery(query.id, { text: '✅ Prelievo approvato!' });
      await bot.editMessageText(query.message.text + '\n\n✅ *APPROVATO*', {
        chat_id: ADMIN_CHAT_ID,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      });
    } else {
      await bot.answerCallbackQuery(query.id, { text: '❌ Errore approvazione!' });
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
      await bot.answerCallbackQuery(query.id, { text: '❌ Errore rifiuto!' });
    }
  }
});

async function approveSwap(requestId) {
  try {
    console.log(`⏳ Approving swap ${requestId}...`);
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
    console.log(`✅ Swap ${requestId} approved - ${request.bot_amount} $BOT accreditati`);
    return true;
  } catch (error) {
    console.error('❌ Error approving swap:', error.message);
    return false;
  }
}

async function approveWithdrawal(requestId) {
  try {
    console.log(`⏳ Approving withdrawal ${requestId}...`);
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
    if (!userBalance || userBalance.balance < request.amount) {
      console.log('⚠️ Insufficient balance');
      await bot.sendMessage(ADMIN_CHAT_ID, `⚠️ Balance insufficiente per ${request.user_email}!\nRichiesto: ${request.amount}\nDisponibile: ${userBalance?.balance || 0}`);
      return false;
    }
    await axios.put(
      `${BASE44_API}/TokenBalance/${userBalance.id}`,
      { balance: userBalance.balance - request.amount },
      { headers: { 'api_key': BASE44_API_KEY }, timeout: 5000 }
    );
    await axios.put(
      `${BASE44_API}/DepositRequest/${requestId}`,
      { status: 'approved' },
      { headers: { 'api_key': BASE44_API_KEY }, timeout: 5000 }
    );
    console.log(`✅ Withdrawal ${requestId} approved`);
    return true;
  } catch (error) {
    console.error('❌ Error approving withdrawal:', error.message);
    return false;
  }
}

async function rejectRequest(requestId) {
  try {
    await axios.put(`${BASE44_API}/DepositRequest/${requestId}`, { status: 'rejected' }, { headers: { 'api_key': BASE44_API_KEY }, timeout: 5000 });
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
    `🤖 *Bot Futuro Umanoide v2.1*\n\n✅ Bot attivo\n🏦 Vault monitored\n💱 Swap USDC → $BOT\n🎯 Cron jobs attivi\n💸 Withdrawals automatici\n\nComandi:\n/status - Info sistema\n/vault - Info vault\n/pools - Info betting`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  if (chatId.toString() !== ADMIN_CHAT_ID) return;
  const statusMessage = 
    `📊 *STATUS SISTEMA v2.1*\n\n✅ Bot attivo\n✅ Depositi automatici\n✅ Swap USDC → $BOT\n✅ Withdrawal processor\n✅ Cron jobs attivi\n\n🏦 Vault: \`${VAULT_ADDRESS}\`\n💰 USDC: \`${USDC_CONTRACT}\`\n📋 TX cache: ${processedTransactions.size}\n📦 Last block: ${lastCheckedBlock}`;
  await bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/pools/, async (msg) => {
  const chatId = msg.chat.id;
  if (chatId.toString() !== ADMIN_CHAT_ID) return;
  await bot.sendMessage(chatId, `🎯 *BETTING POOLS*\n\n⏰ Creazione: 00:00 UTC\n⏰ Risoluzione: 12:00 UTC`, { parse_mode: 'Markdown' });
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/', (req, res) => {
  res.send('🤖 Futuro Umanoide Backend v2.1 - Active!');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.1',
    vault: VAULT_ADDRESS,
    usdc: USDC_CONTRACT,
    features: { telegram_bot: true, auto_deposits: true, usdc_swaps: true, auto_withdrawals: !!ADMIN_PRIVATE_KEY, cron_pools: true, cron_resolution: true },
    processed_tx: processedTransactions.size,
    last_block: lastCheckedBlock,
    uptime: process.uptime()
  });
});

// ============================================
// CRON SETUP
// ============================================
function setupCronJobs() {
  console.log('⏰ Setting up cron jobs...');
  cron.schedule('0 0 * * *', async () => { await createDailyPool(); });
  cron.schedule('0 12 * * *', async () => { await resolveAndPublish(); });
  console.log('✅ Cron jobs configurati');
}

// ============================================
// AVVIO
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('🚀 ================================');
  console.log('🤖 FUTURO UMANOIDE BACKEND V2.1');
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
  setInterval(checkPendingSwaps, CHECK_INTERVAL); // ✨ NUOVO!
  setInterval(processWithdrawals, 60000);
  setTimeout(() => {
    checkVaultDeposits();
    checkPendingWithdrawals();
    checkPendingSwaps(); // ✨ NUOVO!
    processWithdrawals();
  }, 5000);
  bot.sendMessage(ADMIN_CHAT_ID, '🤖 *Backend v2.1 Avviato!*\n\n✅ Depositi automatici\n✅ Swap USDC → $BOT\n✅ Withdrawals automatici\n✅ Cron betting pools\n✅ Telegram bot\n\nSistema completamente automatizzato!', { parse_mode: 'Markdown' }).catch(err => console.log('⚠️ Start conversation with bot first'));
});

bot.on('polling_error', (error) => { console.error('❌ Polling error:', error.code); });
process.on('SIGTERM', () => { console.log('👋 Shutting down...'); bot.stopPolling(); process.exit(0); });
