import 'dotenv/config';
import { MmtSDK, TickMath } from '@mmt-finance/clmm-sdk';
import { Transaction } from '@mysten/sui/transactions';
import { SuiClient, SuiHTTPTransport } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import Decimal from 'decimal.js';
import readline from 'readline';
import { Buffer } from 'buffer';

// Network setup
const NETWORKS = {
  mainnet: 'https://fullnode.mainnet.sui.io:443 ',
  testnet: 'https://fullnode.testnet.sui.io:443 ',
};

// Token configurations
const TOKENS = {
  USDT: {
    type: '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN',
    decimal: 6,
    name: 'USDT',
    defaultAmount: 2,
  },
  USDC: {
    type: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    decimal: 6,
    name: 'USDC',
    defaultAmount: 2,
  },
  SUI: {
    type: '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
    decimal: 9,
    name: 'SUI',
    defaultAmount: 2,
  },
};

// Pool setup for USDT/USDC
const POOLS = {
  'USDT-USDC': {
    poolId: '0x8a86062a0193c48b9d7c42e5d522ed1b30ba1010c72e0cd0dad1525036775c8b',
    tokenXType: TOKENS.USDT.type,
    tokenYType: TOKENS.USDC.type,
    decimalX: TOKENS.USDT.decimal,
    decimalY: TOKENS.USDC.decimal,
    tickSpacing: 1,
    tokenX: 'USDT',
    tokenY: 'USDC',
  },
  'SUI-USDC': {
    poolId: '0x455cf8d2ac91e7cb883f515874af750ed3cd18195c970b7a2d46235ac2b0c388',
    tokenXType: TOKENS.SUI.type,
    tokenYType: TOKENS.USDC.type,
    decimalX: TOKENS.SUI.decimal,
    decimalY: TOKENS.USDC.decimal,
    tickSpacing: 64,
    tokenX: 'SUI',
    tokenY: 'USDC',
  },
};

// Default price fallback
const DEFAULT_PRICE = 1.0001;

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function askQuestion(query) {
  return new Promise((resolve) => rl.question(query, resolve));
}

function formatBalance(balance, decimals) {
  return (Number(balance) / Math.pow(10, decimals)).toFixed(decimals);
}

async function checkWalletBalance(client, address) {
  console.log('\n=== WALLET BALANCE ===');
  const balances = {};
  const usdtCoins = await client.getCoins({ owner: address, coinType: TOKENS.USDT.type });
  const usdtBalance = usdtCoins.data.reduce((acc, coin) => acc + BigInt(coin.balance), BigInt(0));
  console.log(`USDT: ${formatBalance(usdtBalance, TOKENS.USDT.decimal)} (${usdtBalance})`);
  balances.USDT = { balance: usdtBalance, coins: usdtCoins.data };

  const usdcCoins = await client.getCoins({ owner: address, coinType: TOKENS.USDC.type });
  const usdcBalance = usdcCoins.data.reduce((acc, coin) => acc + BigInt(coin.balance), BigInt(0));
  console.log(`USDC: ${formatBalance(usdcBalance, TOKENS.USDC.decimal)} (${usdcBalance})`);
  balances.USDC = { balance: usdcBalance, coins: usdcCoins.data };

  const suiCoins = await client.getCoins({ owner: address, coinType: TOKENS.SUI.type });
  const suiBalance = suiCoins.data.reduce((acc, coin) => acc + BigInt(coin.balance), BigInt(0));
  console.log(`SUI: ${formatBalance(suiBalance, TOKENS.SUI.decimal)} (${suiBalance})`);
  balances.SUI = { balance: suiBalance, coins: suiCoins.data };

  return balances;
}

async function fetchCurrentPrice(sdk, pool) {
  try {
    const poolData = await sdk.Pool.getPool(pool.poolId);
    if (!poolData || !poolData.current_sqrt_price) {
      console.log('Pool data incomplete, using default price.');
      return new Decimal(DEFAULT_PRICE);
    }

    const sqrtPriceX64 = poolData.current_sqrt_price;
    try {
      const price = TickMath.sqrtPriceX64ToPrice(
        sqrtPriceX64,
        pool.decimalX,
        pool.decimalY
      );
      console.log(`Current price from pool: 1 ${pool.tokenX} = ${price.toFixed(6)} ${pool.tokenY}`);
      return price;
    } catch (priceCalcError) {
      console.log('Error calculating price:', priceCalcError.message);
      return new Decimal(DEFAULT_PRICE);
    }
  } catch (error) {
    console.log('Error fetching price from pool, using default price.');
    return new Decimal(DEFAULT_PRICE);
  }
}

