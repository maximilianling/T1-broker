// ================================================================
// T1 BROKER — CRYPTO OMNIBUS WALLET SERVICE
// Platform wallets, client sub-accounts, deposit/withdrawal,
// balance management, hot→cold sweep, blockchain scanning
// ================================================================
const db = require('../config/database');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { encrypt, decrypt } = require('./providerManager');
const { PushNotificationService } = require('./push');

// ================================================================
// BLOCKCHAIN CONFIG (RPC endpoints, confirmation thresholds)
// ================================================================
const CHAIN_CONFIG = {
  bitcoin:   { symbol: 'BTC', decimals: 8, confirmations: 3, nativeSymbol: 'BTC' },
  ethereum:  { symbol: 'ETH', decimals: 18, confirmations: 12, nativeSymbol: 'ETH' },
  solana:    { symbol: 'SOL', decimals: 9, confirmations: 1, nativeSymbol: 'SOL' },
  polygon_chain: { symbol: 'MATIC', decimals: 18, confirmations: 30, nativeSymbol: 'MATIC' },
  bsc:       { symbol: 'BNB', decimals: 18, confirmations: 15, nativeSymbol: 'BNB' },
  avalanche: { symbol: 'AVAX', decimals: 18, confirmations: 12, nativeSymbol: 'AVAX' },
  arbitrum:  { symbol: 'ETH', decimals: 18, confirmations: 12, nativeSymbol: 'ETH' },
  optimism:  { symbol: 'ETH', decimals: 18, confirmations: 12, nativeSymbol: 'ETH' },
  tron:      { symbol: 'TRX', decimals: 6, confirmations: 19, nativeSymbol: 'TRX' },
  litecoin:  { symbol: 'LTC', decimals: 8, confirmations: 6, nativeSymbol: 'LTC' },
  ripple:    { symbol: 'XRP', decimals: 6, confirmations: 1, nativeSymbol: 'XRP' },
  cardano:   { symbol: 'ADA', decimals: 6, confirmations: 15, nativeSymbol: 'ADA' },
  polkadot:  { symbol: 'DOT', decimals: 10, confirmations: 12, nativeSymbol: 'DOT' },
};

class CryptoWalletService {

  // ================================================================
  // OMNIBUS WALLET MANAGEMENT (Admin)
  // ================================================================

  static async createOmnibusWallet({ blockchain, walletType, walletName, address, rpcEndpoint, explorerUrl, maxBalance, minBalance, dailyLimit, createdBy }) {
    const [wallet] = await db('omnibus_wallets').insert({
      blockchain, wallet_type: walletType, wallet_name: walletName,
      address, rpc_endpoint: rpcEndpoint, explorer_url: explorerUrl,
      max_balance: maxBalance, min_balance: minBalance,
      daily_withdrawal_limit: dailyLimit,
      created_by: createdBy,
    }).returning('*');

    logger.info('Omnibus wallet created', { id: wallet.id, blockchain, walletType, address: address.slice(0, 10) + '...' });
    return wallet;
  }

  static async listOmnibusWallets(blockchain = null) {
    let query = db('omnibus_wallets').orderBy('blockchain').orderBy('wallet_type');
    if (blockchain) query = query.where('blockchain', blockchain);
    return query.select(
      'id', 'wallet_name', 'blockchain', 'wallet_type', 'address',
      'balance', 'balance_usd', 'pending_in', 'pending_out',
      'max_balance', 'min_balance', 'daily_withdrawal_limit', 'daily_withdrawn',
      'status', 'requires_multisig', 'last_scan_at', 'created_at'
    );
  }

  static async updateOmnibusBalance(walletId, balance, balanceUsd = null) {
    await db('omnibus_wallets').where('id', walletId).update({
      balance, balance_usd: balanceUsd, last_scan_at: new Date(), updated_at: new Date(),
    });
  }

  static async storeEncryptedKey(walletId, privateKey, mnemonic = null) {
    const updates = { private_key_encrypted: encrypt(privateKey) };
    if (mnemonic) updates.mnemonic_encrypted = encrypt(mnemonic);
    await db('omnibus_wallets').where('id', walletId).update(updates);
    logger.info('Encrypted key stored for wallet', { walletId });
  }

  // ================================================================
  // CLIENT SUB-ACCOUNTS (Derived from omnibus)
  // ================================================================

