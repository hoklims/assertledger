export const CONFORMANCE_V1_FILE_DIGESTS = {
  "bundle.json": "sha256:0777a9889bac58db8baca2a8ac67bad71419a5ea4cf99d4814540a8acbb1ad52",
  "expected/canonical-order-a.json":
    "sha256:b8cb479fcac71990a1c48027948a84efce90116728dd77a665ac1f5242da9580",
  "expected/canonical-order-b.json":
    "sha256:b8cb479fcac71990a1c48027948a84efce90116728dd77a665ac1f5242da9580",
  "expected/create-benchmark-v1-measured.json":
    "sha256:c41330bbc2f2d87b7a1523123908983bc9c387df1f80105e8bb70f11c1866614",
  "expected/create-profile-v1-qualified.json":
    "sha256:06c6a57038992dde9657236bf39a41bce5e907bef47a4aab9b517686a5b94194",
  "expected/decide-collection-failure-non-kill.json":
    "sha256:d52c9152ecc59a776daa338f4bb797c0d70f1aa01dfccd61a4c02f98a1a81c51",
  "expected/decide-compile-failure-non-kill.json":
    "sha256:cee2190a14535de38d60693f89f8bb68f580e23f9e6a85c1e4c7b0372c071724",
  "expected/decide-infra-error-non-kill.json":
    "sha256:c84709d8fe090e3b7c4d406087c1f4fd2b29a767051fe4d4fd10f5fb2cc48715",
  "expected/decide-no-test-discovered-non-kill.json":
    "sha256:257d0d30f0ef23288fb7d793282136b835e1761410444c710efd3db4933e21fe",
  "expected/decide-process-crash-non-kill.json":
    "sha256:c42e114e6cdd0c68a5d8542662a38fcea5125bcfea8d327f0a187906d0c6f52e",
  "expected/decide-timeout-non-kill.json":
    "sha256:b50a77a6992c55cf1f70973f8bbd6dccc6f4c630fb8558e0cd3afcc785349130",
  "expected/decide-verified.json":
    "sha256:cb95f0466b9c5dcacd45829431517a25fa7ab0b1dd389e2eccfcf43b02c1a2aa",
  "expected/replay-benchmark-v1-resealed-summary-forgery.json":
    "sha256:fbdd46d95d029250bbe2f108f3675187f95fbda8d3680bfe85f542a5e20a9e15",
  "expected/replay-evidence-raw-tamper.json":
    "sha256:53280b535aa928b27ff879c05fdd76bcf299941a78c01aa369523570ff5b40b8",
  "expected/replay-evidence-resealed-semantic-forgery.json":
    "sha256:b7c690327c195bf869b06ed8bc67a652749280de435cb3d5b64cd45a383e2d98",
  "inputs/canonical-order-a.json":
    "sha256:8b0aab865dd8cfc0c255a420faa6f489d2dd549cb986c0cc8b473e2080c4a2ee",
  "inputs/canonical-order-b.json":
    "sha256:0c1f0bb3657c75e11f8f00bf3a0f2eab7a94038348799c0f408ab110d69d098c",
  "inputs/create-benchmark-v1-measured.json":
    "sha256:8fb81b0e2fb3c3ebfa3d46a40ae82ad42254e3d7b4c709af9b9027a823936137",
  "inputs/create-profile-v1-qualified.json":
    "sha256:57eed08a9dfc1897ab7b6d67ab26bb608805b1090960dd77d415bb6e65e6730d",
  "inputs/decide-collection-failure-non-kill.json":
    "sha256:b10ef80cb319380dc9b09cdfb8a9c25bb4b61b69c134bb834ebfecd0ca44ab4f",
  "inputs/decide-compile-failure-non-kill.json":
    "sha256:45b29402b0ea9d0d891c48e5331caa926d56ba5e6b59e43dea6782ac143340af",
  "inputs/decide-infra-error-non-kill.json":
    "sha256:1c8606bf1592748061856afe1e47978be343f270e1f1537ede7f71c4be76dab2",
  "inputs/decide-no-test-discovered-non-kill.json":
    "sha256:90f09930f4bcfbce140b9832869cc8e280764cd2c8cd0bb5c8826e4efdb7b1ef",
  "inputs/decide-process-crash-non-kill.json":
    "sha256:9f202efdb0caee449b73ee9554ddb75ab8d306e285df27ca19fe50c155e9b6a8",
  "inputs/decide-timeout-non-kill.json":
    "sha256:ea26ab45a3be6e6e948272525b84af233482d8e1d50ea96261b92213627d0c4b",
  "inputs/decide-verified.json":
    "sha256:b6f8f130068f172ad8e08d20c271a1bfa1a7d3de9e39572a0833f83d4fed9193",
  "inputs/replay-benchmark-v1-resealed-summary-forgery.json":
    "sha256:f033b9c71c30f88d741fee73d5d010c61e5e9778552a61d7d39d5d53f523cfbc",
  "inputs/replay-evidence-raw-tamper.json":
    "sha256:c27c4d3631c9bf4423cb174111b20f67c63051bca7e993ccc8f8d7de305fa1c5",
  "inputs/replay-evidence-resealed-semantic-forgery.json":
    "sha256:a307cee4d0ab4c5545ae4e237cd952b814fbbb8092ffe7cdc373d44c89847529",
  "schemas/expected-digests.json":
    "sha256:f76ae50c78b89082d549d4030f92ef77a8d88b8376b3ab0864effc84797f0aca",
} as const;

export const CONFORMANCE_V1_ROOT_DIGEST =
  "sha256:ba273caef39191105f3f8ab5d0c52a5c231dc4c8b6e7bd51cdbfdf1868d4d9bb";

export const CONFORMANCE_V1_PUBLIC_DIGESTS = {
  decisionDigest: "sha256:bbecbbbbb790db1912b9ce06336420446c71df8d57eb0b040854ba672a220faa",
  artifactDigest: "sha256:1a45e9274159f3f90826303a3e9568cac11fd379bb4bcfb68daa27328ab7e31f",
  profileReportDigest: "sha256:72db450c9ae85310ce3f5c3543aa8d3c7b9a0cf11c01165c788f6654dd75c7c7",
  benchmarkArtifactDigest:
    "sha256:60c55617fd1a951cec452f67523df92ab0d7ec935f1a0b45629631192ddc6ce8",
} as const;
