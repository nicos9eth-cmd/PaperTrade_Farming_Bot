'use strict';

// One-time setup of the Lighter hedge: installs Lighter's official SDK in the bot's own Python
// environment, creates an API key for the bot and has the owner's wallet register it on their
// main Lighter account (one message signature, not a transaction). The key can trade and send
// funds back to the owner's own address only; it is stored in .lighter-key.json.

const fs = require('fs');
const http = require('http');
const { exec, spawnSync } = require('child_process');
const { ethers } = require('ethers');
const lighter = require('./lib/lighter');
const config = require('./lib/config').load();

const PORT = 8766;
const wallet = (config.wallet || '').toLowerCase();

function python() {
  if (fs.existsSync(lighter.PYTHON)) return true;
  console.log('Installation du module Lighter (une seule fois, 1 à 2 minutes)...');
  const found = spawnSync('python', ['--version'], { shell: true, encoding: 'utf8' });
  if (found.status !== 0 || !/Python 3\./.test(found.stdout + found.stderr)) {
    console.log('Python 3 est nécessaire pour signer les ordres Lighter. Installe "Python 3.13" depuis le Microsoft Store (ou python.org), puis relance setup-lighter.bat.');
    return false;
  }
  const steps = [
    ['python', ['-m', 'venv', lighter.VENV]],
    [lighter.PYTHON, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', `lighter-sdk==${lighter.SDK_VERSION}`]],
  ];
  for (const [cmd, args] of steps) {
    const r = spawnSync(cmd, args, { stdio: 'inherit', shell: cmd === 'python' });
    if (r.status !== 0) {
      fs.rmSync(lighter.VENV, { recursive: true, force: true });
      console.log('Installation du module Lighter échouée. Vérifie ta connexion internet et relance setup-lighter.bat.');
      return false;
    }
  }
  return true;
}

const page = (account) => `<!doctype html><meta charset="utf-8"><title>PaperTradeBot - Lighter</title>
<body style="font-family:sans-serif;max-width:640px;margin:40px auto">
<h2>Autoriser le bot sur ton compte Lighter</h2>
<p>Compte attendu : <code>${wallet}</code> (compte Lighter n° ${account})</p>
<p>Tu vas signer un message (pas une transaction) qui commence par « Register Lighter Account ». Il autorise la clé du bot à passer des ordres sur ton compte Lighter. Elle ne peut envoyer des fonds que vers ta propre adresse.</p>
<p>Le bot ne touche pas à tes positions tant qu'il n'a rien à couvrir. S'il doit couvrir et que la marge manque, il peut réduire ta position BTC sur ce compte. Tes autres marchés ne sont jamais touchés.</p>
<div id="wallets"></div><pre id="out" style="white-space:pre-wrap"></pre>
<script>
const out = (t) => (document.getElementById('out').textContent = t);
const post = async (url, body) => { const r = await fetch(url, { method: 'POST', body: JSON.stringify(body) }); const t = await r.text(); if (!r.ok) throw new Error(t); return t; };
const seen = new Set();
function add(name, provider) {
  if (seen.has(provider)) return;
  seen.add(provider);
  const b = document.createElement('button');
  b.textContent = 'Signer avec ' + name;
  b.style.cssText = 'display:block;margin:8px 0;padding:10px 16px;font-size:16px';
  b.onclick = () => sign(provider).catch((e) => out('Erreur : ' + (e.message || e)));
  document.getElementById('wallets').appendChild(b);
}
async function sign(provider) {
  const [account] = await provider.request({ method: 'eth_requestAccounts' });
  out('Préparation...');
  const prep = JSON.parse(await post('/prepare', { account }));
  out('Vérifie sur ton wallet le message avant de valider :\\n\\n' + prep.text + '\\n\\nConfirme la signature (dans les 10 minutes)...');
  const signature = await provider.request({ method: 'personal_sign', params: [prep.hex, account] });
  out('Signature reçue, envoi à Lighter...');
  out(await post('/signature', { signature }));
}
window.addEventListener('eip6963:announceProvider', (e) => add(e.detail.info.name, e.detail.provider));
window.dispatchEvent(new Event('eip6963:requestProvider'));
setTimeout(() => { if (!seen.size && window.ethereum) add('le wallet du navigateur', window.ethereum); if (!seen.size) out('Aucun wallet détecté dans ce navigateur.'); }, 500);
</script>`;

const body = (req) =>
  new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 10000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(b || '{}'));
      } catch (e) {
        reject(new Error('requête illisible'));
      }
    });
    req.on('error', reject);
  });

// Only the signing page itself may post: other sites open in the browser are refused.
const ORIGIN = `http://127.0.0.1:${PORT}`;
const sameOrigin = (req) => req.headers.host === `127.0.0.1:${PORT}` && req.headers.origin === ORIGIN;