  static async createClientCryptoAccount(clientId, blockchain) {
    // Check if already exists
    const existing = await db('client_crypto_accounts')
      .where({ client_id: clientId, blockchain }).first();
    if (existing) return existing;

    // Find active hot wallet for this chain
    const omnibusWallet = await db('omnibus_wallets')
      .where({ blockchain, wallet_type: 'hot', status: 'active' })
      .first();

    if (!omnibusWallet) {
      throw new Error(`No active hot wallet for ${blockchain}`);
    }

    // Get next derivation index
    const maxIdx = await db('client_crypto_accounts')
      .where('omnibus_wallet_id', omnibusWallet.id)
      .max('derivation_index as max')
      .first();
    const nextIndex = (maxIdx?.max || 0) + 1;

    // Generate deterministic deposit address
    // In production: use HD wallet derivation (BIP-44 for BTC, EIP-2333 for ETH)
    // For now: generate unique address hash
    const depositAddress = this._deriveAddress(omnibusWallet.address, clientId, nextIndex, blockchain);

    const [account] = await db('client_crypto_accounts').insert({
      client_id: clientId,
      blockchain,
      omnibus_wallet_id: omnibusWallet.id,
      deposit_address: depositAddress,
      derivation_index: nextIndex,
    }).returning('*');

    logger.info('Client crypto account created', {
      clientId, blockchain, address: depositAddress.slice(0, 10) + '...',
    });
    return account;
  }

  // Deterministic address derivation (placeholder — use real HD wallet in production)
  static _deriveAddress(omnibusAddress, clientId, index, blockchain) {
    const hash = crypto.createHash('sha256')
      .update(`${omnibusAddress}:${clientId}:${index}`)
      .digest('hex');

    switch (blockchain) {
      case 'bitcoin':
      case 'litecoin':
        return 'bc1q' + hash.slice(0, 38);  // bech32-like
      case 'ethereum':
      case 'polygon_chain':
      case 'bsc':
      case 'avalanche':
      case 'arbitrum':
      case 'optimism':
        return '0x' + hash.slice(0, 40);
      case 'solana':
        return hash.slice(0, 44);
      case 'tron':
        return 'T' + hash.slice(0, 33);
      case 'ripple':
        return 'r' + hash.slice(0, 33);
      case 'cardano':
        return 'addr1' + hash.slice(0, 50);
      default:
        return '0x' + hash.slice(0, 40);
    }
  }

  static async getClientCryptoAccounts(clientId) {
    return db('client_crypto_accounts as cca')
      .join('omnibus_wallets as ow', 'ow.id', 'cca.omnibus_wallet_id')
      .where('cca.client_id', clientId)
      .select(
        'cca.id', 'cca.blockchain', 'cca.deposit_address', 'cca.deposit_address_tag',
        'cca.balance', 'cca.available_balance', 'cca.locked_balance',
        'cca.total_deposited', 'cca.total_withdrawn', 'cca.status',
        'ow.wallet_name as omnibus_name'
      );
  }

  static async getOrCreateAccount(clientId, blockchain) {
    const existing = await db('client_crypto_accounts')
      .where({ client_id: clientId, blockchain }).first();
    if (existing) return existing;
    return this.createClientCryptoAccount(clientId, blockchain);
  }

  // ================================================================
  // DEPOSITS (Blockchain scanner detects incoming tx)
  // ================================================================

  static async processDeposit({ txHash, blockchain, toAddress, amount, tokenSymbol, tokenContract, blockNumber, blockHash }) {
    const trx = await db.transaction();
    try {
      // Find client account by deposit address
      const account = await trx('client_crypto_accounts')
        .where({ deposit_address: toAddress, blockchain }).first();
      if (!account) {
        await trx.rollback();
        return null; // Not a recognized deposit address
      }

      // Check for duplicate
      const existing = await trx('crypto_transactions').where({ tx_hash: txHash }).first();
      if (existing) {
        await trx.rollback();
        return existing;
      }

      const chainConfig = CHAIN_CONFIG[blockchain] || { confirmations: 6 };

      // Create pending deposit
      const [tx] = await trx('crypto_transactions').insert({
        client_id: account.client_id,
        client_crypto_account_id: account.id,
        omnibus_wallet_id: account.omnibus_wallet_id,
        tx_type: 'deposit',
        blockchain,
        tx_hash: txHash,
        to_address: toAddress,
        amount,
        token_symbol: tokenSymbol || null,
        token_contract: tokenContract || null,
        block_number: blockNumber,
        block_hash: blockHash,
        required_confirmations: chainConfig.confirmations,
        status: 'confirming',
      }).returning('*');

      // Update pending balance
      await trx('client_crypto_accounts')
        .where('id', account.id)
        .update({ updated_at: new Date() });

      await trx('omnibus_wallets')
        .where('id', account.omnibus_wallet_id)
        .increment('pending_in', amount);

      await trx.commit();
      logger.info('Deposit detected', { txHash: txHash.slice(0, 12), blockchain, amount, clientId: account.client_id });
      return tx;
    } catch (err) {
      await trx.rollback();
      throw err;
    }
  }

