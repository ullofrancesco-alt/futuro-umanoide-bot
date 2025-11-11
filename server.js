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

// 🆕 AUTO-APPROVAL LIMITS (modificabili!)
const AUTO_APPROVE_MAX_DEPOSIT_USDC = parseFloat(process.env.AUTO_APPROVE_MAX_DEPOSIT_USDC || '100');
const AUTO_APPROVE_MAX_WITHDRAW_BOT = parseFloat(process.env.AUTO_APPROVE_MAX_WITHDRAW_BOT || '1000');
const AUTO_APPROVE_ENABLED = process.env.AUTO_APPROVE_ENABLED !== 'false';

const CHECK_INTERVAL = 30000;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 5000;

// ============================================
// INIZIALIZZAZIONE
// ============================================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const app = express();
const processedTransactions = new Set();
let lastCheckedBlock = 0;
let lastHealthCheck = Date.now();
let errorCount = 0;
let successCount = 0;

console.log('🤖 Initializing Futuro Umanoide Backend v3.0...');
console.log('🏦 Vault:', VAULT_ADDRESS);
console.log('💰 USDC:', USDC_CONTRACT);
console.log('🤖 Auto-Approve:', AUTO_APPROVE_ENABLED ? '✅ ENABLED' : '❌ DISABLED');
console.log('💵 Max Auto Deposit:', AUTO_APPROVE_MAX_DEPOSIT_USDC, 'USDC');
console.log('💸 Max Auto Withdraw:', AUTO_APPROVE_MAX_WITHDRAW_BOT, '$BOT');

