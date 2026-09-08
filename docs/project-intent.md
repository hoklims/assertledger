# Intention et cap d’AssertLedger

État des lieux et cap ratifié le 8 septembre 2026. Le propriétaire a demandé d’aligner Linear et
les issues sur la qualification de tests de correction, puis de poursuivre jusqu’à une release
1.0 avec une prise en main soignée. Les contrats de preuve existants restent applicables.

## Cap 1.0 décidé

**Vérifiez que le test détecte réellement le bug corrigé, avant de l’accepter.** La cible initiale
est une équipe SaaS Node.js/TypeScript qui utilise des agents. Le développeur désigne le test et
la correction ; le tech lead obtient un verdict, les raisons, les révisions et les limites.

Le premier parcours s’appuie sur `node:test`, une version fautive, une référence corrigée et un
contrôle neutre justifié. Les interfaces préparent les entrées du vérificateur sans redéfinir ses
gates. La première exécution reste réservée au code de confiance avec opt-in explicite
`UNSANDBOXED`. L’ouverture aux contributions hostiles exige une isolation qualifiée.

Le projet Linear est désormais [AssertLedger 1.0 — Tests de régression vérifiés](https://linear.app/hoklims/project/assertledger-10-tests-de-regression-verifies-acf768519152).
Le dépôt public dédié est [hoklims/assertledger](https://github.com/hoklims/assertledger).
Le [contrat de livraison 1.0](release-1.0.md) décrit le parcours, les critères et les travaux différés.
Les sections ci-dessous conservent les constats de départ ; leur séquencement est précisé par ce cap.

## Le résultat recherché

Donner au développeur qui travaille avec des agents une réponse exploitable à cette question :
**quels tests ajoutent une protection démontrée contre les fautes visées, et combien coûte leur
exécution ?**

L’agent propose des tests. AssertLedger les exécute sur une référence, des variantes fautives et
des variantes censées préserver le comportement. Il explique ensuite ce que les observations
permettent de conclure. Le développeur conserve l’autorité sur le comportement attendu, les
variantes pertinentes et l’acceptation du changement.

L’usage initial proposé est le durcissement de dépôts de confiance utilisés par Guillaume et ses
agents. Un premier parcours doit aboutir à une preuve utile sur un dépôt consommateur, puis être
reproduit depuis un autre harness. L’ouverture à du code non fiable exige une isolation distincte.

## Trois résultats à distinguer

| Résultat | Question posée | Limite |
| --- | --- | --- |
| Qualification d’un candidat | Ce test passe-t-il sur la référence et les neutres, et détecte-t-il les fautes exigées ? | La conclusion porte sur les mondes et essais déclarés. |
| Choix d’un ensemble de tests | Quelle protection supplémentaire apporte chaque test, pour quel coût mesuré ? | La sélection actuelle porte sur les candidats déjà éligibles et sélectionnés par la source. |
| Validation empirique du produit | Cette méthode conserve-t-elle la détection de vrais défauts hors calibration ? | Il faut des expériences pré-engagées et un holdout indépendant. |

La rapidité intervient après les exigences de preuve. Elle ne compense jamais un échec de
référence, un monde neutre rouge, une observation instable ou une attribution douteuse.

## Ce qui existe réellement

Le socle local comprend les contrats versionnés, le noyau déterministe, les digests, le replay
sémantique, le moteur d’exécution, les façades CLI/SDK/MCP, l’audit statique et l’initialisation.
Le registre contient 34 schémas JSON, tous présents dans le verrou de conformance. L’ancien
décompte de 30 dans la roadmap était périmé.

L’adaptateur officiel intégré est `node:test`. Le protocole `testforge-command` permet d’intégrer
un autre framework avec un adaptateur fourni par l’opérateur. Détecter Vitest, Jest, Bun ou pytest
pendant `init` ne fournit pas leur adaptateur officiel.

Les profils v1 et v2, les artefacts de benchmark, les contrats de provenance et le protocole
expérimental H3 sont présents. Le benchmark par phases refuse encore l’adaptateur `node:test` :
ses événements ne suffisent pas à mesurer fidèlement les quatre phases demandées.

La documentation rapporte huit cas TestExplora admis pour calibration curatée. Elle ne fournit
pas de holdout réel qualifié. Cette reprise ne réexécute pas ces campagnes historiques et n’accède
pas aux données privées du holdout.

Le dépôt est sur `feat/testforge-core`, HEAD `cb1dde2c2fe0f66e46652e7223086dd04b460c67`.
À la reprise, 29 fichiers suivis sont modifiés, de nombreux nouveaux fichiers restent non suivis
et aucun remote Git n’est configuré. Du code local, même testé, ne constitue donc pas une release
publiée. La qualification `node:test` HOK-570 reste `In Progress` dans Linear.

## Les écarts qui empêchent l’usage visé

Le parcours Linear annoncé est `install → init → connect → doctor → check --changed → land → replay CI`.
Aujourd’hui, `connect`, `doctor`, `check --changed` et `land` sont des travaux de backlog, pas des
commandes utilisables. `init` produit une configuration et un lock ; il laisse explicitement les
mondes et les candidats à fournir par l’opérateur ou le harness.

Le premier obstacle d’adoption est donc le passage entre « dépôt initialisé » et « campagne
pertinente ». Ajouter des adaptateurs aide à exécuter les tests, mais ne décide pas quelles fautes
et quels comportements les tests doivent représenter.

Un résultat historique illustre une seconde difficulté : la campagne sur les 36 tests du noyau
exigeait que chaque candidat tue les quatre cibles obligatoires. Tous ont été rejetés, alors que
six détectaient une cible. C’est le résultat attendu de la politique choisie. Il ne permet pas
de conclure que ces tests n’ont aucune valeur sur leurs responsabilités respectives.

Pour le pilote, les mondes obligatoires doivent donc correspondre à la responsabilité du candidat.
Si l’on veut accepter un ensemble dont les membres se complètent sans être individuellement
éligibles, il faudra un contrat distinct, des contre-exemples et une décision explicite. Cette
proposition ne modifie pas les gates v1 pour obtenir un résultat plus flatteur.

Enfin, l’intégrité d’un manifeste et l’authenticité de ses observations sont deux propriétés
différentes. Un replay valide ne prouve ni que les octets ont été exécutés, ni que le producteur est
indépendant. La politique externe de preuve et ses reçus restent une responsabilité séparée.

## Ordre de reprise proposé

### 1. Fiabiliser et conserver le socle existant

Terminer la vérification de la qualification `node:test`, corriger les échecs reproductibles,
conserver les preuves exactes et inventorier le diff hérité avant tout checkpoint Git.

Critère de sortie : `pnpm check` vert, témoins adversariaux pertinents observés, campagne minimale
rejouable et limites d’acceptation explicites. La revue du système de preuve porte sur l’agrégat
qui sera réellement accepté. Le durcissement global HOK-406 n’autorise pas implicitement une
modification de la politique active et ne remplace pas le reçu attendu.

### 2. Démontrer un usage complet dans un dépôt consommateur

Choisir une responsabilité métier bornée, une référence, une faute connue et un monde neutre
justifié. Comparer au moins un test utile à un test qui passe sans détecter la faute. Présenter le
verdict, ses raisons, les limites et les octets concernés depuis un harness, puis rejouer le même
artefact depuis un second point d’entrée.

Critères de sortie proposés : installation et parcours documentés exécutés depuis un consommateur
neuf ; premier résultat compréhensible ; échec générique et timeout refusés comme preuves ; mêmes
décisions au replay ; durée jusqu’à la première preuve mesurée. L’objectif historique de cinq
minutes reste un objectif à mesurer, pas une performance acquise.

L’adaptateur suivant dépend du dépôt choisi. HOK-571 prépare Vitest ; HOK-574 prépare pytest.
Les cinq adaptateurs de HOK-422 restent prévus, mais ne doivent pas tous précéder le premier
apprentissage d’usage. Le branchement au harness et les diagnostics se construisent à partir des
obstacles observés dans ce parcours.

### 3. Mesurer le gain, puis élargir

Mesurer d’abord le coût complet de la qualification, le temps de feedback et la protection
supplémentaire apportée dans un contexte fixé. Une somme de p95 individuels ne constitue pas une
mesure du p95 du portefeuille réellement exécuté.

Reprendre ensuite le corpus et les expériences H1–H4 avec les autorités, sources et engagements
prévus. La calibration peut produire un résultat nul ou défavorable : ce résultat doit rester
publiable. Étendre les adaptateurs, le cache et l’isolation selon les usages vérifiés.

Critère de sortie pour une affirmation empirique : hypothèses et seuils pré-engagés, provenance
complète, holdout sous garde indépendante et critères satisfaits. Un corpus mécaniquement `READY`
ne signifie pas que les hypothèses sont confirmées.

## Mesurer la valeur sans inventer un score universel

| Mesure proposée | Ce qu’elle aide à décider |
| --- | --- |
| Temps jusqu’à la première campagne comprise et rejouée | Le parcours est-il réellement accessible ? |
| Fautes pertinentes détectées et contrôles conservés verts | Le test protège-t-il la responsabilité visée ? |
| Faux positifs sur les erreurs opérationnelles | Le verdict accorde-t-il indûment de la confiance ? |
| Coût total de qualification et coût du feedback courant | Le bénéfice justifie-t-il la dépense ? |
| Protection marginale d’un test ou d’un ensemble | L’ajout apporte-t-il quelque chose de démontrable ? |

Ces mesures nécessitent un contexte et un protocole. Aucun gain, taux d’adoption ou classement
entre machines n’est établi par ce document.

## Frontières conservées

- Le noyau décide sans I/O, horloge, réseau, hasard ou jugement de modèle.
- Seul un échec d’assertion attribué peut compter comme détection d’une cible en v1.
- `trusted-local` reste explicitement non isolé ; ses ressources bornées ne forment pas une sandbox.
- Les mondes, politiques et pins de confiance ne deviennent pas valides parce qu’un agent les fournit.
- Les catching tests, qui doivent échouer sur une révision proposée, restent hors du mode hardening v1.
- Une évolution de schéma, de digest, d’éligibilité ou de permission exige son contrat et ses preuves.
- La publication, l’acceptation externe et la validation scientifique conservent leurs critères propres.

## Sources de reprise

- [Contrat de preuve](proof-model.md), [architecture](architecture.md),
  [initialisation](repository-init.md) et [adaptateurs](adapter-protocol.md).
- [Profil v1](agentic-test-profile.md), [profil v2](agentic-test-profile-v2.md),
  [plan de corpus](agentic-corpus-plan.md) et [résultat historique sur les tests du noyau](../benchmarks/self-hosted-core/RESULT-existing-tests-v1.md).
- [Projet Linear](https://linear.app/hoklims/project/assertledger-agentic-test-profile-acf768519152),
  [parcours HOK-419](https://linear.app/hoklims/issue/HOK-419),
  [qualification HOK-570](https://linear.app/hoklims/issue/HOK-570),
  [politique externe HOK-406](https://linear.app/hoklims/issue/HOK-406).
