# AssertLedger 1.0

Cap décidé par le propriétaire le 8 septembre 2026. Ce document fixe les critères de la version 1.0 ;
la publication est attestée séparément par le tag, le registre npm et la release GitHub.
Le nom du package reste `assertledger` et le dépôt public est
[hoklims/assertledger](https://github.com/hoklims/assertledger).

## Résultat utilisateur

Un développeur ou son agent apporte le test d’une correction. AssertLedger vérifie que ce test
passe sur la correction et les contrôles déclarés, puis détecte la faute connue par assertion.
Le résultat identifie les révisions, les octets du test, les essais, les raisons et les limites.
Le même artefact se rejoue sans modèle dans le terminal et en CI.

La première cible est une équipe Node.js/TypeScript utilisant des agents. La première exécution
officielle repose sur `node:test` ; les variantes de TypeScript ou de dépendances non qualifiées
doivent être annoncées comme telles. Détecter un framework ne signifie pas savoir le qualifier.

## Parcours et critères de livraison

| Étape | Critère observable | Issue |
| --- | --- | --- |
| Première preuve | Version fautive, correction, test et contrôle neutre déclarés ; test utile et inutile distingués ; manifeste rejouable | [HOK-658](https://linear.app/hoklims/issue/HOK-658) |
| Adaptateur de référence | Matrice adversariale, trois mondes, deux essais, candidat fort seul sélectionné | [HOK-570](https://linear.app/hoklims/issue/HOK-570) |
| Diagnostic | Prérequis, permissions et limites expliqués avant exécution ; prochaine action sûre | [HOK-420](https://linear.app/hoklims/issue/HOK-420) |
| Agents | CLI/SDK/MCP compatibles ; configuration idempotente et confinée aux racines autorisées | [HOK-423](https://linear.app/hoklims/issue/HOK-423) |
| Restitution | Verdict humain et JSON cohérents, raisons stables, aucune suggestion qui contourne un gate | [HOK-428](https://linear.app/hoklims/issue/HOK-428) |
| Distribution | Installation du tarball dans un consommateur neuf ; binaires, SDK, fichiers runtime et replay vérifiés | [HOK-659](https://linear.app/hoklims/issue/HOK-659) |
| Publication | CI et revue du candidat exact, tag/package/release publiés, réinstallation de la version publiée | [HOK-399](https://linear.app/hoklims/issue/HOK-399) |

La documentation doit être copiée et exécutée sans correction implicite. Mesurer le temps jusqu’à
la première preuve comprise ; cinq minutes reste un objectif, sans résultat annoncé d’avance.
Une démo locale n’est pas une preuve d’adoption. [Trois pilotes](https://linear.app/hoklims/issue/HOK-660)
doivent ensuite documenter réutilisation, effort, abandon et volonté de conserver l’intégration.

## Frontières de la version

- Les gates, schémas, projections de digest et aliases TestForge conservent leur compatibilité.
- Seule une assertion attribuée peut compter comme détection ; les erreurs opérationnelles restent
  des non-kills. La vitesse ne compense aucun défaut de preuve.
- Les mondes attendus relèvent de l’opérateur. Un contrôle identique à la référence ne devient pas
  une preuve indépendante de robustesse.
- `trusted-local` reste `UNSANDBOXED`, opt-in, réservé au code de confiance. Les exemples CI refusent
  les contributions non fiables et l’exécution sur un runner privilégié.
- Le replay vérifie intégrité et cohérence ; il n’authentifie pas le producteur des observations.
- Profils statistiques et holdout gardent leurs critères avant toute affirmation empirique.

## Extensions conservées

Les adaptateurs Vitest, Jest, Bun et pytest suivent les besoins des pilotes. Cache incrémental,
landing automatique, profils de performance et isolation des contributions hostiles sont des
travaux distincts. Leurs critères restent dans Linear ; ils ne sont pas annoncés comme livrés par
la seule publication d’un package 1.0.

## État de départ vérifié

Le candidat local du 8 septembre passe `pnpm check` avec 307 tests. La version du package est
encore `0.1.0`. Le dépôt public dédié est créé et `origin` configuré ; aucune release n’est publiée.
Le contrôle npm initial retournait `E401`. L’authentification du compte personnel `hoklims` a
ensuite été vérifiée ; elle ne vaut pas preuve de publication.
Le diff hérité est conservé ; sa présence ne constitue pas une acceptation de tous ses travaux.
La preuve externe [HOK-406](https://linear.app/hoklims/issue/HOK-406) reste ouverte et ne donne pas
autorité pour modifier la politique active.
