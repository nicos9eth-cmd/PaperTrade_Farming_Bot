'use strict';

// Reads config.json with messages its non-developer users can act on: a typo in the file
// (missing comma, "0,5" instead of 0.5) is reported with its line instead of a stack trace,
// and a setting left out takes its default value.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  wallet: '',
  build: 'c23606f9dde9',
  targetMove: 0.01,
  closeAt: 0.85,
  minCloseAt: 0.5,
  reserve: 0.01,
  maxMarginPerLeg: null,
  maxNetLossUsd: 25,
  minMintRate: 10,
  maxCostPerPaper: 0.012,
  pauseWhenQueueActive: true,
  pollSeconds: 2,
  simulationCapital: null,
  alertAt: 0.8,
  urgentAt: 0.92,
  sound: true,
  openDeadlineSeconds: 300,
  oiSafetyFactor: 3,
  maxOrphanLegs: 3,
  riskSigmas: 4,
  baseDelaySeconds: 5,
};

// [min, max, null allowed]
const RANGES = {
  targetMove: [0.001, 0.1],
  closeAt: [0.1, 0.95],
  minCloseAt: [0.1, 0.95],
  reserve: [0, 0.5],
  maxMarginPerLeg: [1, Infinity, true],
  maxNetLossUsd: [0, Infinity, true],
  minMintRate: [0, 100],
  maxCostPerPaper: [0, Infinity, true],
  pollSeconds: [1, 60],
  simulationCapital: [1, Infinity, true],
  alertAt: [0.1, 1],
  urgentAt: [0.1, 1],
  openDeadlineSeconds: [60, 3600],
  oiSafetyFactor: [-Infinity, 100],
  maxOrphanLegs: [1, 20],
  riskSigmas: [0, 10],
  baseDelaySeconds: [0, 120],
};

function fail(msg) {
  return new Error(`config.json : ${msg}`);
}

function load() {
  let text;
  try {
    text = fs.readFileSync(FILE, 'utf8').replace(/^﻿/, ''); // Notepad may add a BOM
  } catch (e) {
    throw fail('fichier introuvable à côté de bot.js');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const at = Number((e.message.match(/position (\d+)/) || [])[1]);
    const line = Number.isFinite(at) ? text.slice(0, at).split('\n').length : null;
    throw fail(
      `erreur d'écriture${line ? ` vers la ligne ${line}` : ''}. Vérifie les virgules en fin de ligne, les guillemets, et que les nombres s'écrivent avec un point (0.5, pas 0,5).`
    );
  }
  const config = { ...DEFAULTS, ...raw };
  for (const [name, [min, max, nullable]] of Object.entries(RANGES)) {
    const v = config[name];
    if (v === null && nullable) continue;
    if (typeof v !== 'number' || !Number.isFinite(v))
      throw fail(`"${name}" doit être un nombre sans guillemets${nullable ? ' (ou null)' : ''}, écrit avec un point : ${JSON.stringify(v)} n'est pas valide.`);
    if (v < min || v > max) throw fail(`"${name}" vaut ${v}, il doit être entre ${min} et ${max}.`);
  }
  if (config.minCloseAt > config.closeAt) throw fail(`"minCloseAt" (${config.minCloseAt}) doit être plus petit que "closeAt" (${config.closeAt}).`);
  if (typeof config.wallet !== 'string' || (config.wallet && !/^0x[0-9a-fA-F]{40}$/.test(config.wallet)))
    throw fail(`"wallet" doit être une adresse 0x… de 42 caractères entre guillemets, ou "" pour laisser setup.bat la remplir.`);
  for (const name of ['pauseWhenQueueActive', 'sound'])
    if (typeof config[name] !== 'boolean') throw fail(`"${name}" doit valoir true ou false, sans guillemets.`);
  return config;
}

// Writes config.json back, e.g. once setup.bat knows the wallet.
function save(config) {
  fs.writeFileSync(FILE, JSON.stringify(config, null, 2) + '\n');
}

module.exports = { load, save, DEFAULTS, FILE };