// ============================================
// HELPER: RETRY CON BACKOFF
// ============================================
async function retryWithBackoff(fn, fnName, maxAttempts = RETRY_ATTEMPTS) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      console.error(`❌ [${fnName}] Attempt ${attempt}/${maxAttempts} failed:`, error.message);
      
      if (attempt === maxAttempts) {
        console.error(`💀 [${fnName}] MAX RETRIES REACHED`);
        errorCount++;
        
        try {
          await bot.sendMessage(ADMIN_CHAT_ID,
            `❌ *ERRORE CRITICO*\n\nFunzione: ${fnName}\nErrore: ${error.message}\nTentativi: ${maxAttempts}\n\n⚠️ Controlla logs!`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        } catch {}
        
        throw error;
      }
      
      const delay = RETRY_DELAY * Math.pow(2, attempt - 1);
      console.log(`⏳ [${fnName}] Retry in ${delay/1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ============================================
// MONITORA SWAP USDC → $BOT (con auto-approve!)
// ============================================
async function checkPendingSwaps() {
  return retryWithBackoff(async () => {
    console.log('💱 Checking pending USDC → $BOT swaps...');
    
    const response = await axios.get(`${BASE44_API}/DepositRequest`, {
      headers: { 'api_key': BASE44_API_KEY, 'Content-Type': 'application/json' },
      timeout: 15000
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
      try {
        if (AUTO_APPROVE_ENABLED && swap.amount <= AUTO_APPROVE_MAX_DEPOSIT_USDC) {
          console.log(`✅ [AUTO] Swap ${swap.amount} USDC - Approving...`);
          await autoApproveSwap(swap);
        } else {
          console.log(`⚠️ [MANUAL] Swap ${swap.amount} USDC - Notifying...`);
          await sendSwapNotification(swap);
        }
        
        processedTransactions.add(`swap_${swap.id}`);
        successCount++;
        
      } catch (error) {
        console.error(`❌ Error processing swap ${swap.id}:`, error.message);
        errorCount++;
      }
    }

  }, 'checkPendingSwaps').catch(() => {
    console.log('⚠️ checkPendingSwaps failed - will retry');
  });
}

async function autoApproveSwap(swap) {
  try {
    const balanceResponse = await axios.get(`${BASE44_API}/TokenBalance`, {
      headers: { 'api_key': BASE44_API_KEY },
      timeout: 10000
    });
    
    const balances = balanceResponse.data;
    const userBalance = balances.find(b => b.user_email === swap.user_email);
    
    if (userBalance) {
      await axios.put(
        `${BASE44_API}/TokenBalance/${userBalance.id}`,
        { 
          balance: userBalance.balance + swap.bot_amount,
          total_deposited: (userBalance.total_deposited || 0) + swap.bot_amount
        },
        { headers: { 'api_key': BASE44_API_KEY }, timeout: 10000 }
      );
    } else {
      await axios.post(
        `${BASE44_API}/TokenBalance`,
        {
          user_email: swap.user_email,
          wallet_address: swap.wallet_address,
          balance: 1000 + swap.bot_amount,
          total_deposited: swap.bot_amount,
          total_won: 0,
          total_lost: 0,
          total_bets: 0
        },
        { headers: { 'api_key': BASE44_API_KEY }, timeout: 10000 }
      );
    }
    
    await axios.put(
      `${BASE44_API}/DepositRequest/${swap.id}`,
      { 
        status: 'approved',
        processed: true,
        admin_notes: `Auto-approved. ${swap.amount} USDC ≤ ${AUTO_APPROVE_MAX_DEPOSIT_USDC}. ${new Date().toISOString()}`
      },
      { headers: { 'api_key': BASE44_API_KEY }, timeout: 10000 }
    );
    
    await bot.sendMessage(ADMIN_CHAT_ID,
      `✅ *SWAP AUTO-APPROVATO* 🤖\n\n👤 ${swap.user_email}\n💵 ${swap.amount} USDC → 🤖 ${swap.bot_amount} $BOT\n⚡ Auto (≤ ${AUTO_APPROVE_MAX_DEPOSIT_USDC} USDC)`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
    
    console.log(`✅ [AUTO] Swap ${swap.id} completed`);
    
  } catch (error) {
    console.error(`❌ [AUTO] Error:`, error.message);
    await sendSwapNotification(swap);
    throw error;
  }
}

async function sendSwapNotification(request) {
  const limitNote = AUTO_APPROVE_ENABLED 
    ? `\n\n⚠️ Sopra limite ${AUTO_APPROVE_MAX_DEPOSIT_USDC} USDC`
    : '';
  
  const message = 
    `🔔 *SWAP USDC → $BOT*${limitNote}\n\n👤 ${request.user_email}\n💵 ${request.amount} USDC\n🤖 ${request.bot_amount} $BOT\n🔗 TX: \`${request.tx_hash}\``;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Approva', callback_data: `approveswap_${request.id}` },
        { text: '❌ Rifiuta', callback_data: `rejectswap_${request.id}` }
      ]
    ]
  };

  try {
    await bot.sendMessage(ADMIN_CHAT_ID, message, { reply_markup: keyboard, parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Error sending notification:', error.message);
  }
}

// ============================================
// MONITORA SWAP $BOT → USDC
// ============================================
async function checkPendingReverseSwaps() {
  return retryWithBackoff(async () => {
    console.log('💸 Checking pending $BOT → USDC swaps...');
    
    const response = await axios.get(`${BASE44_API}/DepositRequest`, {
      headers: { 'api_key': BASE44_API_KEY },
      timeout: 15000
    });

    const requests = response.data;
    const pendingReverseSwaps = requests.filter(r => 
      r.request_type === 'swap_reverse' && 
      r.status === 'pending' &&
      !processedTransactions.has(`swap_reverse_${r.id}`)
    );

    if (pendingReverseSwaps.length === 0) {
      console.log('📭 No pending reverse swaps');
      return;
    }

    console.log(`💸 Found ${pendingReverseSwaps.length} pending reverse swaps`);

    for (const swap of pendingReverseSwaps) {
      try {
        if (AUTO_APPROVE_ENABLED && swap.amount <= AUTO_APPROVE_MAX_WITHDRAW_BOT) {
          console.log(`✅ [AUTO] Reverse ${swap.amount} $BOT - Approving...`);
          await autoApproveReverseSwap(swap);
        } else {
          console.log(`⚠️ [MANUAL] Reverse ${swap.amount} $BOT - Notifying...`);
          await sendReverseSwapNotification(swap);
        }
        
        processedTransactions.add(`swap_reverse_${swap.id}`);
        successCount++;
        
      } catch (error) {
        console.error(`❌ Error processing reverse swap:`, error.message);
        errorCount++;
      }
    }

  }, 'checkPendingReverseSwaps').catch(() => {
    console.log('⚠️ checkPendingReverseSwaps failed');
  });
}

async function autoApproveReverseSwap(swap) {
  try {
    await axios.put(
      `${BASE44_API}/DepositRequest/${swap.id}`,
      { 
        status: 'approved',
        admin_notes: `Auto-approved. ${swap.amount} $BOT ≤ ${AUTO_APPROVE_MAX_WITHDRAW_BOT}. ${new Date().toISOString()}`
      },
      { headers: { 'api_key': BASE44_API_KEY }, timeout: 10000 }
    );
    
    await bot.sendMessage(ADMIN_CHAT_ID,
      `✅ *REVERSE SWAP AUTO-APPROVATO* 🤖\n\n👤 ${swap.user_email}\n🤖 ${swap.amount} $BOT → 💵 ${swap.usdc_amount} USDC\n⚡ Auto (≤ ${AUTO_APPROVE_MAX_WITHDRAW_BOT} $BOT)`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
    
    console.log(`✅ [AUTO] Reverse swap approved`);
    
  } catch (error) {
    console.error(`❌ [AUTO] Error:`, error.message);
    await sendReverseSwapNotification(swap);
    throw error;
  }
}

async function sendReverseSwapNotification(request) {
  const limitNote = AUTO_APPROVE_ENABLED
    ? `\n\n⚠️ Sopra limite ${AUTO_APPROVE_MAX_WITHDRAW_BOT} $BOT`
    : '';
  
  const message = 
    `🔔 *SWAP $BOT → USDC*${limitNote}\n\n👤 ${request.user_email}\n🤖 ${request.amount} $BOT\n💵 ${request.usdc_amount} USDC\n📍 \`${request.wallet_address}\``;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Approva', callback_data: `approvereverseswap_${request.id}` },
        { text: '❌ Rifiuta', callback_data: `rejectreverseswap_${request.id}` }
      ]
    ]
  };

  try {
    await bot.sendMessage(ADMIN_CHAT_ID, message, { reply_markup: keyboard, parse_mode: 'Markdown' });
  } catch (error) {
    console.error('❌ Error sending notification:', error.message);
  }
}