async function executeSwap(client, sdk, keypair, address, pool, sourceToken, amountToSwap, slippage, useAllCoins = false) {
  const targetToken = sourceToken === pool.tokenX ? pool.tokenY : pool.tokenX;
  const currentPrice = await fetchCurrentPrice(sdk, pool);

  let price;
  if (sourceToken === pool.tokenX) {
    price = currentPrice;
  } else {
    price = new Decimal(1).div(currentPrice);
  }

  const sourceDecimals = TOKENS[sourceToken].decimal;
  const targetDecimals = TOKENS[targetToken].decimal;
  const inputAmount = new Decimal(amountToSwap.toString()).div(Math.pow(10, sourceDecimals));
  const estimatedOutputDecimal = inputAmount.mul(price);
  const estimatedOutput = BigInt(estimatedOutputDecimal.mul(Math.pow(10, targetDecimals)).floor().toString());

  console.log(`Estimated output: ${formatBalance(estimatedOutput, targetDecimals)} ${targetToken}`);

  const isXtoY = sourceToken === pool.tokenX;

  const coinType = TOKENS[sourceToken].type;
  let coins;
  if (useAllCoins) {
    const allCoins = await client.getCoins({ owner: address, coinType });
    coins = allCoins.data;
  } else {
    const allCoins = await client.getCoins({ owner: address, coinType });
    const coin = allCoins.data.find((c) => BigInt(c.balance) >= amountToSwap);
    if (!coin) throw new Error(`No single coin with enough ${sourceToken} balance.`);
    coins = [coin];
  }

  if (coins.length === 0) throw new Error(`No ${sourceToken} coins found`);

  const limitPrice = isXtoY
    ? price.mul(new Decimal(1 - slippage / 100))
    : price.mul(new Decimal(1 + slippage / 100));
  const limitSqrtPrice = TickMath.priceToSqrtPriceX64(limitPrice, pool.decimalX, pool.decimalY);

  const tx = new Transaction();
  let inputCoin;

  if (useAllCoins && coins.length > 1) {
    console.log(`Merging ${coins.length} ${sourceToken} coins...`);
    const primaryCoin = coins[0].coinObjectId;
    const mergeCoins = coins.slice(1).map((c) => c.coinObjectId);
    tx.mergeCoins(primaryCoin, mergeCoins);
    inputCoin = tx.splitCoins(primaryCoin, [amountToSwap]);
  } else {
    console.log(`Using coin: ${coins[0].coinObjectId}`);
    if (useAllCoins) {
      inputCoin = coins[0].coinObjectId;
    } else {
      inputCoin = tx.splitCoins(coins[0].coinObjectId, [amountToSwap]);
    }
  }

  sdk.Pool.swap(
    tx,
    {
      objectId: pool.poolId,
      tokenXType: pool.tokenXType,
      tokenYType: pool.tokenYType,
      tickSpacing: pool.tickSpacing,
    },
    amountToSwap,
    inputCoin,
    isXtoY,
    address,
    limitSqrtPrice
  );

  console.log('Executing transaction...');
  try {
    const result = await client.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
    });

    console.log(`Transaction submitted: ${result.digest}`);
    console.log(`Explorer link: https://suiscan.xyz/mainnet/tx/ ${result.digest}`);
    const final = await client.waitForTransaction({ digest: result.digest });
    const status = final.effects?.status?.status || 'unknown';
    console.log(`Swap complete. Status: ${status}`);
    return { txDigest: result.digest, status };
  } catch (txError) {
    console.error('Transaction failed:', txError.message);
    throw new Error(`Swap transaction failed: ${txError.message}`);
  }
}

