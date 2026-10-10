export function failCommandArgs({ emptySelection = false, cacheDirectory }) {
  return [
    "run",
    "fail",
    emptySelection ? "--filter=!@public/*" : "--filter=@public/app...",
    "--cache=local:rw",
    `--cache-dir=${cacheDirectory}`,
    "--summarize",
  ];
}

export function wrapperCommandArgs(wrapperPath) {
  return [wrapperPath, "orchestrator"];
}
