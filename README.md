# PaperTradeBot

Bot qui farme le token PAPER sur [Papertrade](https://exchange.papertrade.xyz) tout seul, au coût le plus bas possible.

**Le principe.** Papertrade donne du PAPER quand on perd un trade. Le bot ouvre en même temps un long et un short BTC de même taille : l'un perd (et rapporte du PAPER), l'autre gagne presque autant. Il ferme les deux juste avant que le perdant soit liquidé, puis recommence. Le coût réel d'un cycle est la petite part que Papertrade prélève sur le trade gagnant.

**Ce n'est pas gratuit.** Chaque cycle coûte de l'argent (environ 13 % de la perte du trade perdant). Le PAPER ne peut pas être vendu pour l'instant, il rapporte seulement des dividendes en USDC quand il est staké. N'utilise que de l'argent que tu acceptes de dépenser.

---

## Ce qu'il te faut

- Un PC Windows qui reste allumé (sans mise en veille) pendant que le bot tourne.
- Un compte Papertrade déjà utilisé, avec **au moins 25 USDC** disponibles (10 USDC minimum par jambe, plus une marge).
- Ton wallet (MetaMask, Rabby, Ledger branchée dessus, etc.) dans ton navigateur.
- [Node.js](https://nodejs.org) installé (bouton « LTS », installation par défaut).

## Installation (une seule fois)

1. Double-clique **`installer.bat`**. Attends la fin, puis ferme la fenêtre.
2. Double-clique **`setup.bat`**. Une page s'ouvre dans ton navigateur.
3. Sur cette page, clique **« Signer avec … »** pour ton wallet et valide la signature.
4. La page affiche **« Clé autorisée »**. C'est prêt.

**Ce que tu signes à l'étape 3.** Tu autorises une clé créée pour le bot à ouvrir et fermer des positions sur ton compte pendant 30 jours. C'est le même type d'autorisation que celle que le site te demande quand tu cliques « Connect ». Ce n'est pas une transaction, et cette clé **ne peut ni retirer tes fonds, ni staker, ni claim**. Avant de valider, vérifie que le contrat affiché par ton wallet est bien `0x6cd5661646289FB6E65EA5C032310fDEd797D0a2` (l'Exchange de Papertrade).

Le bot ne te demandera jamais ta seed ni ta clé privée. La clé du bot est rangée dans le fichier `.session-key.json` : **ne l'envoie à personne**.

## Lancer le bot

| Fichier | Ce qu'il fait |
|---|---|
| **`bot-simulation.bat`** | Fait tourner la stratégie au vrai prix **sans envoyer aucun ordre**. Idéal pour voir comment ça marche. |
| **`bot-live.bat`** | Mode réel : le bot trade avec ton solde Papertrade. |
| `alertes.bat` | Ne trade pas : bipe quand il faut fermer ta paire à la main. |

Pour arrêter : `Ctrl+C` dans la fenêtre noire, ou ferme-la. **Les positions ouvertes restent alors ouvertes, sans surveillance** : ferme-les sur le site ou relance le bot, qui les reprend.

## Lire le tableau de bord

- **MARCHÉ** : prix du BTC, taux de mint (PAPER gagné par dollar perdu) et place libre dans l'open interest. Si un côté affiche « PLEIN », le bot attend avant d'ouvrir.
- **RELAYER** : la congestion chez Papertrade (les mêmes chiffres que l'onglet Status du site : ordres en attente, temps pour vider la file).
- **COMPTE** : ton solde disponible, ta marge engagée et ton PAPER.
- **PAIRE** : la paire en cours. La jauge avance vers la liquidation ; le `|` marque l'endroit où le bot ferme.
- **SESSION** : nombre de cycles, coût total, PAPER gagné et prix de revient par PAPER depuis le lancement.
- **ÉTAT** : ce que le bot est en train de faire, ou pourquoi il attend.

Tout est aussi écrit dans `bot.log`, et chaque cycle dans `journal.csv` (ouvrable avec Excel).

## Ce que le bot fait tout seul

- Il utilise tout le solde disponible, moitié par jambe, avec le levier minimal accepté par Papertrade ($1 000 de taille minimale par position).
- Il ferme plus tôt quand le marché est agité, que la file du relayer s'allonge ou que les ordres sont lents, pour éviter la liquidation. Il n'ouvre pas de paire quand la congestion est « HIGH ».
- Il suit les mises à jour du site Papertrade : au démarrage puis toutes les 10 minutes, il relit la version du site et vérifie que le format des ordres n'a pas changé. Si le format change, il arrête d'ouvrir des paires au lieu d'envoyer des ordres faux.
- Il n'ouvre pas si l'open interest est plein, si le trading est en pause ou si la file de paiement de Papertrade est active : il attend et réessaie.
- Si une seule jambe s'ouvre, il la referme, attend de plus en plus longtemps, et abandonne après 3 fois de suite.
- Il gère **toutes** les positions BTC du compte, même celles ouvertes à la main : une position sans son opposée est fermée.
- Une clôture due passe avant tout le reste, même si d'autres ordres sont en attente chez le relayer.
- Il s'arrête d'ouvrir quand le budget est atteint, quand le PAPER devient trop cher, quand le solde ne suffit plus, ou après 5 erreurs de suite.

## Ce qu'il ne fait pas

- **Staker le PAPER et réclamer les récompenses** : ça demande ta signature. À faire de temps en temps sur le site (onglet « Paper »).
- Empêcher toute liquidation : un mouvement très brutal ou une panne de connexion peut liquider la jambe perdante. Le cycle coûte alors un peu plus cher.
- Fonctionner PC éteint ou en veille.

## Réglages (`config.json`)

Ouvre le fichier avec le Bloc-notes. Les valeurs par défaut conviennent pour commencer ; le réglage le plus utile est le budget.

| Réglage | Rôle | Défaut |
|---|---|---|
| `maxNetLossUsd` | **Budget** : coût total après lequel le bot n'ouvre plus de paire. Il est conservé d'un lancement à l'autre : pour repartir avec un nouveau budget, change cette valeur. | 25 |
| `maxCostPerPaper` | Arrêt si le prix de revient attendu du PAPER dépasse ce montant (en $). | 0.012 |
| `minMintRate` | Arrêt si le taux de mint passe sous cette valeur. | 10 |
| `maxMarginPerLeg` | Marge maximale par jambe, `null` pour utiliser tout le solde. | null |
| `closeAt` | À quelle part du chemin vers la liquidation le bot ferme, au plus tard. | 0.85 |
| `minCloseAt` | Jusqu'où il peut avancer la clôture quand le marché est agité. | 0.5 |
| `targetMove` | Mouvement de prix visé avant clôture (0.01 = 1 %). Avec peu de capital, c'est la taille minimale de Papertrade qui décide. | 0.01 |
| `pauseWhenQueueActive` | Attendre quand la file de paiement de Papertrade est active. | true |
| `sound` | Bips de `alertes.bat`. | true |

Réglages avancés, à ne pas toucher sans raison : `riskSigmas`, `baseDelaySeconds`, `openDeadlineSeconds`, `oiSafetyFactor`, `maxOrphanLegs`, `reserve`, `pollSeconds`, `simulationCapital`, `build` (détecté tout seul, valeur de secours), `alertAt`, `urgentAt`, `wallet` (rempli par `setup.bat`).

## En cas de problème

| Message | Quoi faire |
|---|---|
| `node n'est pas reconnu…` | Node.js n'est pas installé : installe-le puis relance `installer.bat`. |
| `Aucun wallet configuré` ou `Aucune clé de session` | Lance `setup.bat`. |
| `Clé de session absente ou expirée` | La clé dure 30 jours : relance `setup.bat`. |
| `Mauvais compte sélectionné dans le wallet` | Choisis le bon compte dans ton wallet, puis recharge la page. |
| `capital insuffisant` | Il faut au moins 10 USDC par jambe : dépose des fonds sur Papertrade. |
| `open interest … plein` | Normal, le bot attend qu'une place se libère. |
| `le format des ordres a changé sur le site Papertrade` | Papertrade a modifié son site : le bot doit être mis à jour, préviens la personne qui te l'a donné. |
| Le relayer refuse tout sur un compte neuf | Papertrade indique un minimum de 1 000 PAPER staké pour passer par son relayer. |

Pour retirer l'autorisation du bot à tout moment : supprime `.session-key.json` (le bot ne peut plus rien faire) ; la révocation complète côté Papertrade se fait avec `revokeSessionKey` depuis ton wallet.

## Donner le bot à quelqu'un

Double-clique **`partager.bat`** : il crée `partage\PaperTradeBot`, une copie propre sans ta clé, ton adresse ni tes journaux. Envoie ce dossier-là. **Ne donne jamais ton propre dossier ni `.session-key.json`.**

## Bon à savoir

Ce bot n'est pas un produit officiel de Papertrade. Il parle au même service que le site, dans un format relevé sur le site lui-même, qui peut changer sans prévenir. Lis les conditions d'utilisation de Papertrade avant de t'en servir.

Vérifier les calculs : `node test/economics.test.js` et `node test/risk.test.js`.