  // Called when deposit reaches required confirmations
  static async confirmDeposit(txId) {
    const trx = await db.transaction();
    try {
      const tx = await trx('crypto_transactions').where({ id: txId, status: 'confirming' }).first();
      if (!tx) { await trx.rollback(); return; }

      await trx('crypto_transactions').where('id', txId).update({
        status: 'confirmed', updated_at: new Date(),
      });

      // Credit client balance
      await trx('client_crypto_accounts')
        .where('id', tx.client_crypto_account_id)
        .update({
          balance: db.raw('balance + ?', [tx.amount]),
          available_balance: db.raw('available_balance + ?', [tx.amount]),
          total_deposited: db.raw('total_deposited + ?', [tx.amount]),
          updated_at: new Date(),
        });

      // Update omnibus
      await trx('omnibus_wallets')
        .where('id', tx.omnibus_wallet_id)
        .update({
          balance: db.raw('balance + ?', [tx.amount]),
          pending_in: db.raw('pending_in - ?', [tx.amount]),
        });

      await trx.commit();

      // Notify client
      const client = await db('clients').where('id', tx.client_id).first();
      if (client?.user_id) {
        PushNotificationService.sendToUser(client.user_id, 'depositConfirmed', {
          amount: `${tx.amount} ${tx.token_symbol || CHAIN_CONFIG[tx.blockchain]?.nativeSymbol || tx.blockchain}`,
        }).catch(() => {});
      }

      logger.info('Deposit confirmed', { txId, amount: tx.amount, clientId: tx.client_id });
    } catch (err) {
      await trx.rollback();
      throw err;
    }
  }

  // ================================================================
  // WITHDRAWALS
  // ================================================================

  static async requestWithdrawal({ clientId, blockchain, toAddress, amount, tokenSymbol, tokenContract }) {
    const trx = await db.transaction();
    try {
      const account = await trx('client_crypto_accounts')
        .where({ client_id: clientId, blockchain }).first();
      if (!account) throw new Error(`No ${blockchain} account found`);
      if (parseFloat(account.available_balance) < parseFloat(amount)) {
        throw new Error('Insufficient balance');
      }

      // Check daily withdrawal limit
      const omnibus = await trx('omnibus_wallets').where('id', account.omnibus_wallet_id).first();
      if (omnibus.daily_withdrawal_limit && parseFloat(omnibus.daily_withdrawn) + parseFloat(amount) > parseFloat(omnibus.daily_withdrawal_limit)) {
        throw new Error('Daily withdrawal limit exceeded');
      }

      // Lock funds
      await trx('client_crypto_accounts').where('id', account.id).update({
        available_balance: db.raw('available_balance - ?', [amount]),
        locked_balance: db.raw('locked_balance + ?', [amount]),
        updated_at: new Date(),
      });

      // Create pending withdrawal
      const [tx] = await trx('crypto_transactions').insert({
        client_id: clientId,
        client_crypto_account_id: account.id,
        omnibus_wallet_id: account.omnibus_wallet_id,
        tx_type: 'withdrawal',
        blockchain,
        to_address: toAddress,
        amount,
        token_symbol: tokenSymbol || null,
        token_contract: tokenContract || null,
        status: 'pending',
        required_confirmations: CHAIN_CONFIG[blockchain]?.confirmations || 6,
      }).returning('*');

      await trx('omnibus_wallets')
        .where('id', account.omnibus_wallet_id)
        .increment('pending_out', amount);

      await trx.commit();

      logger.info('Withdrawal requested', { clientId, blockchain, amount, toAddress: toAddress.slice(0, 10) + '...' });
      return tx;
    } catch (err) {
      await trx.rollback();
      throw err;
    }
  }

