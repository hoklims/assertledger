# Initialization result v3

When static `doctor` or `init` reports `FRAMEWORK_AMBIGUOUS`, its result now has
`schemaVersion: "3.0.0"` and `detectedFrameworks`, sorted by framework. Each entry contains the
framework and sorted repository-relative files that caused its detection. An explicit framework
that disagrees with detected evidence also returns this result. Inspect those files before selecting
`--framework`; detection remains static and does not execute tests.

Other results retain their existing v1 or v2 version. The v1 and v2 parsers and schemas remain
unchanged; consumers must accept v3 to read ambiguous results. `setup` retains its existing nested
result contract and does not expose the v3 evidence. Config, lock and their digest projections do
not change. `assertledger schema repository-init-result-v3` returns the new schema.