// ============================================
// PROCESSO AUTOMATICO SWAP $BOT → USDC
// ============================================
async function processReverseSwaps() {
  return retryWithBackoff(async () => {
    if (!ADMIN_PRIVATE_KEY) return;

    const requestsResponse = await axios.get(`${BASE44_API}/DepositRequest`, {
      headers: { 'api_key': BASE44_API_KEY },
      timeout: 15000
    });

    const requests = requestsResponse.data;
    const approvedReverseSwaps = requests.filter(r => 
      r.request_type === 'swap_reverse' &&
      r.status === 'approved' &&
      !r.processed
    );

    if (approvedReverseSwaps.length === 0) return;

    console.log(`💸 Processing ${approvedReverseSwaps.length} approved reverse swaps`);

    const provider = new ethers.JsonRpcProvider(POLYGON_RPC_URL);
    const adminWallet = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);
    
    const ERC20_ABI = [
      'function transfer(address to, uint256 amount) returns (bool)',
      'function balanceOf(address owner) view returns (uint256)'
    ];

    const usdcContract = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, adminWallet);

    for (const req of approvedReverseSwaps) {
      try {
        console.log(`📤 Sending ${req.usdc_amount} USDC to ${req.wallet_address}...`);

        const amountWei = ethers.parseUnits(req.usdc_amount.toString(), 6);
        const adminBalance = await usdcContract.balanceOf(adminWallet.address);

        if (adminBalance < amountWei) {
          console.error(`❌ Insufficient USDC balance`);
          await bot.sendMessage(ADMIN_CHAT_ID,
            `❌ *SALDO USDC INSUFFICIENTE*\n\nRichiesto: ${req.usdc_amount} USDC\nUser: ${req.user_email}`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
          continue;
        }

        const tx = await usdcContract.transfer(req.wallet_address, amountWei);
        console.log(`⏳ TX sent: ${tx.hash}`);
        
        await tx.wait();
        console.log(`✅ TX confirmed`);

        await axios.put(
          `${BASE44_API}/DepositRequest/${req.id}`,
          { processed: true, tx_hash: tx.hash, admin_notes: `Auto-processed. TX: ${tx.hash}` },
          { headers: { 'api_key': BASE44_API_KEY }, timeout: 10000 }
        );

        await bot.sendMessage(ADMIN_CHAT_ID,
          `✅ *SWAP COMPLETATO*\n\n👤 ${req.user_email}\n💰 ${req.usdc_amount} USDC inviati\n🔗 [TX](https://polygonscan.com/tx/${tx.hash})`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        ).catch(() => {});

        successCount++;

      } catch (error) {
        console.error(`❌ Error processing reverse swap:`, error.message);
        errorCount++;
      }
    }

  }, 'processReverseSwaps').catch(() => {
    console.log('⚠️ processReverseSwaps failed');
  });
}