const registered = async (key) => (await lighter.apiKeys(key.account_index)).some((k) => k.api_key_index === key.api_key_index && k.public_key === key.public_key.replace(/^0x/, ''));

async function main() {
  if (!wallet) throw new Error('Aucun wallet dans config.json : lance d\'abord setup.bat.');
  if (!python()) return;
  const account = await lighter.accountIndex(wallet);
  if (account === null) throw new Error('Pas de compte Lighter pour ce wallet. Connecte-le une fois sur app.lighter.xyz et dépose des USDC, puis relance setup-lighter.bat.');

  const b = lighter.bridge();
  const existing = lighter.loadKey();
  if (existing && existing.account_index === account && (await registered(existing).catch(() => false))) {
    const check = await b.request('init', { url: lighter.URL_BASE, account_index: account, api_key_index: existing.api_key_index, private_key: existing.private_key });
    b.stop();
    if (check.ok) return console.log('La clé Lighter du bot est déjà autorisée et fonctionne. Rien à faire.');
  }

  const used = (await lighter.apiKeys(account)).map((k) => k.api_key_index);
  // 0 to 3 belong to Lighter's website and apps.
  const index = Array.from({ length: 251 }, (_, i) => i + 4).find((i) => !used.includes(i));
  if (index === undefined) throw new Error('plus aucun emplacement de clé API libre sur ce compte Lighter.');

  let pending = null; // { key, tx_type, tx_info, message }
  const server = http.createServer(async (req, res) => {
    const reply = (code, text) => {
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text);
    };
    try {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(page(account));
      }
      if (req.method === 'POST' && !sameOrigin(req)) return reply(403, 'Origine refusée.');
      if (req.method === 'POST' && req.url === '/prepare') {
        const from = String((await body(req)).account || '').toLowerCase();
        if (from !== wallet) return reply(400, `Mauvais compte sélectionné dans le wallet : ${from} (attendu ${wallet}).`);
        // A new key for each attempt: it stays in memory until Lighter has accepted it.
        const k = await b.request('newkey');
        if (!k.ok) return reply(500, `Clé non créée : ${k.error}`);
        const key = { account_index: account, api_key_index: index, private_key: k.private_key, public_key: k.public_key };
        const init = await b.request('init', { url: lighter.URL_BASE, account_index: account, api_key_index: index, private_key: key.private_key, unregistered: true });
        if (!init.ok) return reply(500, `Lighter injoignable : ${init.error}`);
        const prep = await b.request('prepare_key', { public_key: key.public_key, api_key_index: index, account_index: account });
        if (!prep.ok) return reply(500, `Préparation refusée : ${prep.error}`);
        pending = { key, ...prep };
        return reply(200, JSON.stringify({ text: prep.message, hex: ethers.hexlify(ethers.toUtf8Bytes(prep.message)) }));
      }
      if (req.method === 'POST' && req.url === '/signature') {
        if (!pending) return reply(400, 'Recharge la page et recommence.');
        const signature = String((await body(req)).signature || '');
        const signer = ethers.verifyMessage(pending.message, signature).toLowerCase();
        if (signer !== wallet) return reply(400, `Signature faite par ${signer}, pas par ${wallet}.`);
        const sent = await b.request('send_key', { tx_type: pending.tx_type, tx_info: pending.tx_info, signature });
        if (!sent.ok) return reply(500, `Lighter a refusé l'enregistrement : ${sent.error}. Recharge la page et recommence.`);
        const { key } = pending;
        pending = null;
        console.log('Enregistrement envoyé à Lighter, attente de la confirmation...');
        let ok = false;
        for (let i = 0; i < 40 && !ok; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          ok = await registered(key).catch(() => false);
        }
        if (ok) {
          lighter.saveKey(key);
          const check = await b.request('init', { url: lighter.URL_BASE, account_index: account, api_key_index: index, private_key: key.private_key });
          ok = check.ok;
        }
        const text = ok
          ? 'Clé Lighter autorisée et enregistrée dans .lighter-key.json (ne partage jamais ce fichier). Tu peux fermer cette page. Au prochain lancement, le bot couvrira ses positions Papertrade sur Lighter.'
          : 'Envoyé, mais pas encore confirmé après 2 minutes. Relance setup-lighter.bat pour vérifier.';
        console.log(text);
        reply(200, text);
        if (ok) {
          b.stop();
          server.close();
        }
        return;
      }
      reply(404, '');
    } catch (e) {
      console.log('Échec : ' + e.message);
      reply(500, 'Échec : ' + e.message);
    }
  });
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${PORT}/`;
    console.log(`Compte Lighter n° ${account}, emplacement de clé ${index}.`);
    console.log(`Ouvre ${url} dans le navigateur où se trouve ton wallet, puis signe.`);
    if (process.platform === 'win32') exec(`start "" "${url}"`);
  });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
