# Qualifier un test de régression entre des révisions Git

La commande `check` vérifie qu’un test JavaScript `node:test` commité détecte une correction précise. Elle exécute le même test sur trois projections déclarées : la révision corrigée, la révision qui contient le bug et une révision neutre choisie par l’opérateur.

Remplacez `BEFORE`, `AFTER` et `NEUTRAL` par vos révisions. Cette commande s’utilise sur une ligne
sous PowerShell comme dans un shell POSIX :

```sh
assertledger check . --before BEFORE --after AFTER --neutral NEUTRAL --neutral-reason "raison explicite du contrôle" --test tests/regression.test.js --base-test tests/base.test.js --out .assertledger/evidence --allow-unsafe-execution
```

`--after` utilise `HEAD` par défaut. `--base-test` peut être répété. Le dossier donné à `--out` doit être un nouveau chemin relatif au dépôt. AssertLedger le réserve de manière exclusive, écrit `executed-request.json` et `summary.md`, puis publie `manifest.json` en dernier par renommage atomique. La présence de `manifest.json` est le marqueur de complétion ; un lecteur doit ignorer un dossier qui ne le contient pas.

Le mode d’exécution est toujours choisi explicitement. Sans `--container-image` ni `--allow-unsafe-execution`, `check` refuse de s’exécuter ; les deux ensemble sont refusés avec `ISOLATION_MODE_CONFLICT`.

Pour isoler l’exécution, remplacez `--allow-unsafe-execution` par `--container-image NOM@sha256:DIGEST`. Chaque contrôle et chaque candidat s’exécute alors dans un conteneur Linux neuf, sans réseau ni montage de l’hôte, avec les limites par défaut et un délai de 30 secondes par exécution. L’image doit déjà être présente sur le démon et contenir `node` : AssertLedger ne la télécharge jamais. `--container-runtime` accepte la commande du runtime sous forme de tableau JSON, `["docker"]` par défaut. Le manifeste produit est alors en version `2.0.0`. Voir [l’isolation par conteneur](container-isolation.md).

L’exécution `trusted-local` est volontairement **UNSANDBOXED**. Le drapeau `--allow-unsafe-execution` constitue l’autorisation distincte de l’opérateur. L’API équivalente est `new AssertLedger().checkGitRegression(options)`, avec `container: { image }` ou `allowUnsafeExecution: true`.

MCP expose le parcours `trusted-local` avec `assertledger_check` (alias `testforge_check`) seulement si
l’opérateur a démarré le serveur avec `--allow-unsafe-execution`. L’entrée reprend les options
du SDK, sans le champ de permission : `repository`, `before`, `after` facultatif, `neutral`,
`neutralReason`, `test`, `baseTests` et `out`. La racine est confinée aux dépôts autorisés ; le
dossier de sortie suit les mêmes contrôles que la CLI. Un client ne peut pas s’accorder cette
permission dans son message. Le mode conteneur n’est pas encore exposé par MCP.

## Limites de cette première tranche

- seules les révisions commitées sont lues ; les changements locaux sont ignorés ;
- le test candidat doit être un fichier `.js`, `.mjs` ou `.cjs` utilisant les modules Node intégrés et des imports relatifs ;
- les dépendances d’exécution déclarées ne sont pas transportées ;
- le test de base doit être explicitement indiqué et identique dans les trois révisions ; les contrôles doivent découvrir au moins un vrai test ;
- les ensembles de chemins doivent rester identiques après retrait du test candidat ; les ajouts, suppressions, renommages, liens, sous-modules et modes exécutables sont refusés ;
- une révision neutre identique à la révision corrigée est acceptée comme contrôle répété, sans preuve indépendante de robustesse ;
- le rejeu vérifie l’intégrité du manifeste, mais ne réauthentifie pas les objets Git ni l’exécution passée.

Le verdict porte uniquement sur la faute déclarée. Un résultat `REJECTED` ne démontre pas que le test est inutile dans un autre contexte.

La sortie humaine et `summary.md` indiquent les SHA résolus, les observations sur le défaut,
les motifs du verdict et du candidat, les limites et une commande de rejeu adaptée au shell de
la machine. Le dossier de sortie ne peut pas se trouver dans les métadonnées Git. Les lectures
Git sont bornées ; le contenu est vérifié puis conservé en mémoire, dans la limite de 107 003 904
octets de données brutes, auxquels s’ajoutent des en-têtes bornés.