// ============================================
// MONITORA DEPOSITI $BOT
// ============================================
async function checkVaultDeposits() {
  return retryWithBackoff(async () => {
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
      timeout: 15000
    });

    if (response.data.status !== '1') {
      if (response.data.message === 'No transactions found') {
        console.log('📭 No new transactions');
        return;
      }
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

    console.log(`💰 Found ${incomingTxs.length} new deposits`);

    for (const tx of incomingTxs) {
      try {
        const amount = parseFloat(tx.value) / 1e18;
        const userEmail = await findUserByWallet(tx.from);

        if (userEmail) {
          await processAutoDeposit(userEmail, tx.from, amount, tx.hash);
          successCount++;
        }

        processedTransactions.add(tx.hash);
        
      } catch (error) {
        console.error(`❌ Error processing deposit:`, error.message);
        errorCount++;
      }
    }

  }, 'checkVaultDeposits').catch(() => {
    console.log('⚠️ checkVaultDeposits failed');
  });
}

async function findUserByWallet(walletAddress) {
  try {
    const balanceResponse = await axios.get(`${BASE44_API}/TokenBalance`, {
      headers: { 'api_key': BASE44_API_KEY },
      timeout: 10000
    });

    const balances = balanceResponse.data;
    const matchingBalance = balances.find(b => 
      b.wallet_address && 
      b.wallet_address.toLowerCase() === walletAddress.toLowerCase()
    );

    return matchingBalance ? matchingBalance.user_email : null;

  } catch (error) {
    console.error('Error finding user:', error.message);
    return null;
  }
}

async function processAutoDeposit(userEmail, walletAddress, amount, txHash) {
  try {
    const balanceResponse = await axios.get(`${BASE44_API}/TokenBalance`, {
      headers: { 'api_key': BASE44_API_KEY },
      timeout: 10000
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
        { headers: { 'api_key': BASE44_API_KEY }, timeout: 10000 }
      );
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
        { headers: { 'api_key': BASE44_API_KEY }, timeout: 10000 }
      );
    }

    await bot.sendMessage(ADMIN_CHAT_ID,
      `✅ *DEPOSITO AUTO-APPROVATO*\n\n👤 ${userEmail}\n💰 ${amount} $BOT`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});

    return true;

  } catch (error) {
    console.error('Error processing auto-deposit:', error.message);
    return false;
  }
}