async function main() {
  try {
    // Gunakan private key atau mnemonic
    let keypair;

    const privateKeyHex = process.env.PRIVATE_KEY?.trim();
    const mnemonic = process.env.MNEMONIC?.trim();

    if (privateKeyHex) {
      const cleanPrivateKey = privateKeyHex.startsWith('0x')
        ? privateKeyHex.slice(2)
        : privateKeyHex;

      if (cleanPrivateKey.length !== 64) {
        throw new Error('Invalid private key length. Must be 64 hex characters.');
      }

      keypair = Ed25519Keypair.fromSecretKey(
        Uint8Array.from(Buffer.from(cleanPrivateKey, 'hex'))
      );
      console.log('🔑 Using Private Key for signing.');
    } else if (mnemonic) {
      keypair = Ed25519Keypair.deriveKeypair(mnemonic, "m/44'/784'/0'/0'/0'");
      console.log('🧠 Using Mnemonic for signing.');
    } else {
      throw new Error('Either PRIVATE_KEY or MNEMONIC must be provided in .env file');
    }

    const network = process.env.NETWORK || 'mainnet';
    const slippage = parseFloat(process.env.SLIPPAGE_PERCENTAGE || '0.1');

    const address = keypair.getPublicKey().toSuiAddress();
    console.log(`💼 Wallet Address: ${address}`);
    console.log(`🌐 Network: ${network}`);

    const client = new SuiClient({
      transport: new SuiHTTPTransport({ url: NETWORKS[network] }),
    });

    const sdk = MmtSDK.NEW({ network });

    const balances = await checkWalletBalance(client, address);

    console.log('\nAvailable pools:');
    Object.keys(POOLS).forEach((poolName, index) => {
      console.log(`${index + 1}. ${poolName}`);
    });

    const poolChoice = await askQuestion('\nSelect pool (number): ');
    const poolIndex = parseInt(poolChoice) - 1;
    const poolName = Object.keys(POOLS)[poolIndex];
    const pool = POOLS[poolName];
    console.log(`Selected pool: ${poolName}`);

    const sourceTokenPrompt = await askQuestion(`\nSelect source token (${pool.tokenX}/${pool.tokenY}): `);
    const sourceToken = sourceTokenPrompt.toUpperCase();

    if (sourceToken !== pool.tokenX && sourceToken !== pool.tokenY) {
      throw new Error(`Invalid token selection. Please choose ${pool.tokenX} or ${pool.tokenY}.`);
    }

    const swapAllOption = await askQuestion('\nSwap all available balance? (y/n): ');
    const swapAll = swapAllOption.toLowerCase() === 'y';

    let amountToSwap = BigInt(0);
    if (!swapAll) {
      const defaultAmount = TOKENS[sourceToken].defaultAmount;
      const amountPrompt = `\nEnter amount of ${sourceToken} to swap (default: ${defaultAmount}): `;
      const inputAmount = await askQuestion(amountPrompt);
      const amount = inputAmount.trim() === '' ? defaultAmount : parseFloat(inputAmount);
      amountToSwap = BigInt(Math.floor(amount * Math.pow(10, TOKENS[sourceToken].decimal)));

      if (amountToSwap <= 0) throw new Error('Amount must be greater than 0');
      if (amountToSwap > balances[sourceToken].balance) throw new Error(`Insufficient ${sourceToken} balance`);
    }

    const wantLoop = await askQuestion('\nLoop swap (back and forth)? (y/n): ');
    if (wantLoop.toLowerCase() === 'y') {
      const loopCountInput = await askQuestion('Enter number of loop cycles (default: 1): ');
      const loopCount = loopCountInput.trim() === '' ? 1 : parseInt(loopCountInput);

      const intervalInput = await askQuestion('Enter interval between swaps in seconds (default: 60): ');
      const intervalSeconds = intervalInput.trim() === '' ? 60 : parseInt(intervalInput);

      console.log(`\nStarting ${loopCount} bidirectional swap cycles with ${intervalSeconds} second intervals...`);

      for (let i = 0; i < loopCount; i++) {
        console.log(`\n--- Executing swap cycle ${i + 1}/${loopCount} ---`);

        console.log(`\nSwap 1: ${sourceToken} → ${sourceToken === pool.tokenX ? pool.tokenY : pool.tokenX}`);
        const swap1Result = await executeSwap(
          client,
          sdk,
          keypair,
          address,
          pool,
          sourceToken,
          amountToSwap,
          slippage,
          swapAll
        );

        console.log(`Waiting ${intervalSeconds} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));

        const updatedBalances = await checkWalletBalance(client, address);

        const targetToken = sourceToken === pool.tokenX ? pool.tokenY : pool.tokenX;
        let swapBackAmount;
        if (swapAll) {
          swapBackAmount = updatedBalances[targetToken].balance;
        } else {
          swapBackAmount = amountToSwap;
        }

        console.log(`\nSwap 2: ${targetToken} → ${sourceToken}`);
        const swap2Result = await executeSwap(
          client,
          sdk,
          keypair,
          address,
          pool,
          targetToken,
          swapBackAmount,
          slippage,
          swapAll
        );

        if (i < loopCount - 1) {
          console.log(`Waiting ${intervalSeconds} seconds until next cycle...`);
          await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
          await checkWalletBalance(client, address);
        }
      }
      console.log(`\nCompleted ${loopCount} bidirectional swap cycles`);
    } else {
      await executeSwap(client, sdk, keypair, address, pool, sourceToken, amountToSwap, slippage, swapAll);
    }

    await checkWalletBalance(client, address);
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    rl.close();
  }
}

main();
