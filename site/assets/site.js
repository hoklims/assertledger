import { FR } from "./i18n.js";

const root = document.documentElement;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const REPOSITORY = "https://github.com/hoklims/assertledger";
const LANGUAGE_KEY = "assertledger-lang";

// Strings that only exist at runtime. Everything else is authored in index.html.
const EN = {
  "copy.done": "Copied",
  "copy.fail": "Failed",
  "copy.announce": "Copied to the clipboard.",
  "copy.announceFail": "Copy failed. Select the text to copy it.",
  "ev.recorded": "Replay output recorded at deploy",
  "ev.recordedAt": "recorded at deploy",
  "ev.commit": "commit",
};

let language = "en";
const originals = new WeakMap();

function t(key) {
  return (language === "fr" && FR[key]) || EN[key] || key;
}

function original(element, slot, read) {
  let saved = originals.get(element);
  if (!saved) {
    saved = new Map();
    originals.set(element, saved);
  }
  if (!saved.has(slot)) saved.set(slot, read());
  return saved.get(slot);
}

function translate(element) {
  const { i18n, i18nHtml, i18nAttr } = element.dataset;
  if (i18n) {
    const english = original(element, "text", () => element.textContent);
    element.textContent = language === "fr" ? (FR[i18n] ?? english) : english;
  }
  if (i18nHtml) {
    const english = original(element, "html", () => element.innerHTML);
    element.innerHTML = language === "fr" ? (FR[i18nHtml] ?? english) : english;
  }
  if (i18nAttr) {
    for (const pair of i18nAttr.split(";")) {
      const [name, key] = pair.split(":");
      const english = original(element, `attr:${name}`, () => element.getAttribute(name));
      element.setAttribute(name, language === "fr" ? (FR[key] ?? english) : english);
    }
  }
}

// Points an element at a runtime key whose English text lives in EN.
function setKey(element, key) {
  element.dataset.i18n = key;
  originals.set(element, new Map([["text", EN[key] ?? key]]));
  translate(element);
}

function applyLanguage(next) {
  language = next === "fr" ? "fr" : "en";
  root.lang = language;
  for (const element of document.querySelectorAll(
    "[data-i18n], [data-i18n-html], [data-i18n-attr]",
  )) {
    translate(element);
  }
  for (const button of document.querySelectorAll("[data-lang]")) {
    button.setAttribute("aria-pressed", String(button.dataset.lang === language));
  }
}

function initialLanguage() {
  const requested = new URLSearchParams(window.location.search).get("lang");
  if (requested === "en" || requested === "fr") return requested;
  try {
    const stored = window.localStorage.getItem(LANGUAGE_KEY);
    if (stored === "en" || stored === "fr") return stored;
  } catch {
    // Storage can be unavailable (private browsing, blocked cookies); detection applies.
  }
  const preferred = navigator.languages?.[0] ?? navigator.language ?? "";
  return preferred.toLowerCase().startsWith("fr") ? "fr" : "en";
}

function initLanguage() {
  applyLanguage(initialLanguage());
  for (const button of document.querySelectorAll("[data-lang]")) {
    button.addEventListener("click", () => {
      applyLanguage(button.dataset.lang);
      try {
        window.localStorage.setItem(LANGUAGE_KEY, language);
      } catch {
        // The choice still applies to this page view.
      }
    });
  }
}

// ---------- Copy to clipboard ----------

const announcer = document.getElementById("announcer");

function announce(message) {
  if (!announcer) return;
  announcer.textContent = "";
  window.requestAnimationFrame(() => {
    announcer.textContent = message;
  });
}

async function writeClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Denied by a permission policy (embedded viewers, some WebViews): try the legacy path.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("Clipboard unavailable");
}

function initCopyButtons() {
  for (const button of document.querySelectorAll("button.copy")) {
    const label = button.querySelector("[data-i18n]");
    let reset;
    button.addEventListener("click", async () => {
      const text = button.dataset.copyFrom
        ? document.getElementById(button.dataset.copyFrom)?.textContent
        : button.dataset.copy;
      if (!text || !label) return;
      window.clearTimeout(reset);
      try {
        await writeClipboard(text);
        button.dataset.state = "done";
        label.textContent = t("copy.done");
        announce(t("copy.announce"));
      } catch {
        button.dataset.state = "error";
        label.textContent = t("copy.fail");
        announce(t("copy.announceFail"));
      }
      reset = window.setTimeout(() => {
        delete button.dataset.state;
        translate(label);
      }, 1800);
    });
  }
}

// ---------- Ledger runs ----------

const WORLDS = ["fixed", "bug", "neutral"];
const running = new WeakMap();

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function resetLedger(table) {
  table.classList.add("is-pending");
  for (const element of table.querySelectorAll(".is-lit, .is-resolved, .is-stamped, .is-shown")) {
    element.classList.remove("is-lit", "is-resolved", "is-stamped", "is-shown");
  }
}

