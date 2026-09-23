// French strings. English lives in index.html and stays the source of truth;
// wording follows README.fr.md (code corrigé, défaut connu, témoin neutre).
export const FR = {
  "meta.title": "AssertLedger — Votre test de régression détecte-t-il vraiment le bug ?",
  "meta.description":
    "AssertLedger exécute le même test sur le code corrigé, un défaut connu et un témoin neutre, puis scelle une preuve déterministe que chacun peut rejouer. CLI, SDK et MCP pour Node.js.",
  skip: "Aller au contenu",
  "brand.aria": "AssertLedger, retour en haut de page",
  "nav.aria": "Sections",
  "nav.fool": "Essayez de le piéger",
  "nav.how": "Fonctionnement",
  "nav.evidence": "Preuve",
  "nav.start": "Démarrer",
  "lang.aria": "Langue",

  "hero.title": "Votre test de régression détecte⁠-⁠t⁠-⁠il vraiment le bug ?",
  "hero.lede":
    "AssertLedger exécute le même test sur le code corrigé, sur un défaut connu et sur un témoin neutre. Il ne retient un test que s’il échoue sur le défaut, et nulle part ailleurs — puis il scelle la preuve pour que chacun puisse la rejouer.",
  "hero.linkFool": "Le voir rejeter de mauvais tests",
  "hero.linkSource": "Le code sur GitHub",

  copy: "Copier",
  "copy.oneLine": "Copier en une ligne",
  "copy.done": "Copié",
  "copy.fail": "Échec",
  "copy.announce": "Copié dans le presse-papiers.",
  "copy.announceFail": "La copie a échoué. Sélectionnez le texte pour le copier.",

  "ledger.replay": "Relancer",
  "ledger.caption":
    "<code>isEven()</code>, tiré de l’exemple fourni. Chaque ligne est un test candidat exécuté seul : trois variantes, deux tentatives par variante. Enregistré avec assertledger 1.1.1.",
  "ledger.hTest": "Test candidat",
  "ledger.hFixed": "Code corrigé",
  "ledger.hBug": "Défaut connu",
  "ledger.hNeutral": "Témoin neutre",
  "ledger.hVerdict": "Verdict",
  "ledger.hWhy": "Pourquoi",

  "row.weak": "Vérifie le type",
  "row.strong": "Vérifie la réponse",
  "row.brittle": "Vérifie la réponse et le code source",
  "row.hangs": "Bloque sur le défaut",
  "row.throws": "Lève une exception au lieu d’une assertion",
  "row.flaky": "Instable",

  "sr.both": ", aux deux tentatives",
  "sr.bothAssert": ", échec d’assertion aux deux tentatives",
  "sr.mixed": ", une tentative chacun",

  "note.missed": "défaut manqué",
  "note.caught": "défaut détecté",
  "note.falseAlarm": "fausse alerte",
  "note.noCredit": "non crédité",
  "note.diverged": "tentatives divergentes",

  "why.weak": "Vert partout ne prouve rien : ce test aurait laissé passer le bug.",
  "why.strong":
    "Rouge sur le défaut, vert partout ailleurs. C’est exactement le rôle d’un test de régression.",
  "why.brittle":
    "Il détecte le défaut, mais échoue aussi sur une réécriture inoffensive : il vérifie comment le code est écrit, pas ce qu’il fait.",
  "why.hangs":
    "Un dépassement de délai n’est jamais une détection, ni une preuve dans un sens ou dans l’autre : les exécutions bloquées n’ont rien observé, le verdict est donc non concluant.",
  "why.throws":
    "Une TypeError levée est enregistrée comme un plantage, pas comme un échec d’assertion. Seuls les échecs d’assertion attribués comptent.",
  "why.flaky":
    "Ses deux tentatives se contredisent sur le code corrigé. Une nouvelle tentative qui passe n’efface jamais celle qui a échoué.",

  "fool.folio": "Essayez de le piéger",
  "fool.folioNote": "Registre, suite",
  "fool.title": "Quatre tests qui ont l’air corrects. Aucun n’est retenu.",
  "fool.lede":
    "Même fonction, mêmes trois variantes, vraies exécutions du moteur. Seul un échec d’assertion attribué sur le défaut connu compte comme une détection. Délais dépassés, plantages, erreurs de compilation ou de collecte sont enregistrés, jamais crédités.",
  "fool.caption":
    "Quatre campagnes à candidat unique sur <code>isEven()</code>, enregistrées avec assertledger 1.1.1. La ligne instable montre une exécution enregistrée : ses résultats changent d’une exécution à l’autre, et c’est tout le problème.",

  "verdicts.title": "Les quatre verdicts de campagne",
  "verdicts.verified": "Au moins un test respecte la politique déclarée et a été sélectionné.",
  "verdicts.rejected": "La preuve est concluante, et aucun test n’est retenu.",
  "verdicts.inconclusive":
    "Les observations sont instables ou incomplètes, ou un contrôle est invalide.",
  "verdicts.engine":
    "La preuve n’a pas pu être normalisée sans risque. Corrigez la configuration, puis relancez.",

  "how.folio": "Fonctionnement",
  "how.folioNote": "Aucun modèle dans la boucle",
  "how.title": "Mêmes octets. Trois variantes. Des gates fixes.",
  "how.s1.title": "Déclarer",
  "how.s1.text":
    "Désignez la révision fautive, sa correction et un témoin neutre qui doit préserver le comportement — avec la raison pour laquelle il le préserve. AssertLedger ne devine jamais ce que signifie votre défaut.",
  "how.s2.title": "Exécuter",
  "how.s2.text":
    "Les mêmes octets du candidat s’exécutent dans un espace de travail neuf pour chaque variante, autant de fois que la politique l’exige. Chaque variante s’exécute d’abord sans le candidat, comme contrôle.",
  "how.s2.art":
    "Pour chaque variante : deux exécutions de contrôle sans le candidat, puis deux exécutions avec lui.",
  "runs.control": "contrôle",
  "runs.candidate": "candidat",
  "runs.fixed": "code corrigé",
  "runs.bug": "défaut connu",
  "runs.neutral": "témoin neutre",
  "how.s3.title": "Décider",
  "how.s3.text":
    "Un noyau pur — sans modèle, sans horloge, sans hasard — applique six gates dans un ordre fixe. Quand un prérequis échoue, les gates qui en dépendent sont enregistrées comme non exécutées.",
  "gate.completeness": "chaque variante a le nombre de tentatives requis",
  "gate.stability": "les tentatives concordent",
  "gate.discovery": "le test est trouvé et attribué",
  "gate.reference": "passe sur le code corrigé",
  "gate.neutral": "passe sur le témoin neutre",
  "gate.target": "échoue, par assertion, sur le défaut",
  "how.s4.title": "Sceller",
  "how.s4.text":
    "Deux empreintes SHA-256 lient la preuve dans un manifeste. Le replay recalcule les deux empreintes et le verdict, sans relancer un seul test.",
  "digest.decision": "lie la preuve dont dépend le verdict",
  "digest.artifact": "lie le manifeste entier, jusqu’à chaque durée",

  "ev.folio": "Preuve",
  "ev.folioNote": "Rejouable hors ligne",
  "ev.title": "Ne croyez pas cette page sur parole. Rejouez-la.",
  "ev.lede":
    "Chaque déploiement de ce site exécute l’exemple fourni avec AssertLedger sur GitHub Actions et publie le manifeste obtenu. Le replay n’a besoin d’aucun modèle et n’exécute aucun test : il redérive le verdict et les deux empreintes à partir de la preuve enregistrée.",
  "ev.provenancePending": "résultat attendu",
  "ev.recordedAt": "enregistré au déploiement",
  "ev.commit": "commit",
  "ev.fact.candidates": "tests candidats",
  "ev.fact.worlds": "variantes",
  "ev.fact.observations": "observations",
  "ev.download": "Télécharger manifest.json",
  "ev.replayTitle": "Rejouez-le n’importe où",
  "ev.expected": "Sortie attendue, telle que documentée",
  "ev.recorded": "Sortie du replay exécuté au déploiement",
  "ev.tamper":
    "Modifiez un seul résultat enregistré et le replay rejette le fichier : les empreintes et le verdict redérivé ne concordent plus.",
  "ev.limit":
    "Le replay prouve l’intégrité et la cohérence de la décision. Il ne prouve pas qui a produit les observations.",

  "start.folio": "Démarrer",
  "start.title": "Commencez par une commande.",
  "start.lede":
    "Installez-le dans le dépôt à vérifier. <code>doctor</code> lit le dépôt sans exécuter ses tests ni écrire de fichier.",
  "start.tabsAria": "Points d’entrée",
  "tab.agents": "Agents · MCP",
  "start.cli.install": "Installer et diagnostiquer",
  "start.cli.check": "Qualifier un test de régression commité",
  "start.cli.warn":
    "<strong>Code de confiance uniquement.</strong> <code>--allow-unsafe-execution</code> exécute le code du dépôt sur cette machine, sans sandbox. Depuis la 1.1, <code>--container-image NAME@sha256:DIGEST</code> exécute plutôt chaque observation dans un conteneur Linux neuf.",
  "start.cli.explain":
    "Bloqué par un refus ? <code>npx assertledger explain REASON_CODE</code> indique une prochaine action sûre.",
  "start.sdk.note":
    'Une requête déclare les variantes, les candidats et la politique — voir l’<a href="https://github.com/hoklims/assertledger/blob/main/examples/node-test/request.json">exemple fourni</a>. Le SDK réutilise les gates du moteur ; il ne les réimplémente jamais.',
  "start.agents.bar": "Configuration locale au projet",
  "start.agents.c1": "# Prévisualiser la configuration et le skill fourni",
  "start.agents.c2": "# Installer les deux",
  "start.agents.c3": "# Codex, ou un descripteur MCP générique",
  "start.agents.note":
    "Un agent peut proposer un test candidat ; le moteur déterministe juge les observations. Le serveur MCP généré démarre en lecture seule, et l’exécution de candidats exige un opt-in explicite et séparé.",

  "fine.folio": "Petites lignes",
  "fine.folioNote": "Ce qui n’est pas revendiqué",
  "fine.title": "Les petites lignes, en gros caractères.",
  "fine.lede": "Un verdict ne vaut que par ses limites. Voici ce qu’AssertLedger ne prouve pas.",
  "fine.1.t": "Que votre code est sans bug.",
  "fine.1.d":
    "Un verdict couvre le défaut déclaré, les variantes enregistrées et les tentatives observées. Rien au-delà.",
  "fine.2.t": "Que vos variantes ont du sens.",
  "fine.2.d":
    "Vous fournissez le défaut et le témoin neutre. AssertLedger les enregistre ; il n’invente pas leur signification.",
  "fine.3.t": "Qu’un test ne sera jamais instable.",
  "fine.3.d": "La stabilité est mesurée sur les tentatives observées, pas promise au-delà.",
  "fine.4.t": "Qui a produit la preuve.",
  "fine.4.d":
    "Le replay vérifie l’intégrité et la cohérence de la décision. Authentifier le producteur exige une attestation signée distincte.",
  "fine.5.t": "Que les exécutions locales sont isolées.",
  "fine.5.d":
    "<code>trusted-local</code> est explicitement <code>UNSANDBOXED</code> : n’exécutez que du code de confiance. L’isolation par conteneur s’exécute sans réseau ni montage de l’hôte, mais partage toujours le noyau de l’hôte.",
  "fine.link.proof": "Modèle de preuve",
  "fine.link.container": "Isolation par conteneur",
  "fine.link.security": "Politique de sécurité",

  "foot.line": "Des verdicts déterministes. Une preuve rejouable.",
  "foot.aria": "Projet",
  "foot.docs": "Documentation",
  "foot.changelog": "Journal des versions",
  "foot.security": "Sécurité",
};
