# 🤖 Futuro Umanoide Backend v2.0

Backend completo per Prompt4Future con automazione integrata.

## 🚀 Funzionalità

### ✅ Sistema Automatico Completo

1. **Depositi Automatici** (ogni 30s)
   - Monitora vault Polygon in real-time
   - Auto-credit saldo utente
   - Notifiche Telegram admin

2. **Withdrawals Automatici** (ogni 60s)
   - Processa richieste approvate
   - Invia transazioni on-chain automaticamente
   - Aggiorna database

3. **Betting Pools** (Cron Jobs)
   - **00:00 UTC**: Crea pool giornaliero
   - **12:00 UTC**: Risolve pool + pubblica highlight

4. **Bot Telegram**
   - Notifiche real-time
   - Comandi admin
   - Approvazione rapida

## 📋 Setup

### 1. Installa Dipendenze

```bash
npm install
