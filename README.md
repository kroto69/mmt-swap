# SUI Swap Bot for Mmt Finance

Bot otomatis untuk melakukan swap token di [Mmt Finance](https://app.mmt.finance ) menggunakan CLMM pools di blockchain SUI.

## 💰 Token yang Didukungj
| Token | Ticker | Status |
|-------|--------|--------|
| USDT  | USDT   | ✅      |
| USDC  | USDC   | ✅      |
| SUI   | SUI    | ✅      |

> Swap yang bisa dilakukan:
- USDT ↔ USDC
- SUI ↔ USDC

## 🔧 Installasi

1. Clone repo
2. install 
   ```bash
    npm install
3. Buat file .env dari contoh:
    ```bash
    cp .env.example .env

Lalu isi dengan private key atau mnemonic.

4. Jalankan Bot
```bash
    node index.js