  static async approveWithdrawal(txId, approvedBy) {
    const tx = await db('crypto_transactions').where({ id: txId, status: 'pending', tx_type: 'withdrawal' }).first();
    if (!tx) throw new Error('Transaction not found or not pending');

    await db('crypto_transactions').where('id', txId).update({
      status: 'confirming', approved_by: approvedBy, approved_at: new Date(),
    });

    // In production: sign and broadcast tx here
    // For now: simulate broadcast
    logger.info('Withdrawal approved, broadcasting', { txId, amount: tx.amount, blockchain: tx.blockchain });
    return tx;
  }

  static async completeWithdrawal(txId, txHash) {
    const trx = await db.transaction();
    try {
      const tx = await trx('crypto_transactions').where({ id: txId }).first();
      if (!tx) throw new Error('Transaction not found');

      await trx('crypto_transactions').where('id', txId).update({
        status: 'confirmed', tx_hash: txHash, updated_at: new Date(),
      });

      await trx('client_crypto_accounts').where('id', tx.client_crypto_account_id).update({
        balance: db.raw('balance - ?', [tx.amount]),
        locked_balance: db.raw('locked_balance - ?', [tx.amount]),
        total_withdrawn: db.raw('total_withdrawn + ?', [tx.amount]),
        updated_at: new Date(),
      });

      await trx('omnibus_wallets').where('id', tx.omnibus_wallet_id).update({
        balance: db.raw('balance - ?', [tx.amount]),
        pending_out: db.raw('pending_out - ?', [tx.amount]),
        daily_withdrawn: db.raw('daily_withdrawn + ?', [tx.amount]),
      });

      await trx.commit();
      logger.info('Withdrawal completed', { txId, txHash });
    } catch (err) {
      await trx.rollback();
      throw err;
    }
  }

  // ================================================================
  // HOT → COLD SWEEP (when hot wallet exceeds threshold)
  // ================================================================

  static async checkAndSweep() {
    const hotWallets = await db('omnibus_wallets')
      .where({ wallet_type: 'hot', status: 'active' })
      .whereNotNull('max_balance');

    for (const hot of hotWallets) {
      if (parseFloat(hot.balance) > parseFloat(hot.max_balance)) {
        const cold = await db('omnibus_wallets')
          .where({ blockchain: hot.blockchain, wallet_type: 'cold', status: 'active' })
          .first();

        if (cold) {
          const sweepAmount = parseFloat(hot.balance) - parseFloat(hot.max_balance) * 0.7;
          logger.info('Sweep triggered', { from: hot.wallet_name, to: cold.wallet_name, amount: sweepAmount });

          await db('crypto_transactions').insert({
            omnibus_wallet_id: hot.id,
            tx_type: 'sweep',
            blockchain: hot.blockchain,
            from_address: hot.address,
            to_address: cold.address,
            amount: sweepAmount,
            status: 'pending',
            required_confirmations: CHAIN_CONFIG[hot.blockchain]?.confirmations || 6,
          });
          // In production: sign and broadcast the sweep transaction
        }
      }
    }
  }

  // ================================================================
  // SUPPORTED TOKENS
  // ================================================================

  static async getSupportedTokens(blockchain = null) {
    let query = db('supported_tokens').where('is_enabled', true);
    if (blockchain) query = query.where('blockchain', blockchain);
    return query.orderBy('blockchain').orderBy('token_symbol');
  }

  static async addToken({ blockchain, tokenSymbol, tokenName, contractAddress, decimals, isStablecoin, minDeposit, minWithdrawal, withdrawalFee }) {
    return db('supported_tokens').insert({
      blockchain, token_symbol: tokenSymbol, token_name: tokenName,
      contract_address: contractAddress, decimals: decimals || 18,
      is_stablecoin: isStablecoin || false,
      min_deposit: minDeposit || 0, min_withdrawal: minWithdrawal || 0,
      withdrawal_fee: withdrawalFee || 0,
    }).returning('*');
  }

  // ================================================================
  // TRANSACTION HISTORY
  // ================================================================

  static async getTransactions(clientId, { blockchain, status, type, limit = 50, offset = 0 } = {}) {
    let query = db('crypto_transactions').where('client_id', clientId);
    if (blockchain) query = query.where('blockchain', blockchain);
    if (status) query = query.where('status', status);
    if (type) query = query.where('tx_type', type);
    return query.orderBy('created_at', 'desc').limit(limit).offset(offset);
  }

  static async getChainConfig() { return CHAIN_CONFIG; }
}

module.exports = CryptoWalletService;
