import { BUN_TEST_ADAPTER_PROFILE } from "./bun-test-profile.js";

/**
 * Runs one existing bun:test test, named by file and describe path. A failure thrown inside it by
 * a built-in matcher, with Bun's matcher message form, or by assertSame is an owned assertion; with
 * a declared expected line, only a failure whose first message line equals it is admitted.
 */
export const BUN_TEST_DESIGNATED_ADAPTER_PROFILE = {
  profileId: "bun-test-designated",
  profileVersion: "1.0.0",
  official: true,
  bunVersion: BUN_TEST_ADAPTER_PROFILE.bunVersion,
  bunRevision: BUN_TEST_ADAPTER_PROFILE.bunRevision,
  capabilities: {
    assertionSource: "bun-builtin-matcher-or-assertSame-issued-error",
    attributesPerAssertionFailure: true,
    controlMode: "load-designated-files-without-running-tests",
    detectsCollectionFailure: false,
    detectsCompileFailure: false,
    expectedFailureLine: "first-message-line-exact",
    reporterTransport: "signed-preload-pipe+junit",
    supportsContainer: true,
  },
} as const;

/** Separately qualified for the Windows-native v4/v5 backend only. */
export const WINDOWS_X64_BUN_143_DESIGNATED_PROFILE = {
  ...BUN_TEST_DESIGNATED_ADAPTER_PROFILE,
  profileVersion: "1.1.0",
  bunVersion: "1.4.3",
  bunRevision: "c6da4a4d3010e5553438c60f6bd76d981976867c",
  platform: "win32",
  arch: "x64",
  capabilities: { ...BUN_TEST_DESIGNATED_ADAPTER_PROFILE.capabilities, supportsContainer: false },
} as const;

export function permitsWindowsX64Bun143(
  adapter: string,
  backend: string,
  hostPlatform: NodeJS.Platform,
  hostArch: string,
): boolean {
  return (
    adapter === "bun-test-designated" &&
    backend === "windows-native" &&
    hostPlatform === "win32" &&
    hostArch === "x64"
  );
}

/** The regular Bun 1.4.4 profile has separate pins in each execution backend. */
export function isWindowsX64Bun143(
  version: string,
  revision: string,
  platform: unknown,
  arch: unknown,
): boolean {
  const profile = WINDOWS_X64_BUN_143_DESIGNATED_PROFILE;
  return (
    version === profile.bunVersion &&
    revision === profile.bunRevision &&
    platform === profile.platform &&
    arch === profile.arch
  );
}
