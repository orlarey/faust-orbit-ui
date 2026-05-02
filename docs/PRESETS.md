# Spécification des presets FX

## Cadrage

Ce document fixe le vocabulaire et les invariants des **trajectoires** et **presets** d'effets DSP Faust. Il précède tout choix d'implémentation. L'objectif est que chaque terme ait un sens unique et que l'on puisse parler de production, navigation, mémorisation et rappel sans ambiguïté.

## Définitions mathématiques

### Paramètre

Un DSP Faust expose un ensemble **fini** de paramètres :

$$P = \{p_1, p_2, \dots, p_n\}$$

Chaque paramètre $p_i$ porte :

- une **adresse** unique (chaîne, ex. `"/reverb/wet"`)
- un **domaine** $D(p_i)$ de valeurs autorisées (intervalle continu discrétisé par un pas, ensemble de catégories, booléen)
- une **valeur d'initialisation** $d(p_i) \in D(p_i)$ fournie par le DSP

### Configuration

Une **configuration** pour un DSP donné est un mapping total :

$$c : P \to \bigcup_i D(p_i) \quad \text{tel que} \quad c(p_i) \in D(p_i) \ \forall p_i \in P$$

### Espace des paramètres

L'ensemble des configurations possibles :

$$E(\text{dsp}) = \prod_i D(p_i)$$

### Configuration par défaut

Pour chaque DSP, une configuration unique :

$$c_{\text{default}}(p_i) = d(p_i) \quad \forall p_i$$

Elle existe sans action utilisateur.

### Trajectoire (vue mathématique)

Pour une instance d'effet, l'interaction produit une fonction constante par morceaux :

$$T : \mathbb{R}_{\geq 0} \to E(\text{dsp})$$

avec $T(0) = c_{\text{default}}$, discontinue aux instants de commits de geste.

## Représentation opérationnelle

### Log de trajectoire

La trajectoire est persistée comme un **log append-only** :

$$L = [e_0, e_1, \dots, e_h] \qquad e_i = (t_i, c_i)$$

où $t_i$ est le timestamp du commit et $c_i \in E$ la configuration commise. Le log est ordonné chronologiquement. Un événement ne peut être retiré que par éviction FIFO quand la capacité maximale est atteinte.

### HEAD

**HEAD** est l'index du dernier événement du log ($h$). Il désigne la configuration « réelle » appliquée par défaut à l'instance.

### Cursor