// Replays the recorded results in execution order: attempts, outcome, verdict, reason.
async function runLedger(table) {
  running.get(table)?.abort();
  const controller = new AbortController();
  running.set(table, controller);
  const { signal } = controller;
  const entries = [...table.querySelectorAll("tbody .entry")];
  resetLedger(table);
  try {
    await wait(320, signal);
    for (const world of WORLDS) {
      const cells = entries.map((entry) => entry.querySelector(`.cell[data-world="${world}"]`));
      for (const attempt of [0, 1]) {
        for (const cell of cells)
          cell?.querySelectorAll(".attempts i")[attempt]?.classList.add("is-lit");
        await wait(170, signal);
      }
      for (const cell of cells) cell?.classList.add("is-resolved");
      await wait(300, signal);
    }
    for (const entry of entries) {
      entry.querySelector(".verdict")?.classList.add("is-stamped");
      await wait(180, signal);
    }
    for (const entry of entries) entry.querySelector(".why")?.classList.add("is-shown");
    table.classList.remove("is-pending");
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

function whenVisible(element, callback) {
  if (!("IntersectionObserver" in window)) {
    callback();
    return;
  }
  const observer = new IntersectionObserver(
    (records) => {
      if (records.some((record) => record.isIntersecting)) {
        observer.disconnect();
        callback();
      }
    },
    { threshold: 0.2 },
  );
  observer.observe(element);
}

function initLedgers() {
  window.clearTimeout(window.__ledgerFailsafe);
  const tables = [...document.querySelectorAll(".ledger[data-animate]")];
  const replayButtons = [...document.querySelectorAll("[data-ledger-replay]")];
  if (reduceMotion.matches) {
    root.classList.remove("ledger-armed");
    for (const button of replayButtons) button.hidden = true;
    return;
  }
  for (const table of tables) resetLedger(table);
  root.classList.remove("ledger-armed");
  for (const table of tables) {
    if (table.dataset.animate === "load") runLedger(table);
    else whenVisible(table, () => runLedger(table));
  }
  for (const button of replayButtons) {
    button.addEventListener("click", () => {
      const table = document.getElementById(button.dataset.ledgerReplay);
      if (table) runLedger(table);
    });
  }
}

// ---------- Tabs ----------

function initTabs() {
  for (const container of document.querySelectorAll("[data-tabs]")) {
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    const panels = tabs.map((tab) => document.getElementById(tab.getAttribute("aria-controls")));
    const select = (index, focus) => {
      tabs.forEach((tab, position) => {
        const selected = position === index;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        if (panels[position]) panels[position].hidden = !selected;
      });
      if (focus) tabs[index]?.focus();
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => select(index, false));
      tab.addEventListener("keydown", (event) => {
        const last = tabs.length - 1;
        const next = {
          ArrowRight: index === last ? 0 : index + 1,
          ArrowLeft: index === 0 ? last : index - 1,
          Home: 0,
          End: last,
        }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        select(next, true);
      });
    });
    container.classList.add("is-enhanced");
    select(0, false);
  }
}

// ---------- Evidence published by the Pages workflow ----------

async function fetchText(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.text();
}

function formatBytes(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

async function loadEvidence() {
  const scope = document.getElementById("evidence");
  if (!scope) return;
  const field = (name) => scope.querySelector(`[data-ev="${name}"]`);

  let manifestText;
  let manifest;
  let replay;
  try {
    [manifestText, replay] = await Promise.all([
      fetchText("evidence/manifest.json"),
      fetchText("evidence/replay.json").then(JSON.parse),
    ]);
    manifest = JSON.parse(manifestText);
  } catch {
    // No published evidence (local preview): the documented expectation stays on the page.
    return;
  }
  const [build, release] = await Promise.all(
    ["evidence/build-info.json", "evidence/version.json"].map((path) =>
      fetchText(path)
        .then(JSON.parse)
        .catch(() => null),
    ),
  );
  if (typeof release?.version === "string" && /^\d+\.\d+\.\d+$/.test(release.version)) {
    for (const element of document.querySelectorAll("[data-version]")) {
      element.textContent = release.version;
    }
  }

  const status = field("status");
  status.textContent = manifest.decision.status;
  status.dataset.verdict = manifest.decision.status;
  field("candidates").textContent = String(manifest.candidates.length);
  field("worlds").textContent = String(manifest.worlds.length);
  field("observations").textContent = String(manifest.observations.length);
  field("excerpt").textContent = JSON.stringify(
    {
      decision: manifest.decision,
      decisionDigest: manifest.decisionDigest,
      artifactDigest: manifest.artifactDigest,
    },
    null,
    2,
  );
  field("size").textContent = formatBytes(new Blob([manifestText]).size);
  field("download").hidden = false;

  for (const rail of scope.querySelectorAll("[data-rail]")) {
    const value = replay[rail.dataset.rail];
    rail.dataset.result = value === true ? "pass" : "fail";
    rail.querySelector("span").textContent = String(value);
  }
  setKey(field("rails-label"), "ev.recorded");

  const recorded = document.createElement("span");
  setKey(recorded, "ev.recordedAt");
  const provenance = [recorded];
  const commit = build?.sourceRevision?.commit;
  if (typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit)) {
    const link = document.createElement("a");
    link.href = `${REPOSITORY}/commit/${commit}`;
    const word = document.createElement("span");
    setKey(word, "ev.commit");
    link.append(word, ` ${commit.slice(0, 7)}`);
    provenance.push(" · ", link);
  }
  field("provenance").replaceChildren(...provenance);
}

initLanguage();
initCopyButtons();
initLedgers();
initTabs();
loadEvidence();
