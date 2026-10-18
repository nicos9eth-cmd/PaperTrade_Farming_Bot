# PaperTradeBot

Bot qui farme le token PAPER sur [Papertrade](https://exchange.papertrade.xyz) tout seul, au coût le plus bas possible.

**Le principe.** Papertrade donne du PAPER quand on perd un trade. Le bot ouvre en même temps un long et un short BTC de même taille : l'un perd (et rapporte du PAPER), l'autre gagne presque autant. Il ferme les deux avant que le perdant soit liquidé, puis recommence. Le coût réel d'un cycle est la petite part que Papertrade prélève sur le trade gagnant.

**La fenêtre à 100 PAPER par dollar.** Le taux de mint dépend de la réserve (LP) de Papertrade. Tant que le LP est au-dessus de 2 M $, le taux baisse avec le temps : ~12 PAPER par dollar perdu mi-octobre 2026. Si le LP passe sous 2 M $, chaque dollar perdu rapporte 100 PAPER. Le bot surveille ce seuil en permanence. Il encaisse alors la paire en cours dès que ça vaut mieux que d'attendre, puis enchaîne des rotations courtes tant que la fenêtre reste ouverte (voir « Fenêtre LP < 2 M »).

**Ce n'est pas gratuit.** Chaque cycle coûte environ 3 à 6 % du capital engagé. Le PAPER ne peut pas être vendu pour l'instant, il rapporte seulement des dividendes en USDC quand il est staké. N'utilise que de l'argent que tu acceptes de dépenser.

**Outil expérimental, sans aucune garantie.** Il dépend d'une interface de Papertrade non documentée qui peut changer du jour au lendemain, et il passe des ordres avec de vrais fonds. Tu l'utilises à tes risques : tu peux perdre tout ce que tu engages, sur Papertrade comme sur Lighter. Voir `LICENSE` (MIT).

**En résumé :** installer Node.js → `installer.bat` → tester avec `bot-simulation.bat` → `setup.bat` (une signature) → **`reglages.bat`** (2 questions sur ton montant et ton budget) → `bot-live.bat`.

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

Un cycle ne se termine que quand le BTC a bougé d'environ 0,6 à 1 % (jusqu'à 2 % avec le levier prudent). Si le marché est calme, il peut ne rien se passer pendant des heures : c'est normal.

Pour voir ce que fait le bot pendant une fenêtre à 100 PAPER/$ sans attendre qu'elle arrive : ouvre un terminal dans le dossier du bot et tape `node bot.js --simuler-fenetre`. Ajoute `--simuler-lighter` pour simuler aussi un compte Lighter de 50 $ (couverture réactive comprise, si elle est activée dans `config.json`).

## 4. Autoriser le bot sur ton compte

1. Double-clique **`setup.bat`**. Une page s'ouvre dans ton navigateur.
2. Clique **« Signer avec … »** pour ton wallet. Sélectionne d'abord dans ton wallet le compte qui a tes fonds Papertrade.
3. Valide la signature dans ton wallet.
4. La page affiche **« Clé autorisée »**. Ton adresse est enregistrée toute seule dans `config.json`.

**Ce que tu signes.** Tu autorises une clé créée pour le bot à **ouvrir et fermer des positions** sur ton compte pendant 30 jours. Ce n'est pas une transaction, ça ne coûte rien, et cette clé **ne peut ni retirer tes fonds, ni staker, ni claim**. Vérifie que ton wallet affiche le contrat `0x6cd5661646289FB6E65EA5C032310fDEd797D0a2` (l'Exchange de Papertrade).

**Avec une Ledger :** déverrouille-la et ouvre l'application Ethereum avant de cliquer. Si elle refuse le message ou n'affiche rien, active « Blind signing » dans les réglages de l'application Ethereum, puis recommence.

Le bot ne te demandera **jamais** ta seed ni ta clé privée. Sa clé est rangée dans `.session-key.json` : **ne l'envoie à personne**. Au bout de 30 jours, relance `setup.bat`.

## 5. Régler le bot selon ton montant