// ============================================
// HEALTH CHECK
// ============================================
async function performHealthCheck() {
  try {
    const now = Date.now();
    const uptimeMinutes = Math.floor((now - lastHealthCheck) / 60000);
    
    if (uptimeMinutes >= 60) {
      console.log(`📊 Uptime: ${uptimeMinutes}m | Success: ${successCount} | Errors: ${errorCount}`);
      
      if (errorCount > 10) {
        await bot.sendMessage(ADMIN_CHAT_ID,
          `⚠️ *HEALTH ALERT*\n\nErrori: ${errorCount}\nSuccessi: ${successCount}\nUptime: ${uptimeMinutes}m`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }
      
      errorCount = 0;
      successCount = 0;
      lastHealthCheck = now;
    }
    
  } catch (error) {
    console.error('❌ Health check error:', error.message);
  }
}

// ============================================
// CALLBACK BOTTONI
// ============================================
bot.on('callback_query', async (query) => {
  const data = query.data;
  const parts = data.split('_');
  const action = parts[0];
  const requestId = parts.slice(1).join('_');

  try {
    if (action === 'approveswap') {
      await approveSwap(requestId);
      await bot.answerCallbackQuery(query.id, { text: '✅ Approvato' }).catch(() => {});
    } else if (action === 'rejectswap') {
      await rejectRequest(requestId);
      await bot.answerCallbackQuery(query.id, { text: '❌ Rifiutato' }).catch(() => {});
    } else if (action === 'approvereverseswap') {
      await approveReverseSwap(requestId);
      await bot.answerCallbackQuery(query.id, { text: '✅ Approvato' }).catch(() => {});
    } else if (action === 'rejectreverseswap') {
      await rejectReverseSwap(requestId);
      await bot.answerCallbackQuery(query.id, { text: '❌ Rifiutato' }).catch(() => {});
    }
  } catch (error) {
    console.error('❌ Callback error:', error.message);
    await bot.answerCallbackQuery(query.id, { text: '❌ Errore' }).catch(() => {});
  }
});

async function approveSwap(requestId) {
  try {
    const reqResponse = await axios.get(`${BASE44_API}/DepositRequest/${requestId}`, {
      headers: { 'api_key': BASE44_API_KEY },
      timeout: 10000
    });
    const request = reqResponse.data;
    
    const balanceResponse = await axios.get(`${BASE44_API}/TokenBalance`, {
      headers: { 'api_key': BASE44_API_KEY },
      timeout: 10000
    });
    const balances = balanceResponse.data;
    const userBalance = balances.find(b => b.user_email === request.user_email);
    
    if (userBalance) {
      await axios.put(
        `${BASE44_API}/TokenBalance/${userBalance.id}`,
        { balance: userBalance.balance + request.bot_amount },
        { headers: { 'api_key': BASE44_API_KEY }, timeout: 10000 }
      );
    }
    
    await axios.put(
      `${BASE44_API}/DepositRequest/${requestId}`,
      { status: 'approved', processed: true },
      { headers: { 'api_key': BASE44_API_KEY }, timeout: 10000 }
    );
    
    return true;
  } catch (error) {
    console.error('❌ Error approving:', error.message);
    return false;
  }
}

async function approveReverseSwap(requestId) {
  try {
    await axios.put(
      `${BASE44_API}/DepositRequest/${requestId}`,
      { status: 'approved' },
      { headers: { 'api_key': BASE44_API_KEY }, timeout: 10000 }
    );
    return true;
  } catch (error) {
    console.error('❌ Error approving:', error.message);
    return false;
  }
}

async function rejectReverseSwap(requestId) {
  try {
    const reqResponse = await axios.get(`${BASE44_API}/DepositRequest/${requestId}`, {
      headers: { 'api_key': BASE44_API_KEY },
      timeout: 10000
    });
    const request = reqResponse.data;
    
    const balanceResponse = await axios.get(`${BASE44_API}/TokenBalance`, {
      headers: { 'api_key': BASE44_API_KEY },
      timeout: 10000
    });
    const balances = balanceResponse.data;
    const userBalance = balances.find(b => b.user_email === request.user_email);
    
    if (userBalance) {
      await axios.put(
        `${BASE44_API}/TokenBalance/${userBalance.id}`,
        { balance: userBalance.balance + request.amount },
        { headers: { 'api_key': BASE44_API_KEY }, timeout: 10000 }
      );
    }
    
    await axios.put(
      `${BASE44_API}/DepositRequest/${requestId}`,
      { status: 'rejected', admin_notes: '$BOT refunded' },
      { headers: { 'api_key': BASE44_API_KEY }, timeout: 10000 }
    );
    return true;
  } catch (error) {
    console.error('❌ Error rejecting:', error.message);
    return false;
  }
}

async function rejectRequest(requestId) {
  try {
    await axios.put(`${BASE44_API}/DepositRequest/${requestId}`, { status: 'rejected' }, { headers: { 'api_key': BASE44_API_KEY }, timeout: 10000 });
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
  await bot.sendMessage(msg.chat.id,
    `🤖 *Bot v3.0 Attivo*\n\n✅ Auto-approve: ${AUTO_APPROVE_ENABLED ? 'ON' : 'OFF'}\n💵 Max deposit: ${AUTO_APPROVE_MAX_DEPOSIT_USDC} USDC\n💸 Max withdraw: ${AUTO_APPROVE_MAX_WITHDRAW_BOT} $BOT`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
});

bot.onText(/\/health/, async (msg) => {
  if (msg.chat.id.toString() !== ADMIN_CHAT_ID) return;
  await bot.sendMessage(msg.chat.id,
    `💚 *HEALTH*\n\n✅ Success: ${successCount}\n❌ Errors: ${errorCount}\n⏰ Uptime: ${Math.floor(process.uptime() / 60)}m`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
});

// ============================================
// HTTP SERVER
// ============================================
app.get('/', (req, res) => {
  res.send('🤖 Bot v3.0 Active!');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '3.0',
    auto_approve: AUTO_APPROVE_ENABLED,
    max_deposit: AUTO_APPROVE_MAX_DEPOSIT_USDC,
    max_withdraw: AUTO_APPROVE_MAX_WITHDRAW_BOT,
    success: successCount,
    errors: errorCount,
    uptime: process.uptime()
  });
});

// ============================================
// AVVIO
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('🚀 Server started on port', PORT);
  console.log('✅ Bot initialized');
  
setInterval(() => {
  checkVaultDeposits();
  checkPendingSwaps();
  checkPendingReverseSwaps();
}, 5 * 60000); // ogni 5 minuti invece di 1
  
  setTimeout(() => {
    checkVaultDeposits();
    checkPendingSwaps();
    checkPendingReverseSwaps();
    processReverseSwaps();
  }, 5000);
  
  bot.sendMessage(ADMIN_CHAT_ID, 
    `🤖 *Bot v3.0 Avviato*\n\n✅ Auto-approve: ${AUTO_APPROVE_ENABLED ? 'ON' : 'OFF'}\n💵 Max: ${AUTO_APPROVE_MAX_DEPOSIT_USDC} USDC\n💸 Max: ${AUTO_APPROVE_MAX_WITHDRAW_BOT} $BOT`, 
    { parse_mode: 'Markdown' }
  ).catch(() => {});
});

bot.on('polling_error', (error) => { 
  console.error('❌ Polling error:', error.code);
  errorCount++;
});

process.on('SIGTERM', () => { 
  console.log('👋 Shutdown'); 
  bot.stopPolling(); 
  process.exit(0); 
});

