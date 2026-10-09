// Additive v1 qualification lock; existing conformance/schema-extensions.json stays frozen.
export const QUALIFICATION_SCHEMA_LOCK = [
  {
    path: "schemas/qualification-plan.v1.json",
    rawSha256: "sha256:9031c5a1cfa7a7b6a6c8928f8b3acb8d464b2b110f47f647374da2ae5360c9ca",
    $id: "https://testforge.dev/schemas/qualification-plan.v1.json",
  },
  {
    path: "schemas/qualification-execution-request.v1.json",
    rawSha256: "sha256:55660a7cc1324f28d5e3f2f6c3a46babea53388a5fbc120b84512116edfbee79",
    $id: "https://testforge.dev/schemas/qualification-execution-request.v1.json",
  },
  {
    path: "schemas/qualification-receipt.v1.json",
    rawSha256: "sha256:e523be7fb04d2f8c01cfd6ae5b8e11ed4dd71137c1677829e27301470987c028",
    $id: "https://testforge.dev/schemas/qualification-receipt.v1.json",
  },
  {
    path: "schemas/qualification-replay-result.v1.json",
    rawSha256: "sha256:dcba32bdd1d9e5dcc435b29963debba9a715bed12afffd307c7443649c92fb35",
    $id: "https://testforge.dev/schemas/qualification-replay-result.v1.json",
  },
] as const;