**Ne lance pas le bot avec les réglages par défaut** : ils sont faits pour un compte d'environ 25 $. Double-clique **`reglages.bat`**. Il lit :

- ton solde Papertrade et tes PAPER stakés ;
- ton compte Lighter, s'il existe : la couverture est-elle activée, et quelle part d'une jambe peut-elle couvrir ;
- la congestion du relayer en ce moment, et le taux de mint.

Puis il te **recommande des réglages complets pour ton solde**, en expliquant pourquoi :

- le levier (**normal** ou **prudent**, voir plus bas) et le temps à partir duquel le bot attendra pendant les congestions ;
- la couverture Lighter : complète, partielle (avec le montant à ajouter pour la compléter) ou absente ;
- le coût et le PAPER attendus par cycle ;
- un budget d'environ 10 cycles ;
- le prix maximum du PAPER au-delà duquel le bot arrête d'ouvrir. Le taux de mint baisse avec le temps, donc ce prix monte : la recommandation garde de la marge.

Appuie sur **Entrée** pour appliquer la recommandation, ou tape **P** pour choisir chaque réglage toi-même : montant engagé, levier, budget, prix maximum. Avant d'enregistrer, il affiche ce qui change (par exemple « Levier x61 -> x56 »). Relance-le quand tu déposes ou retires des fonds (sur Papertrade ou sur Lighter), ou pour remettre un budget.

Au démarrage, `bot-live.bat` rappelle aussi ces chiffres et prévient si le budget ne couvre même pas un cycle.

La suite explique les mêmes réglages pour ceux qui préfèrent modifier **`config.json`** à la main (clic droit → Ouvrir avec → Bloc-notes).

### Combien ça coûte et combien ça rapporte

Le bot met **tout ton solde disponible** en jeu, moitié par jambe. Estimations par cycle au levier normal, au taux de mint du 18/10/2026 (~11,8 PAPER par dollar perdu, en baisse avec le temps) :

| Solde sur Papertrade | Coût d'un cycle | PAPER gagnés par cycle |
|---|---|---|
| 25 $ | 0,90 – 1,40 $ | 70 – 120 |
| 50 $ | 1,75 – 2,75 $ | 140 – 235 |
| 100 $ | 3,50 – 5,50 $ | 275 – 470 |
| 250 $ | 9 – 14 $ | 690 – 1 170 |
| 500 $ | 18 – 28 $ | 1 380 – 2 350 |
| 1 000 $ | 35 – 55 $ | 2 760 – 4 690 |

Le prix de revient tourne autour de **0,012 $ par PAPER**, quel que soit le montant. Il monte à mesure que le taux de mint baisse. Au-delà de `maxCostPerPaper`, ou sous `minMintRate`, le bot se met **en veille** : il n'ouvre plus, mais il continue de surveiller le LP et repart tout seul si une fenêtre à 100 PAPER/$ s'ouvre. Le haut de chaque fourchette correspond à un marché calme, où le bot ferme tard. Le bas correspond à un marché agité ou un réseau congestionné, où il ferme plus tôt par sécurité : moins de PAPER par cycle, pour un prix de revient un peu plus élevé. Le nombre de cycles par jour dépend de la volatilité du BTC, en général entre 0 et 3.

### Le réglage le plus important : le budget

`maxNetLossUsd` est **le total que tu acceptes de dépenser**. Une fois atteint, le bot n'ouvre plus de paire. **La valeur par défaut (25 $) est faite pour un petit compte** : avec 500 $, un seul cycle la dépasse et le bot s'arrête après le premier.

Règle simple : **budget = coût d'un cycle × nombre de cycles voulus**. Exemple : 100 $ sur le compte et 10 cycles voulus, donc `"maxNetLossUsd": 50`.

Le budget est mémorisé d'un lancement à l'autre. Pour repartir de zéro, change sa valeur. `null` veut dire sans limite (déconseillé).

### Levier normal ou prudent