Le **cursor** est un index interne dans le log, utilisé exclusivement par
le mécanisme de commit depuis cursor détaché (cf. §"Commit de geste depuis
cursor détaché" plus bas). Il n'est **pas exposé dans l'UI niveau 1
actuel** : aucun marqueur ne le représente sur le calque, aucune touche ne
le déplace. Il reste à HEAD en pratique, sauf si une future extension
réintroduit la consultation d'événements antérieurs.

Propriétés (héritage du modèle initial, gardées pour extensions futures) :

- Ne modifie ni le log ni HEAD
- Détermine la configuration appliquée à l'audio tant qu'il est détaché
- Revient à HEAD après tout nouveau commit de geste

## Stockages

| Propriété | Trajectoire | Bibliothèque de presets |
| --- | --- | --- |
| **Clé d'identification** | $(\text{sessionId}, \text{effectInstanceId})$ | $(\text{uiHash}, c)$ par contenu |
| **Attribution GC** | $(\text{sessionId}, \text{effectInstanceId})$ | $(\text{sessionId}, \text{uiHash})$ |
| **Visibilité** | Locale à la session et à l'instance | Workspace-wide |
| **Dédup** | Aucune — log chronologique | Par contenu |
| **Durée de vie** | Tant que l'instance existe dans la session (état courant OU undo-reachable) | Tant qu'au moins une session vivante la référence |
| **Capacité** | Bornée à $N$ événements (≈ 500), éviction FIFO | Illimitée jusqu'au GC |

## Opérations

### Commit de geste (cursor aligné sur HEAD)

Quand l'utilisateur termine un geste depuis HEAD produisant $c_{\text{new}}$ :

1. Le log est étendu : $L' = [e_0, \dots, e_h, e_{\text{new}}]$ avec $e_{\text{new}} = (t_{\text{now}}, c_{\text{new}})$
2. HEAD avance au nouvel événement
3. Cursor s'aligne sur HEAD

### Navigation (cycle dans la bibliothèque)

Les touches **←** et **→** déplacent le centre niveau 1 d'un preset à un
autre, **dans la bibliothèque** ordonnée par `lastSeenAt` croissant. La
navigation est cyclique : après le dernier preset, on revient au premier
et inversement. Le glissement est continu (cf. §"Transitions dynamiques",
portamento $T_p$) — les flèches ne sont pas un saut instantané.

La cycle parcourt **chaque entrée de la bibliothèque une seule fois**
(dédup par contenu). Les revisites enregistrées dans la trajectoire
n'apparaissent pas comme des étapes distinctes.

Note historique : un design antérieur prévoyait que les flèches naviguent
dans le log de trajectoire avec doublons possibles. Ce comportement a été
remplacé par le cycle bibliothèque parce qu'il colle mieux au modèle
mental « un preset = un point unique sur la carte ».

### Commit de geste depuis cursor détaché

Soit cursor à l'index $k < h$ au moment où l'utilisateur produit une modification $c_{\text{new}}$.

**Le chemin de retour vers HEAD est appendé**, suivi de la modification :

$$L' = [e_0, \dots, e_h, e_{h-1}, e_{h-2}, \dots, e_k, e_{\text{new}}]$$

où les événements appendés portent le timestamp courant (ce sont de **nouveaux événements**, même s'ils réutilisent les configurations historiques).

Après quoi :

- HEAD devient le nouvel index (l'indice de $e_{\text{new}}$)
- Cursor s'aligne sur HEAD
- Aucune donnée n'est perdue ; la trajectoire enregistre le détour réel

### Mémorisation (promotion trajectoire → bibliothèque)

Un événement de trajectoire est **promu** dans la bibliothèque workspace si simultanément :

1. Il s'est écoulé $\geq X$ secondes depuis son commit sans nouveau geste
2. La lecture audio est active pendant ce dwell
3. L'effet n'est pas bypassé

La promotion crée ou met à jour un preset dans la bibliothèque.

Si un preset de même $(\text{uiHash}, c)$ existe déjà :

- `firstSeenAt` reste inchangé
- `lastSeenAt` est mis à jour à l'instant de promotion
- L'entrée remonte dans l'ordre chronologique par `lastSeenAt`

### Rappel d'un preset

Rappeler un preset $(h, c^*)$ depuis la bibliothèque applique $c^*$ comme une modification standard :

- Équivalent à un commit de geste vers $c^*$
- Si cursor était détaché, le chemin de retour est appendé avant le rappel (règle de modification depuis cursor détaché)
- Le rappel n'ajoute pas d'entrée à la bibliothèque (sauf si dwell > $X$ après le rappel)

## Visualisation niveau 0 : orbit-ui des paramètres

Le niveau 0 est l'UI orbit-ui existante : chaque paramètre $p_i$ du DSP est représenté par un point dans un canvas 2D. La position du point encode la valeur courante $v_i$ par la distance au centre. L'utilisateur pilote les valeurs en déplaçant le centre (tous les paramètres évoluent) ou en déplaçant un paramètre individuellement (une seule valeur change).

### Invariant de source de vérité

Les **valeurs des paramètres** $v_i$ sont l'état canonique. Les **positions** $\text{pos}_i$ dans le canvas sont un encodage visuel dérivé, maintenu cohérent avec les valeurs à tout instant.

Formellement, à tout instant :

$$v_i = \Phi\bigl(|C - \text{pos}_i|,\ \min_i,\ \max_i,\ r_{\text{inner}},\ r_{\text{outer}}\bigr)$$

où $\Phi$ encode la distance en valeur :

- distance $\leq r_{\text{inner}}$ → $\max_i$ (saturé haut)
- distance $\geq r_{\text{outer}}$ → $\min_i$ (saturé bas)
- sinon → interpolation linéaire entre $\min_i$ et $\max_i$ sur $[r_{\text{inner}}, r_{\text{outer}}]$

### Règle de mouvement minimal

Quand une valeur $v_i$ change par source externe (slider du detail panel, écriture Shepard niveau 1), la position $\text{pos}_i$ ne se met à jour **que si elle n'encode plus la valeur dans la tolérance du pas** ($\text{step}_i / 2$). Si la position courante produit déjà la nouvelle valeur via $\Phi$ — cas typique en zone saturée haut ou bas — aucun mouvement.

Cela évite le jitter visuel dans les zones où de petites variations de valeur ne sont pas résolvables par un changement de position.

### Préservation de l'angle

Quand une position doit bouger pour encoder une nouvelle valeur, elle **glisse le long du rayon** passant par le centre et la position courante. Seule la distance radiale change ; l'angle par rapport au centre est préservé.

Chaque paramètre garde ainsi une **identité directionnelle stable** dans le canvas au fil des évolutions.

### Actions utilisateur au niveau 0

| Action | Effet |
| --- | --- |
| Drag du centre $C$ | Recalcul de toutes les valeurs $v_i$ via $\Phi$ avec le nouveau $C$ et les positions actuelles. Les positions suivent au minimum nécessaire (règle de mouvement minimal). |
| Drag d'une position $\text{pos}_i$ | Recalcul de $v_i$ via $\Phi$ à la nouvelle distance. |
| Drag d'un slider externe | Nouvelle $v_i$ fixée directement. $\text{pos}_i$ glisse le long du rayon si sa position courante n'encode plus la valeur. |
| Écriture externe (ex. Shepard niveau 1) | Nouvelles $v_i$ écrites. Positions réajustées au minimum via la règle. |
| Click sur le badge de compteur de presets | Ouvre le **menu de rappel niveau 0** (cf. ci-dessous). |

### Menu de rappel niveau 0

Affordance complémentaire au calque : un dropdown ancré sous le badge de compteur de presets dans le header de l'effet, qui surface uniquement les **presets nommés** par l'utilisateur. Cliquer sur un item rappelle ce preset comme un commit de geste (équivalent à `ψ(\pi(c^*))` exactement sur le preset). Les presets auto-promus sans nom n'apparaissent pas — ils restent accessibles via le calque.

- **Tri** : alphabétique sur le nom (insensible à la casse et aux accents). Stable d'une ouverture à l'autre.
- **État courant** : l'item dont le `configHash` correspond exactement à la configuration audible courante reçoit un check (`✓`). Au moindre changement de paramètre, plus aucun item n'est marqué.
- **État vide** : si la bibliothèque ne contient aucun preset nommé, le menu affiche « No named presets ». Le badge reste cliquable pour signaler la cohabitation des deux types (auto-promus et nommés).
- **Fermeture** : click ailleurs, Escape, scroll. Click sur un item ferme le menu et déclenche le rappel.

## Visualisation niveau 1 : orbit-ui des presets (calque)

Le niveau 1 est un **calque semi-transparent superposé au niveau 0**. Il ajoute une seconde orbit-ui qui opère sur les presets de la bibliothèque, non plus sur les paramètres individuels.

### Cohabitation des deux niveaux

Quand le calque est actif :

- Les éléments du niveau 0 (paramètres + centre $C$) restent **visibles par transparence** pour préserver le contexte visuel.
- Les éléments du niveau 0 ne sont **plus interactifs** : le drag du centre niveau 0 et le drag des positions des paramètres sont désactivés.
- Le centre niveau 0 reste **figé à la position canvas center** (il n'a pas de rôle sémantique actif pendant l'overlay).
- Le calque niveau 1 (presets, trajectoire, HEAD, cursor, centre niveau 1) est dessiné par-dessus avec pleine opacité.
- Les valeurs des paramètres sont écrites par $\psi(\text{center}_1)$ — cf. invariant de source de vérité du niveau 0.

### Toggle sans saut

Au toggle-off du calque, la configuration $(\text{valeurs des paramètres})$ reste celle qu'écrivait Shepard au dernier instant. Les positions niveau 0 sont déjà cohérentes avec ces valeurs (maintenues en continu par la règle de mouvement minimal). Le centre niveau 0 est au canvas center.

**Conséquence** : aucun saut audible ni visuel au moment du toggle. Le prochain drag du centre niveau 0 applique $\Phi$ à partir de cet état cohérent, produisant de nouvelles valeurs de manière continue depuis là où Shepard les a laissées.

### Projection $\pi : E \to \mathbb{R}^2$

$\pi$ est construite par **PCA pondérée** sur l'ensemble des presets mémorisés pour un $\text{uiHash}$ donné :

- Entrée : presets $\{c_1, \dots, c_k\} \subset E$ avec poids $w_i$ décroissant avec l'ancienneté de `lastSeenAt`
- Sortie : deux vecteurs directionnels $u_1, u_2 \in E$ + centroïde pondéré $\bar{c}$
- Position 2D du preset $c_i$ : $p_i = \bigl(\langle c_i - \bar{c}, u_1 \rangle, \langle c_i - \bar{c}, u_2 \rangle\bigr)$

La projection évolue quand le dataset change : ajouter un preset peut réorienter les axes. C'est un **aspect d'apprentissage** : plus la bibliothèque grandit, plus la projection reflète les choix réellement explorés.

### Inverse $\psi : \mathbb{R}^2 \to E$ par Shepard non borné

Pour une position de centre $(x, y)$ dans le canvas, la configuration correspondante est calculée par interpolation pondérée inverse-distance (Shepard) sur **tous** les presets :

Soit $d_i = \|(x, y) - p_i\|$ pour chaque preset, et soit $w_i = d_i^{-p}$ le poids brut (avec $p = 2$ par défaut).

$$\psi(x, y) = \sum_i \tilde{w}_i \cdot c_i, \qquad \tilde{w}_i = \frac{w_i}{\sum_j w_j}$$

Les contributions normalisées $\tilde{w}_i \in [0, 1]$ somment à 1 et représentent la part de chaque preset dans la configuration courante.

- **Continuité** : pas de seuil, pas de zone « hors influence ». $\psi$ est continue partout sur $\mathbb{R}^2$ — quand la croix se rapproche d'un preset, son $\tilde{w}_i$ croît continûment vers 1, les autres décroissent vers 0.
- **Cas-limite** $d_i = 0$ : $w_i \to \infty$. Numériquement on court-circuite au snap exact $\psi(x, y) = c_i$ pour éviter $\infty/\infty$.

Choix de design (vs portée bornée historique) : $r_{\text{inner}}, r_{\text{outer}}$ ont été retirés. La version bornée introduisait des sauts visibles à la frontière $r_{\text{outer}}$ quand un preset entrait/sortait de l'ensemble actif ; le Shepard non borné supprime ces ruptures et la « zone défaut hors d'atteinte » au prix d'un calcul sur tous les presets à chaque frame, négligeable pour les tailles de bibliothèque attendues.

### Éléments visuels

Le canvas contient simultanément :

- **Les presets** comme **disques roses uniformes** portant chacun leur
  numéro (1-based) dans l'ordre `lastSeenAt` — la couleur n'encode pas
  l'identité du preset, le numéro suffit. Couleur réservée pour des
  extensions futures.
- **Anneau ambre** autour de chaque preset **sélectionné** (cf. §Sélection
  multi).
- **Centre niveau 1** comme croix manipulable dont la position détermine
  $\psi(\text{center})$ appliquée en temps réel.
- **Arc blanc** sur l'anneau de chaque preset, dont la longueur encode la
  contribution Shepard normalisée $\tilde{w}_i$ — le user voit en direct
  comment la croix est interpolée.
- **Spread visuel** : quand plusieurs presets se projettent à la même
  position PCA (clusters de configurations très proches), leurs disques
  sont écartés sur un petit cercle autour du centroïde du cluster pour
  rester visibles individuellement. Le spread est **purement visuel** ;
  les distances Shepard restent calculées dans l'espace de projection
  d'origine, donc le comportement audio reflète les vraies distances.

La trajectoire (HEAD, cursor, polyligne d'événements) **n'est pas
représentée** dans l'UI actuelle ; elle est conservée comme donnée
interne (cf. §Cursor, §Commit depuis cursor détaché).

### Sélection multi

Un sous-ensemble ordonné de presets, alimenté à la demande, sert de cible
à deux opérations : **suppression en masse** et **mode boucle**. La
sélection est un set ordonné (ordre d'insertion conservé) qui survit aux
toggles d'overlay. Édition :

- **Shift+click sur un preset** : toggle l'appartenance à la sélection.
- **Shift+drag dans le vide** : trace un rectangle ; au relâchement, tous
  les presets visibles dans le rectangle sont **ajoutés** (additif —
  jamais retirés, pour ne pas perdre une sélection lentement construite).
- **Trash** dans le header de l'effet : supprime tous les presets
  sélectionnés de la bibliothèque (ne touche pas la trajectoire).

### Interactions du canvas

| Action UI | Sémantique |
| --- | --- |
| Drag du centre | Navigation continue dans $E$ via $\pi$ courante ; applique $\psi(\text{center})$ en temps réel |
| ←/→ | Glissement portamento du centre vers le preset précédent / suivant en ordre `lastSeenAt`, cycle |
| Shift+click sur un preset | Toggle de sa présence dans la sélection multi |
| Shift+drag dans le vide | Rectangle de sélection ; ajout additif au relâchement |
| Right-click sur la croix → « Add preset » | Mémorise la configuration courante $\psi(\text{centre})$ comme nouveau preset, ancré à la position visuelle de la croix |
| Right-click sur un preset → « Rename… » | Ouvre l'éditeur inline pour renommer le preset |
| Right-click sur un preset → « Delete » | Supprime le preset (confirmation si nommé) |
| Double-click sur un preset | Raccourci équivalent à « Rename… » |
| ▶ / ■ (bottom bar) | Démarre / arrête le mode boucle sur la sélection courante |

### Pondération par récence

Les poids $w_i$ suivent une décroissance exponentielle :

$$w_i = \exp\bigl(-\lambda \cdot (t_{\text{now}} - t_{\text{lastSeen}, i})\bigr)$$

$\lambda$ est un paramètre de « mémoire » à calibrer. Cible MVP : un preset vieux d'une semaine pèse moitié moins qu'un preset frais ($\lambda = \ln 2 / (7 \text{ jours})$).

### Cas dégénérés

| Nombre de presets | Comportement |
| --- | --- |
| $k = 0$ | Canvas preset vide. Le mode preset-ui est désactivé ; l'utilisateur reste en orbit-ui de paramètres. |
| $k = 1$ | Un seul point. Le canvas a une seule position utile ; snap systématique. |
| $k = 2$ | PCA dégénère à une seule direction. Axe entre les deux points ; seconde dimension arbitraire. |
| $k \geq 3$ | PCA pleine. |

## Transitions dynamiques

Jusqu'ici, tout mouvement dans $E$ est instantané (commit de geste, rappel de preset). Les **transitions dynamiques** ajoutent une dimension temporelle continue : on peut glisser progressivement d'une configuration à une autre en un temps donné, et chaîner ces glissements en boucle.

### Deux paramètres utilisateur

- **Portamento time $T_p$** : durée d'une transition continue entre la configuration courante et la configuration cible. Notion familière des synthétiseurs.
- **Durée de cycle $T_L$** : durée totale d'**un parcours complet** de la sélection en mode boucle (et non d'un pas individuel). Exposée à l'utilisateur en **BPM** sous l'hypothèse « 1 cycle = 1 mesure 4/4 », soit $T_L = 60{,}000 \cdot 4 / \text{BPM}$ ms. Ce mapping rend le tempo de la boucle stable face aux éditions à chaud de la sélection (cf. infra).

### Deux modes

**Mode suivi (one-shot).** Une transition unique de la configuration courante vers une cible $c^*$ en $T_p$ secondes. La configuration reste ensuite à $c^*$.

**Mode boucle.** La **sélection multi** courante (cf. §Sélection multi)
sert de liste : ses presets $[p_1, p_2, \dots, p_m]$, dans l'ordre
d'insertion, sont parcourus en continu. La durée de cycle $T_L$ se
répartit également entre les $m$ presets, chacun reçoit donc un pas
$T_S = T_L / m$ structuré comme :

$$T_S = \underbrace{T_p}_{\text{glissement}} + \underbrace{\max(0,\ T_S - T_p)}_{\text{hold au preset}}$$

Si $T_p = T_S$, mouvement continu sans pause sur le preset. Si $T_p = 0$, sauts instantanés et hold complet sur chaque preset ($T_S$ par preset). Entre les deux, mix glissement + hold émergeant du différentiel.

Conséquence importante de ce modèle : **la durée de cycle reste fixe quelle que soit la taille de la sélection**. Ajouter ou retirer des presets pendant la boucle modifie la *densité* du contenu sans déplacer le tempo, comme remplir une mesure d'un séquenceur avec plus ou moins de notes.

Modes classiques subsumés par la boucle :

- Élastique (A ↔ B, un aller-retour) = sélection `{A, B}` exécutée une itération
- Oscillant (A ↔ B en continu) = sélection `{A, B}` en continu

**Édition à chaud.** La sélection est modifiable pendant la boucle (via
shift+click ou rectangle). Le prochain pas lit la sélection courante :
ajouter un preset l'insère en queue, retirer un preset le saute. La
structure rythmique change immédiatement.

### Géométrie du chemin

La configuration intermédiaire pendant une transition se calcule selon le niveau choisi :

- **Niveau 0 (paramètres bruts)** : interpolation linéaire composante-par-composante.
  $$c(t) = (1 - \alpha(t)) \cdot c_{\text{start}} + \alpha(t) \cdot c_{\text{target}}$$
  avec $\alpha : [0, T_p] \to [0, 1]$ linéaire par défaut ($\alpha(t) = t / T_p$).
- **Niveau 1 (canvas preset-ui)** : le centre glisse en ligne droite dans le canvas 2D de $\pi(c_{\text{start}})$ vers $\pi(c_{\text{target}})$. La configuration intermédiaire est $\psi(\text{center}(t))$. Le chemin dans $E$ peut alors être non-linéaire, passant par les zones d'influence des presets intermédiaires via Shepard.

### Interruption

Si une nouvelle transition est demandée pendant qu'une est en cours, la nouvelle **part de la configuration interpolée courante** (remplacement, pas file d'attente).

### Contrainte

En mode boucle : $T_p \leq T_S = T_L / m$, soit $m \cdot T_p \leq T_L$ (la transition doit finir avant le prochain déclenchement). Le moteur d'exécution applique un floor : si la valeur courante de $T_p$ excède $T_L / m$, le pas effectif est étiré à $T_p$ et le cycle audible devient plus long que ce que le slider tempo affiche. L'UI ne clampe pas activement les sliders ; c'est à l'utilisateur d'ajuster Tp ou de réduire la sélection s'il veut respecter exactement le BPM affiché.

### Limitation connue : étranglement du timer en onglet d'arrière-plan

Le pilotage du glissement de la croix et du hold en mode boucle repose sur `requestAnimationFrame` côté thread principal. Or les navigateurs (Chrome notamment) **étranglent rAF et `setTimeout` à environ 1 Hz pour les onglets non-foreground** afin d'économiser CPU et batterie. Conséquence pratique : quand l'onglet du DAW passe en arrière-plan pendant qu'une boucle tourne, on n'obtient plus que ~1 mise à jour audio par seconde, le glissement Shepard intermédiaire n'est plus calculé, et la boucle audible se réduit à des **sauts discrets de preset à preset**. Le timing global du cycle reste à peu près correct (`performance.now()` n'est pas étranglé) mais la continuité $\psi$ est perdue.

Le moteur Web Audio, lui, tourne sur un thread temps-réel non étranglé : le son lui-même ne se coupe pas, c'est uniquement la chaîne JS qui pilote `apply(config)` qui souffre. **Détacher l'onglet en fenêtre autonome** (ou utiliser une PWA standalone) suffit à le sortir de la catégorie « onglet d'arrière-plan » et restaure le comportement nominal.

Solution propre future : déplacer l'horloge de référence de la boucle sur `audioContext.currentTime` (planification via `setValueAtTime` / `linearRampToValueAtTime`), ou installer un `AudioWorkletNode` minimal qui poste un tick au main thread tous les ~33 ms — ces postMessages ne sont pas étranglés tant que l'audio est actif.

### Trace dans le log de trajectoire

Une transition produit **un seul événement de trajectoire** au target, avec metadata :

- `transitionTime` = $T_p$
- `transitionLevel` = `0` (niveau paramètres) ou `1` (niveau canvas)
- `loopContext` = identifiant de la boucle si applicable

Le log reste discret. La continuité audible est un phénomène transitoire, non historiquement tracé. Si l'utilisateur interrompt une transition avant qu'elle ne termine et commence une nouvelle, l'ancienne cible n'est jamais loggée.

## Invariants

### Totalité

Une configuration est un mapping **total** sur $P$. Pas de preset partiel.

### Légitimité

$c(p_i) \in D(p_i)$ pour tout paramètre. Pas de valeur hors domaine.

### Cohérence avec la signature paramètres

Un preset est lié à un $\text{uiHash}$ précis — la signature de l'interface paramètres du DSP ($\{(path, type, min, max, step)\}$). Tant que la signature est inchangée, le preset reste valide même si la source DSP a évolué (refactor, fix de bug, commentaire, etc.). Si la signature change (paramètre ajouté, retiré, plage modifiée), le preset est attaché à un autre $\text{uiHash}$ et n'est plus visible depuis le nouveau code. Pas de migration implicite. Le $\text{codeHash}$ — hash de la source — reste utilisé séparément par la trajectoire pour signaler qu'une recompilation invalide la trajectoire courante.

### Unicité du default

Une unique configuration par défaut par $\text{uiHash}$, dérivée des descripteurs. Pas stockée comme preset ordinaire.

### Linéarité de la trajectoire

Le log est une séquence linéaire. Aucun branchement, aucun arbre.

### Non-destructivité

Ni la navigation (cursor) ni la modification depuis cursor détaché ne suppriment d'événements. La seule cause de perte est l'éviction FIFO au-delà de la capacité.

### Croissance monotone de la bibliothèque

Tant qu'une session $S$ vit, la bibliothèque vue depuis $S$ ne perd jamais d'entrée ; elle ne peut que gagner. Le workspace est l'union des bibliothèques des sessions vivantes.

### Déterminisme du rappel

Rappeler deux fois le même preset applique deux fois la même configuration.

### Idempotence du snap

Quand le centre du canvas 2D est exactement à la position $p_i$ d'un
preset (distance nulle), alors $\psi(\text{center}) = c_i$ exactement. Pas
d'approximation par interpolation aux points des presets. Cet invariant
est garanti numériquement par le court-circuit Shepard à $d = 0$ ; il n'y
a plus de zone $r_{\text{inner}}$ — la transition est continue partout
ailleurs.

### Source de vérité unique

Les **valeurs des paramètres** sont la source de vérité pour toute l'UI. Les niveaux 0 (orbit-ui paramètres) et 1 (orbit-ui preset) lisent et écrivent toutes les deux dans cette source partagée. Les positions visuelles des deux niveaux (paramètres pour le niveau 0, centre $C$ pour les deux niveaux) sont des dérivées maintenues cohérentes. Corollaire direct : le toggle d'un calque n'introduit aucune discontinuité, parce qu'il ne déplace pas la source de vérité.

### Dérivation complète du layout niveau 1

Le layout du calque niveau 1 — positions 2D des presets, axes de la projection — est **entièrement dérivé** de la bibliothèque courante via la PCA pondérée. Pas d'ajustement manuel, pas d'état caché, pas de persistance séparée. Quand la bibliothèque évolue (nouveaux presets, `lastSeenAt` mis à jour), le layout se recalcule.

Conséquence : la carte reflète toujours l'état actuel des données, et deux utilisateurs (ou le même à deux moments) ayant la même bibliothèque ont la même carte.

## Trois concerns : résumé MVP

| Concern | Choix MVP |
|---|---|
| **Production** (trajectoire) | Append au log à chaque commit de geste |
| **Production** (bibliothèque) | Promotion automatique après $X$ secondes de dwell en playback actif, effet non bypassé. Suspendue tant que le calque niveau 1 est ouvert (l'utilisateur gère alors la bibliothèque à la main). |
| **Production manuelle** | Right-click sur la croix → « Add preset » → sauvegarde de $\psi(\text{centre})$ comme preset, ancré à la position visuelle de la croix (ou bump du `lastSeenAt` si même contenu existe déjà). Un override d'ancrage **session-local** garantit que le nouveau disc apparaît exactement sous la croix, indépendamment de ce que la PCA aurait projeté pour cette config. |
| **Nommage** | Optionnel et contrôlé par l'utilisateur : right-click sur un preset → « Rename… », ou double-click. Un preset sans nom n'a pas d'étiquette ; un preset nommé apparaît avec un disc doré et son nom s'affiche sous la croix quand celle-ci est exactement dessus. Plusieurs presets peuvent partager le même nom (collision admise). Vider le nom le supprime. |
| **Navigation niveau 1** | ←/→ glissent le centre vers le preset précédent / suivant en ordre `lastSeenAt`, cyclique. Le cursor du log de trajectoire reste interne (utilisé seulement par le détour appendé sur commit détaché). |
| **Sélection multi** | Set ordonné par insertion. Shift+click toggle ; shift+drag rectangle ajoute additivement |
| **Suppression** | Trash dans le header de l'effet : supprime tous les presets sélectionnés. Active uniquement quand calque ouvert + sélection non vide |
| **Rappel** | Deux chemins complémentaires : (a) centre niveau 1 + Shepard non borné — le calque expose toute la bibliothèque ; (b) menu de rappel niveau 0 dans le header de l'effet — dropdown des presets nommés uniquement, tri alphabétique stable, item courant marqué `✓`. |
| **Dédup bibliothèque** | Par contenu. Revisite d'un preset existant met à jour `lastSeenAt` |
| **Capacité trajectoire** | ≈ 500 événements par instance, éviction FIFO |
| **Seuil de dwell $X$** | 3 secondes en première approximation, tunable |
| **Projection 2D** (niveau preset) | PCA pondérée par récence ($\lambda = \ln 2 / 7\text{j}$), entièrement dérivée de la bibliothèque. Pas d'ajustement manuel. Cluster spread visuel pour les presets superposés. |
| **Interpolation** (niveau preset) | Shepard non borné $p = 2$ : tous les presets contribuent toujours, contributions normalisées sommant à 1, snap exact au cas-limite $d = 0$ |
| **Mode suivi** | Glissement avec $T_p$ secondes de portamento. $T_p = 0$ = saut instantané. Lancé par ←/→. |
| **Mode boucle** | Sur la sélection multi (ordre d'insertion). Durée de cycle $T_L$ exposée en BPM (1 cycle = 1 mesure 4/4). Pas effectif $T_S = T_L / m$, contrainte $T_p \leq T_S$, édition à chaud (la sélection peut changer pendant la boucle, le tempo reste fixe). Bouton ▶/■ dans la bottom bar du calque. |
| **Ease-in/out** | Linéaire par défaut ($\alpha(t) = t / T_p$). Courbes raffinées en post-MVP |
| **Interruption** | Remplacement : la nouvelle transition part de la position interpolée courante |

## Hors-scope de cette spec

- **UI / feedback raffiné** : indicateur visuel du preset actif pendant
  la cycle, mise en évidence du preset cible courant en mode boucle,
  raccourcis clavier alternatifs.
- **Pinning et organisation hiérarchique** : marquer certains presets comme favoris, les organiser en dossiers ou collections. Le renommage utilisateur, lui, est implémenté (cf. §Interactions du canvas et le tableau Trois concerns).
- **Suppression d'événements de trajectoire** : la suppression de presets de la bibliothèque est implémentée (trash sur la sélection multi). La suppression manuelle d'événements individuels du log de trajectoire reste hors-scope.
- **Compatibilité inter-codes** : détection de « presets proches » pour un code modifié, application avec dégradation contrôlée.
- **Méta-niveau 2 (collections de presets)** : reconnu comme extension cohérente du niveau 1 mais explicitement repoussé. On gagne d'abord en expérience avec niveaux 0 (paramètres) et 1 (presets) avant de l'ajouter.
- **Ease curves raffinés** : ease-in/out, exponentiel, enveloppes personnalisées. Linéaire par défaut dans le MVP.
- **Synchronisation tempo** : verrouillage de $T_L$ sur la BPM du projet.
- **Boucles multiples simultanées** : plusieurs boucles sur la même instance ou sur des instances différentes jouant de concert.
- **Pilotage externe du centre** (MIDI / OSC / Web MIDI) : position $(x, y)$ du centre de chaque canvas comme variable observable et pilotable depuis l'extérieur (contrôleurs physiques, feedback inter-instances, enregistrement/rejeu en flux). Héritage conceptuel d'Interactors (Orlarey, années 1980), qui exposait toute commande en entrée et sortie MIDI.
- **Sources de trajectoire procédurales** : DSL permettant de générer des chemins dans le canvas par description (équivalent moderne de la tortue Logo intégrée à Interactors par Stéphane Letz). La trajectoire devient un programme ; elle peut déclencher des transitions, composer avec les boucles de presets, ou générer des motifs géométriques dans l'espace des paramètres.
- **Implémentation** : schéma IndexedDB, intégration avec l'autosave et l'undo projet, sérialisation des trajectoires dans les archives de session.

Ces points seront traités séparément une fois le vocabulaire fixé.
