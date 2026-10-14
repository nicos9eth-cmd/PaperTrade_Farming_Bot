# PaperTradeBot

Bot qui farme le token PAPER sur [Papertrade](https://exchange.papertrade.xyz) tout seul, au coût le plus bas possible.

**Le principe.** Papertrade donne du PAPER quand on perd un trade. Le bot ouvre en même temps un long et un short BTC de même taille : l'un perd (et rapporte du PAPER), l'autre gagne presque autant. Il ferme les deux avant que le perdant soit liquidé, puis recommence. Le coût réel d'un cycle est la petite part que Papertrade prélève sur le trade gagnant.

**Ce n'est pas gratuit.** Chaque cycle coûte environ 3 à 6 % du capital engagé. Le PAPER ne peut pas être vendu pour l'instant, il rapporte seulement des dividendes en USDC quand il est staké. N'utilise que de l'argent que tu acceptes de dépenser.

**Le résumé en 5 étapes :** installer Node.js → `installer.bat` → tester avec `bot-simulation.bat` → `setup.bat` (une signature) → régler le budget dans `config.json` → `bot-live.bat`.

---

## 1. Avant de commencer

Coche tout avant d'installer :

- [ ] Un **PC Windows** qui peut rester allumé, **sans mise en veille** (Paramètres → Système → Alimentation → Mise en veille : Jamais).
- [ ] **[Node.js](https://nodejs.org)** installé : bouton « LTS », puis Suivant partout.
- [ ] Un **compte Papertrade** sur lequel tu as déjà fait au moins un trade à la main.
- [ ] Des **USDC déposés sur Papertrade**, visibles en « Available » sur le site. Des USDC dans ton wallet ne suffisent pas, le bot ne peut pas les déposer. Minimum **25 USDC** (Papertrade impose 10 USDC par jambe).
- [ ] Ton **wallet** (Rabby, MetaMask, Ledger branchée sur l'un d'eux…) installé dans ton navigateur.
- [ ] Idéalement **1 000 PAPER stakés** : le relayer de Papertrade annonce ce minimum. Sans eux, les ordres risquent d'être refusés. Au démarrage, le bot te prévient s'il en manque.

## 2. Télécharger et installer (une seule fois)

1. Sur GitHub, clique **Code → Download ZIP**.
2. **Décompresse** le ZIP (clic droit → Extraire tout). Ne lance rien depuis l'intérieur du ZIP : ça ne marche pas.
3. Range le dossier où tu veux, par exemple sur le Bureau.
4. Double-clique **`installer.bat`**. Attends le message de fin, puis ferme la fenêtre.

## 3. Tester en simulation (recommandé)

Double-clique **`bot-simulation.bat`**. Le bot tourne au vrai prix du BTC, avec un capital fictif de 100 $, **sans rien envoyer**. Pas besoin de wallet pour ça.

Pour simuler avec ton propre montant, mets par exemple `"simulationCapital": 250` dans `config.json`. Remets `null` après le test.

Un cycle ne se termine que quand le BTC a bougé d'environ 0,6 à 1 %. Si le marché est calme, il peut ne rien se passer pendant des heures : c'est normal.

## 4. Autoriser le bot sur ton compte

1. Double-clique **`setup.bat`**. Une page s'ouvre dans ton navigateur.
2. Clique **« Signer avec … »** pour ton wallet. Sélectionne d'abord dans ton wallet le compte qui a tes fonds Papertrade.
3. Valide la signature dans ton wallet.
4. La page affiche **« Clé autorisée »**. Ton adresse est enregistrée toute seule dans `config.json`.

**Ce que tu signes.** Tu autorises une clé créée pour le bot à **ouvrir et fermer des positions** sur ton compte pendant 30 jours. Ce n'est pas une transaction, ça ne coûte rien, et cette clé **ne peut ni retirer tes fonds, ni staker, ni claim**. Vérifie que ton wallet affiche le contrat `0x6cd5661646289FB6E65EA5C032310fDEd797D0a2` (l'Exchange de Papertrade).

**Avec une Ledger :** déverrouille-la et ouvre l'application Ethereum avant de cliquer. Si elle refuse le message ou n'affiche rien, active « Blind signing » dans les réglages de l'application Ethereum, puis recommence.

Le bot ne te demandera **jamais** ta seed ni ta clé privée. Sa clé est rangée dans `.session-key.json` : **ne l'envoie à personne**. Au bout de 30 jours, relance `setup.bat`.

## 5. Régler le bot selon ton montant

Tout se règle dans **`config.json`**. Ouvre-le avec le Bloc-notes (clic droit → Ouvrir avec → Bloc-notes).

### Combien ça coûte et combien ça rapporte

Le bot met **tout ton solde disponible** en jeu, moitié par jambe. Estimations par cycle, au taux de mint actuel (~21 PAPER par dollar perdu, en baisse avec le temps) :

| Solde sur Papertrade | Coût d'un cycle | PAPER gagnés par cycle |
|---|---|---|
| 25 $ | 0,90 – 1,40 $ | 120 – 210 |
| 50 $ | 1,80 – 2,75 $ | 250 – 420 |
| 100 $ | 3,50 – 5,50 $ | 490 – 840 |
| 250 $ | 9 – 14 $ | 1 200 – 2 100 |
| 500 $ | 18 – 28 $ | 2 500 – 4 200 |
| 1 000 $ | 35 – 55 $ | 4 900 – 8 400 |

Le prix de revient tourne autour de **0,007 $ par PAPER**, quel que soit le montant. Le haut de chaque fourchette correspond à un marché calme, où le bot ferme tard. Le bas correspond à un marché agité ou un réseau congestionné, où il ferme plus tôt par sécurité : moins de PAPER par cycle, pour un prix de revient un peu plus élevé. Le nombre de cycles par jour dépend de la volatilité du BTC, en général entre 0 et 3.

### Le réglage le plus important : le budget

`maxNetLossUsd` est **le total que tu acceptes de dépenser**. Une fois atteint, le bot n'ouvre plus de paire. **La valeur par défaut (25 $) est faite pour un petit compte** : avec 500 $, un seul cycle la dépasse et le bot s'arrête après le premier.

Règle simple : **budget = coût d'un cycle × nombre de cycles voulus**. Exemple : 100 $ sur le compte et 10 cycles voulus, donc `"maxNetLossUsd": 50`.

Le budget est mémorisé d'un lancement à l'autre. Pour repartir de zéro, change sa valeur. `null` veut dire sans limite (déconseillé).

### Profils prêts à l'emploi

Remplace seulement ces lignes dans `config.json`, sans toucher au reste.

**Je découvre (risque minimal) :** une paire minuscule, quel que soit ton solde.
```
"maxMarginPerLeg": 10,
"maxNetLossUsd": 5,
```

**Je farme tranquille :** tout le solde, budget d'environ 10 cycles. Exemple pour 100 $ :
```
"maxMarginPerLeg": null,
"maxNetLossUsd": 50,
```

**Je garde une partie de mon solde :** par exemple 40 $ par jambe maximum (80 $ engagés), même s'il y a plus sur le compte.
```
"maxMarginPerLeg": 40,
```

### Écrire dans `config.json` sans erreur

- Nombres avec un **point** : `0.5`, pas `0,5`.
- Pas de guillemets autour des nombres, de `null`, de `true` ou de `false`.
- Garde la **virgule en fin de ligne**, sauf sur la dernière ligne avant `}`.
- En cas d'erreur, le bot ne démarre pas et te dit quelle ligne corriger.

### Tous les réglages

| Réglage | Rôle | Défaut |
|---|---|---|
| `maxNetLossUsd` | **Budget** total en $ (voir plus haut). | 25 |
| `maxMarginPerLeg` | Marge maximale par jambe en $, `null` pour utiliser tout le solde. Minimum 10. | null |
| `maxCostPerPaper` | Le bot n'ouvre plus si un PAPER coûterait plus que ce montant en $. | 0.012 |
| `minMintRate` | Le bot n'ouvre plus si Papertrade donne moins de ce nombre de PAPER par dollar perdu. | 10 |
| `closeAt` | Part du chemin vers la liquidation à laquelle le bot ferme au plus tard (0.85 = 85 %). | 0.85 |
| `minCloseAt` | Jusqu'où il peut avancer la clôture quand le marché s'agite ou que le réseau est congestionné. | 0.5 |
| `targetMove` | Mouvement de prix visé avant clôture (0.01 = 1 %). | 0.01 |
| `pauseWhenQueueActive` | Attendre quand la file de paiement de Papertrade est active. | true |
| `simulationCapital` | Capital fictif de la simulation, `null` pour ton vrai solde (ou 100 $ sans wallet). | null |
| `sound` | Bips de `alertes.bat`. | true |
| `wallet` | Ton adresse, remplie par `setup.bat`. | "" |

Réglages avancés, à ne pas toucher sans raison : `riskSigmas`, `baseDelaySeconds`, `openDeadlineSeconds`, `oiSafetyFactor`, `maxOrphanLegs`, `reserve`, `pollSeconds`, `build`, `alertAt`, `urgentAt`.

## 6. Lancer le bot

| Fichier | Ce qu'il fait |
|---|---|
| **`bot-live.bat`** | Mode réel : le bot trade avec ton solde Papertrade. |
| **`bot-simulation.bat`** | Même stratégie au vrai prix, **sans envoyer aucun ordre**. |
| `alertes.bat` | Ne trade pas : bipe quand il faut fermer ta paire à la main. |

Laisse la fenêtre noire ouverte. Pour arrêter : **Ctrl+C**, ou ferme la fenêtre. **Les positions ouvertes restent alors ouvertes, sans surveillance** : relance le bot (il les reprend) ou ferme-les sur le site.

### Lire le tableau de bord

- **MARCHÉ** : prix du BTC, taux de mint (PAPER gagné par dollar perdu) et place libre dans l'open interest. Si un côté affiche « PLEIN », le bot attend avant d'ouvrir.
- **RELAYER** : la congestion chez Papertrade (les mêmes chiffres que l'onglet Status du site).
- **COMPTE** : ton solde disponible, ta marge engagée et ton PAPER.
- **PAIRE** : la paire en cours. La jauge avance vers la liquidation ; le `|` marque l'endroit où le bot ferme.
- **SESSION** : cycles, coût total, PAPER gagné et prix de revient depuis le lancement.
- **ÉTAT** : ce que le bot fait, ou pourquoi il attend.

Tout est aussi écrit dans `bot.log`, et chaque cycle dans `journal.csv` (ouvrable avec Excel).

## Ce que le bot fait tout seul

- Il ferme plus tôt quand le marché est agité, que la file du relayer s'allonge ou que les ordres sont lents, pour éviter la liquidation. Il n'ouvre pas de paire quand la congestion est « HIGH ».
- Quand le réseau est saturé (grosse annonce économique, des centaines d'ordres en file), une clôture peut mettre plusieurs minutes à passer : le bot attend son tour sans la renvoyer. **Ne clique pas sur Close sur le site à ce moment-là** : ton ordre irait dans la même file.
- Il suit les mises à jour du site Papertrade et vérifie que le format des ordres n'a pas changé. Si le format change, il arrête d'ouvrir au lieu d'envoyer des ordres faux.
- Il n'ouvre pas si l'open interest est plein, si le trading est en pause ou si la file de paiement est active : il attend et réessaie.
- Il continue malgré les petites coupures internet.
- Si une seule jambe s'ouvre, il la referme, attend de plus en plus longtemps, et abandonne après 3 fois de suite.
- Il gère **toutes** les positions BTC du compte, même celles ouvertes à la main : une position sans son opposée est fermée. **N'ouvre pas de BTC à la main pendant qu'il tourne.**
- Il arrête d'ouvrir quand le budget est atteint, quand le PAPER devient trop cher, quand le solde ne suffit plus, ou après 5 erreurs de suite. Les positions déjà ouvertes restent surveillées jusqu'à leur clôture.

## Ce qu'il ne fait pas

- **Staker le PAPER et réclamer les récompenses** : ça demande ta signature. À faire de temps en temps sur le site (onglet « Paper »).
- **Déposer ou retirer des USDC.**
- Empêcher toute liquidation : un mouvement très brutal ou une longue panne peut liquider la jambe perdante. Le cycle coûte alors un peu plus cher.
- Fonctionner PC éteint ou en veille.

## En cas de problème

| Message | Quoi faire |
|---|---|
| `node n'est pas reconnu…` | Node.js n'est pas installé : installe-le, redémarre le PC, relance `installer.bat`. |
| `Cannot find module…` | `installer.bat` n'a pas été lancé, ou le dossier est encore dans le ZIP. |
| `config.json : …` | Une faute de frappe dans `config.json` : le message dit quoi corriger (voir « Écrire dans config.json »). |
| `Aucun wallet configuré` / `Aucune clé de session` | Lance `setup.bat`. |
| `Clé de session absente ou expirée` | La clé dure 30 jours : relance `setup.bat`. |
| `Mauvais compte sélectionné dans le wallet` | Choisis le compte qui a tes fonds Papertrade dans ton wallet, puis recharge la page. |
| `capital insuffisant` | Il faut au moins 10 USDC par jambe **déposés sur Papertrade**. |
| `budget atteint` | Normal : augmente `maxNetLossUsd` si tu veux continuer. |
| `PAPER staké … minimum de 1000` | Stake du PAPER sur le site, sinon le relayer peut refuser tes ordres. |
| `open interest … plein` / `relayer congestionné` | Normal, le bot attend tout seul. |
| `Lecture impossible : …` puis `Lectures rétablies` | Petite coupure internet, rien à faire. |
| `le format des ordres a changé sur le site Papertrade` | Papertrade a modifié son site : télécharge la dernière version du bot. |
| La page de `setup.bat` dit « Aucun wallet détecté » | Ouvre l'adresse affichée dans le navigateur où ton wallet est installé. |

Pour retirer l'autorisation du bot : supprime `.session-key.json`, et le bot ne peut plus rien faire. La révocation complète côté Papertrade se fait avec `revokeSessionKey` depuis ton wallet.

## Mettre à jour le bot

1. Arrête le bot (Ctrl+C).
2. Télécharge la nouvelle version (Code → Download ZIP) et décompresse-la dans un **nouveau** dossier.
3. Copie dans le nouveau dossier **`config.json`**, **`.session-key.json`** et **`.budget.json`** depuis l'ancien. Les fichiers commençant par un point peuvent être cachés : dans l'Explorateur, Affichage → Afficher → Éléments masqués.
4. Lance `installer.bat` dans le nouveau dossier, puis `bot-live.bat`.

## Plusieurs wallets

Un dossier par wallet : copie le dossier du bot, supprime `.session-key.json` et `.budget.json` dans la copie, vide `"wallet"` dans son `config.json`, puis lance son `setup.bat` avec l'autre compte sélectionné.

## Donner le bot à quelqu'un

Envoie-lui le lien GitHub, ou double-clique **`partager.bat`** : il crée `partage\PaperTradeBot`, une copie propre sans ta clé, ton adresse ni tes journaux. **Ne donne jamais ton propre dossier ni `.session-key.json`.**

## Bon à savoir

Ce bot n'est pas un produit officiel de Papertrade. Il parle au même service que le site, dans un format relevé sur le site lui-même, qui peut changer sans prévenir. Lis les conditions d'utilisation de Papertrade avant de t'en servir.

Vérifier les calculs : `node test/economics.test.js` et `node test/risk.test.js`.