À marge égale, **le PAPER gagné par cycle ne dépend presque pas du levier** : la perte de la jambe perdante vaut à peu près sa marge × le seuil de clôture. Baisser le levier met donc la liquidation plus loin sans rien coûter par cycle (c'est même un peu moins cher par PAPER). Le prix à payer : le BTC doit bouger davantage, donc **les cycles sont plus rares**.

| | Normal | Prudent |
|---|---|---|
| Levier | ~82× | le plus bas possible en gardant 1 000 $ de taille par position, sans viser plus de 2 % de mouvement (61× avec 33 $, 42× à partir de ~50 $) |
| Clôture vers | 1 % de mouvement | 1,3 à 2 % |
| Liquidation | 1,17 % | 1,6 à 2,3 % |
| Cycles | plus fréquents | 1,8 à 4 fois plus rares |

Le prudent est conseillé si ta connexion est instable, si tu ne surveilles pas, ou les jours d'annonces économiques (CPI, FOMC) où le réseau Papertrade sature et où une clôture peut mettre de longues minutes à passer. Le normal farme plus vite, ce qui compte aussi puisque le taux de mint baisse avec le temps.

Le choix se fait dans `reglages.bat` ; à la main, c'est `targetMove` (0.01 = normal, jusqu'à 0.0198 = prudent maximal). Le levier n'est choisi qu'à l'ouverture d'une paire : changer le réglage ne touche pas une paire déjà ouverte, il s'applique au cycle suivant après relance du bot.

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
| `maxCostPerPaper` | Le bot se met en veille si un PAPER coûterait plus que ce montant en $ (hors fenêtre). | 0.012 |
| `minMintRate` | Le bot se met en veille si Papertrade donne moins de ce nombre de PAPER par dollar perdu (hors fenêtre). | 10 |
| `burstMaxCostPerPaper` | Pendant une fenêtre LP < 2 M : prix maximum d'un PAPER pour les rotations courtes. Plus bas = rotations plus longues et moins de PAPER par heure. | 0.004 |
| `lighterScalp` | Couverture réactive de la jambe qui perd, sur Lighter, pendant chaque paire (expérimental, voir « Couverture sur Lighter »). | false |
| `lighterScalpMaxLossUsd` | Perte en $ de la couverture réactive, sur une session, au-delà de laquelle le bot l'arrête. | 5 |
| `closeAt` | Part du chemin vers la liquidation à laquelle le bot ferme au plus tard (0.85 = 85 %). | 0.85 |
| `minCloseAt` | Jusqu'où il peut avancer la clôture quand le marché s'agite ou que le réseau est congestionné. | 0.5 |
| `targetMove` | Mouvement de prix visé avant clôture (0.01 = 1 %). Plus grand = levier plus bas (voir « Levier normal ou prudent »). Avec peu de capital, la taille minimale de Papertrade impose un levier plancher. | 0.01 |
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
| **`reglages.bat`** | Assistant : règle le montant engagé et le budget selon ton solde. |
| `alertes.bat` | Ne trade pas : bipe quand il faut fermer ta paire à la main. |

Laisse la fenêtre noire ouverte. Pour arrêter : **Ctrl+C**, ou ferme la fenêtre. **Les positions ouvertes restent alors ouvertes, sans surveillance** : relance le bot (il les reprend) ou ferme-les sur le site.

### Lire le tableau de bord

- **MARCHÉ** : prix du BTC, taux de mint (PAPER gagné par dollar perdu), LP de Papertrade face au seuil de 2 M $ (« FENÊTRE OUVERTE » en vert quand il est passé dessous) et place libre dans l'open interest. Si un côté affiche « PLEIN », le bot attend avant d'ouvrir.
- **RELAYER** : la congestion chez Papertrade (les mêmes chiffres que l'onglet Status du site).
- **COMPTE** : ton solde disponible, ta marge engagée et ton PAPER.
- **PAPER** : le prix du PAPER, ce que vaut ton PAPER, et ce que vaut le PAPER farmé depuis le lancement face à ce qu'il a coûté (« gain estimé »). Le prix vient du marché en pré-lancement `para:PAPER` sur Hyperliquid, ouvert le 18/10/2026 alors que le token n'est pas encore transférable. C'est une estimation qui peut beaucoup bouger, pas un prix auquel tu peux vendre. Le bot ne s'en sert que pour l'affichage : aucune décision n'en dépend. Il est relu toutes les 30 s ; s'il n'a pas pu être lu depuis 10 min, la ligne affiche « prix du PAPER indisponible ».
- **PAIRE** : la paire en cours. La jauge avance vers la liquidation ; le `|` marque l'endroit où le bot ferme.
- **SESSION** : cycles, coût total, PAPER gagné et prix de revient depuis le lancement.
- **ÉTAT** : ce que le bot fait, ou pourquoi il attend. À la suite, la version du bot qui tourne : **en vert** si c'est la dernière publiée, **en rouge** si une nouvelle version existe (lance alors `mettre-a-jour.bat`, voir « Mettre à jour le bot »).

Tout est aussi écrit dans `bot.log`, et chaque cycle dans `journal.csv` (ouvrable avec Excel).

## Fenêtre LP < 2 M (100 PAPER par dollar)

Papertrade calcule le taux de mint d'après sa réserve (LP), celle qui paie les gains des traders. Au-dessus de 2 M $, le taux suit une courbe qui baisse avec le temps (~11,8 PAPER par dollar perdu le 18/10/2026). **Sous 2 M $, chaque dollar perdu rapporte 100 PAPER**, soit plus de 8 fois plus. Le tableau de bord montre le LP et la distance au seuil (ligne MARCHÉ).

Le LP ne passe sous 2 M $ que si les traders gagnent en tout près de 3 M $ de plus que ce qu'ils perdent. C'est rare : ça ne s'est pas produit depuis le lancement. La fenêtre se referme vite, parce que les pertes de tous ceux qui farment remplissent la réserve. Le bot la guette donc en permanence, sans rien dépenser :

- il relit le LP toutes les 10 s, et toutes les 2 s quand il s'approche du seuil ;
- dès que la fenêtre s'ouvre, il **clôture la paire en cours** si sa perte, mintée à 100 PAPER/$, rapporte déjà autant que sa clôture habituelle au taux bas. Avec le taux du 18/10, c'est le cas dès ~10 % du chemin vers la liquidation ;
- il **enchaîne des rotations courtes**. Il choisit le levier et le point de clôture qui donnent le plus de PAPER par heure, sans dépasser `burstMaxCostPerPaper` par PAPER, et en gardant assez de distance à la liquidation pour les délais du moment. Il ne relance pas plus d'un cycle toutes les 20 s. Le journal indique, pour ta taille, la perte en $ à laquelle chaque rotation se clôture ;
- quand le LP repasse au-dessus de 2 M $, la paire en cours reprend les règles habituelles.

Estimations par rotation dans la fenêtre, marché calme (`reglages.bat` donne les chiffres pour ton solde) :

| Solde | Levier | Clôture dès | Coût | PAPER | Durée | Budget dépensé par heure |
|---|---|---|---|---|---|---|
| 25 $ | x587 | 3,65 $ de perte | 1,43 $ | ~360 | ~70 s | ~74 $ |
| 100 $ | x587 | 14,60 $ de perte | 5,73 $ | ~1 430 | ~70 s | ~300 $ |
| 1 000 $ | x587 | 146 $ de perte | 57 $ | ~14 300 | ~70 s | ~3 000 $ |

Le PAPER y coûte ~0,004 $, trois fois moins qu'en temps normal. Mais **le budget part vite** : c'est le même `maxNetLossUsd` que d'habitude. Prévois-le en conséquence.

## Couverture sur Lighter (optionnel)

Le risque principal du farming : une clôture coincée de longues minutes dans la file du relayer pendant que le BTC chute ou monte d'un coup. La jambe perdante est liquidée, et l'autre reste ouverte sans couverture jusqu'à ce que sa clôture passe. Si le prix revient entre-temps, son gain fond. Ça s'est produit le 15/10 vers 4 h : un cycle a coûté 10 $ au lieu de ~1 $.

Avec un compte [Lighter](https://app.lighter.xyz) (perps sans frais), le bot couvre ce cas : dès qu'une jambe Papertrade passe son prix de liquidation, ou qu'une jambe reste seule, il prend sur Lighter la position inverse de l'autre jambe en moins d'une seconde. Il la referme quand la clôture Papertrade est passée. Quand la paire est complète, il n'y a rien sur Lighter.

Pour l'activer (une seule fois) :

1. Il faut un compte Lighter lié au **même wallet** que Papertrade, avec des USDC dessus. 20 $ couvrent ~900 $ de position : c'est une couverture partielle pour une jambe de ~1 000 $. 50 $ couvrent une jambe entière.
2. Il faut **Python 3** (« Python 3.13 » dans le Microsoft Store).
3. Double-clique **`setup-lighter.bat`**. Il installe le module officiel de Lighter, puis ouvre une page où tu signes un message avec ton wallet (pas une transaction). Le message commence par « Register Lighter Account ».

Ensuite, `bot-live.bat` affiche une ligne **LIGHTER** dans le tableau de bord. Sans `setup-lighter.bat`, ou si Lighter est injoignable, le bot reste uniquement sur Papertrade.

À savoir :

- **C'est nouveau (v1.7).** L'activation de la clé et les ordres Lighter (vente, rachat, levier) ont été testés en réel, et la couverture d'urgence a été rejouée en simulation sur la nuit du 15/10. Une vraie couverture pendant une vraie liquidation n'a pas encore eu lieu : surveille `bot.log` les premiers jours (lignes « Lighter : »).
- **Tes propres positions sur Lighter ne sont pas touchées tant qu'il n'y a rien à couvrir.** Pendant une couverture, l'ordre du bot s'ajoute à ta position BTC (un achat de couverture réduit un short que tu as, par exemple). Si la marge manque, le bot réduit ta position BTC pour couvrir en priorité. Il ne touche jamais tes autres marchés. À la fin, il ne défait que sa propre couverture, qu'il mémorise dans `.lighter-hedge.json` (ne supprime pas ce fichier pendant une couverture).
- Il règle le levier BTC de ce compte Lighter au maximum (x50), pour que peu de collatéral suffise.
- Si le collatéral Lighter ne suffit pas, la couverture est partielle, et le bot la réduit si le prix part contre elle, pour ne pas se faire liquider sur Lighter.
- Si Lighter peut couvrir une jambe entière, le bot ouvre aussi quand les clôtures sont lentes, au lieu d'attendre : le risque est couvert.
- Le résultat sur Lighter (gain ou perte de la couverture, funding) est compté dans les cycles, la session et le budget.
- La clé du bot est dans `.lighter-key.json` : **ne partage jamais ce fichier**. Elle peut passer des ordres et renvoyer des fonds vers ta propre adresse uniquement.

### Couverture réactive sur Lighter (expérimental, désactivée par défaut)

Avec `"lighterScalp": true` (ou la question 5 de `reglages.bat`, en mode P), le bot ne laisse plus Lighter vide pendant une paire : il y couvre la jambe qui perd. Prix au-dessus de l'ouverture de la paire : c'est le short qui perd, le bot est acheteur sur Lighter. Prix en dessous : c'est le long qui perd, il est vendeur.

- **Il change de côté dès que le prix repasse le prix d'ouverture**, au plus une fois toutes les 2 secondes. Il suit pour ça le prix BTC de Hyperliquid en direct (le prix sur lequel Papertrade se règle), mis à jour environ 5 fois par seconde, au lieu d'attendre le tour de 2 secondes du bot.
- **Comment il gagne et ce qu'il coûte.** À la clôture de la paire, il est du bon côté depuis le dernier passage du prix d'ouverture : ce dernier trade gagne. Chaque aller-retour avant coûte quelques centimes, parce qu'on réagit toujours un poil en retard et qu'on paie l'écart entre prix d'achat et de vente (Lighter ne prend pas de frais). Sur les 14 jours de prix d'octobre 2026, avec l'écart mesuré sur Lighter, le résultat était proche de zéro (entre -0,20 $ et +0,10 $ par jour selon la vitesse de réaction).
- **Il reste petit** : jamais plus de 10 fois ton collatéral Lighter, ni plus d'une jambe, et il ne touche jamais ta propre position Lighter pour se faire de la place. Sa taille est fixée à chaque changement de côté.
- **Elle s'arrête en même temps que la paire.** Quand le bot demande la clôture, elle reste en place tant que la clôture attend dans la file de Papertrade, et le bot la ferme quand la clôture est réellement exécutée.
- **La couverture d'urgence reste prioritaire.** Si une jambe Papertrade est liquidée ou reste seule, le bot remplace la couverture réactive par la couverture de la jambe restante (autant que le collatéral Lighter le permet), en un seul ordre, et clôture cette jambe.
- **Elle a son propre résultat**, affiché sur la ligne LIGHTER et à chaque fin de cycle (« couverture réactive Lighter »). Il compte dans le budget. Si elle perd plus que `lighterScalpMaxLossUsd` sur une session, le bot l'arrête jusqu'au prochain lancement.

À savoir honnêtement : elle ne rapporte **pas de PAPER** et ne réduit pas le coût des PAPER (ce coût vient de la part que Papertrade garde sur la jambe gagnante). Ta paire Papertrade est déjà équilibrée : l'intérêt est d'être toujours du bon côté si le prix part d'un coup, pour presque rien.

## Ce que le bot fait tout seul

- Il ferme plus tôt quand le marché est agité, que la file du relayer s'allonge ou que les ordres sont lents, pour éviter la liquidation. Il n'ouvre pas de paire quand la congestion est « HIGH ».
- Quand le réseau est saturé (grosse annonce économique, des centaines d'ordres en file), une clôture peut mettre plusieurs minutes à passer : le bot attend son tour sans la renvoyer. **Ne clique pas sur Close sur le site à ce moment-là** : ton ordre irait dans la même file.
- Il suit les mises à jour du site Papertrade et vérifie que le format des ordres n'a pas changé. Si le format change, il arrête d'ouvrir au lieu d'envoyer des ordres faux.
- Il note ce que chaque mise à jour de Papertrade a changé, puisque Papertrade ne publie pas de liste des changements : textes ajoutés ou retirés sur le site (boutons, messages d'erreur), parties du site modifiées, paramètres changés (levier max, taille minimum, haircut, mint). Double-clique sur `nouveautes.bat` pour lire le détail, la plus récente en haut. Les textes sont en anglais, comme sur le site.
- Il n'ouvre pas si l'open interest est plein, si le trading est en pause ou si la file de paiement est active : il attend et réessaie.
- Il continue malgré les petites coupures internet.
- Si une seule jambe s'ouvre, il la referme, attend de plus en plus longtemps, et abandonne après 3 fois de suite.
- Il gère **toutes** les positions BTC du compte, même celles ouvertes à la main : une position sans son opposée est fermée. **N'ouvre pas de BTC à la main pendant qu'il tourne.**
- Il se met en veille quand le PAPER devient trop cher ou que le taux de mint passe sous `minMintRate`. Il repart tout seul si le LP passe sous 2 M $ (100 PAPER par dollar perdu).
- Il arrête d'ouvrir quand le budget est atteint, quand le solde ne suffit plus, ou après 5 erreurs de suite. Les positions déjà ouvertes restent surveillées jusqu'à leur clôture.

## Ce qu'il ne fait pas

- **Staker le PAPER et réclamer les récompenses** : ça demande ta signature. À faire de temps en temps sur le site (onglet « Paper »).
- **Déposer ou retirer des USDC.**
- Empêcher toute liquidation : un mouvement très brutal ou une longue panne peut liquider la jambe perdante. Le cycle coûte alors un peu plus cher (moins avec la couverture Lighter).
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
| `budget atteint` | Normal : relance `reglages.bat` (ou augmente `maxNetLossUsd`) si tu veux continuer. |
| `veille, taux de mint … sous le plancher` ou `veille, coût attendu …` | Normal quand le taux de mint baisse : le bot ne dépense rien et surveille le LP. Il repart tout seul pendant une fenêtre à 100 PAPER/$. Pour farmer quand même au taux bas, baisse `minMintRate` ou monte `maxCostPerPaper` (avec `reglages.bat`). |
| `FENÊTRE OUVERTE : LP … sous 2.00 M` | Le LP est passé sous 2 M $ : rotations courtes à 100 PAPER/$, rien à faire. Surveille le budget. |
| `Couverture réactive Lighter arrêtée pour cette session` | Elle a perdu plus que `lighterScalpMaxLossUsd`. La couverture d'urgence continue. Elle reprend au prochain lancement. |
| `le budget restant couvre moins d'un cycle` | Lance `reglages.bat` pour adapter le budget à ton solde. |
| `PAPER staké … minimum de 1000` | Stake du PAPER sur le site, sinon le relayer peut refuser tes ordres. |
| `open interest … plein` / `relayer congestionné` | Normal, le bot attend tout seul. |
| `Couverture Lighter désactivée : …` | La clé Lighter ne fonctionne plus (retirée sur le site Lighter, ou Python absent). Relance `setup-lighter.bat`. En attendant, le bot tourne sur Papertrade seul. Le premier démarrage après un redémarrage du PC peut être lent (l'antivirus vérifie Python) : le bot attend jusqu'à 90 s. |
| `Lighter injoignable …` | Coupure côté Lighter : la couverture reprend toute seule dès que Lighter répond. |
| `clôtures trop lentes en ce moment … même au levier minimum` | Le relayer met trop de temps à exécuter les clôtures : une paire ouverte maintenant risquerait d'être liquidée avant sa clôture. Le bot attend que ça se calme. Avec plus de capital, il peut baisser le levier au lieu d'attendre (Papertrade impose une position d'au moins 1 000 $). |
| `Lecture impossible : …` puis `Lectures rétablies` | Petite coupure internet, rien à faire. |
| `prix du PAPER indisponible` | Hyperliquid ne répond pas, ou le marché `para:PAPER` a été retiré. Seul l'affichage est touché : le bot farme normalement. |
| `… -> HTTP 429` | Papertrade limite le nombre de connexions par connexion internet, et les onglets Papertrade ouverts dans ton navigateur comptent aussi. Le bot garde une seule connexion ouverte vers ton compte et patiente de plus en plus longtemps (jusqu'à 30 s) avant de réessayer. Si ça dure, ferme les onglets Papertrade en trop. |
| `le format des ordres a changé sur le site Papertrade` | Papertrade a modifié son site : lance `mettre-a-jour.bat` (une version adaptée peut mettre un peu de temps à sortir). |
| La page de `setup.bat` dit « Aucun wallet détecté » | Ouvre l'adresse affichée dans le navigateur où ton wallet est installé. |

Pour retirer l'autorisation du bot : supprime `.session-key.json`, et le bot ne peut plus rien faire. La révocation complète côté Papertrade se fait avec `revokeSessionKey` depuis ton wallet.

## Mettre à jour le bot

Double-clique **`mettre-a-jour.bat`**. Il télécharge la dernière version depuis GitHub et remplace les fichiers du bot. **Tes réglages (`config.json`), ta clé de session, ton budget et tes journaux sont conservés.** Si un téléchargement échoue, rien n'est modifié : relance-le plus tard.

Ensuite, si le bot tournait, ferme sa fenêtre et relance `bot-live.bat` : la nouvelle version n'est utilisée qu'au redémarrage.

Depuis la v1.9.1, le bot vérifie lui-même toutes les 30 min s'il existe une nouvelle version. Si c'est le cas, sa version s'affiche en rouge sur la ligne ÉTAT et le journal l'écrit.

`mettre-a-jour.bat` existe depuis la v1.6. Pour passer d'une version plus ancienne à la v1.6 (une seule fois) :

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

Vérifier les calculs : `npm test` (dans un terminal ouvert dans le dossier du bot).
