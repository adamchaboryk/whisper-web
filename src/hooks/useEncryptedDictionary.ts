import { useCallback, useEffect, useRef, useState } from "react";
import { TranscriptChunk } from "./useTranscriber";

export interface DictionaryEntry {
  id: string;
  targetWord: string;
  replacementWord: string;
}

const STORAGE_KEY = "whisper-web-text-replacement-dictionary";
const SECRET_KEY = `${STORAGE_KEY}-key`;
const DEFAULTS_MIGRATED_KEY = `${STORAGE_KEY}-defaults-migrated`;
const DICTIONARY_UPDATED_EVENT = "whisper-web-dictionary-updated";
const DEFAULT_ENTRIES: DictionaryEntry[] = [
  {
    id: "default-torontomu-domain",
    targetWord: "TorontoMu.ca",
    replacementWord: "torontomu.ca",
  },
  {
    id: "default-indigenous-people",
    targetWord: "indigenous people",
    replacementWord: "Indigenous people"
  }
];

function deduplicateEntries(entries: DictionaryEntry[]): DictionaryEntry[] {
  const seenTargets = new Set<string>();
  return entries.filter((entry) => {
    const targetKey = entry.targetWord.trim().toLocaleLowerCase();
    if (!targetKey || seenTargets.has(targetKey)) return false;
    seenTargets.add(targetKey);
    return true;
  });
}

function toBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): ArrayBuffer {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)).buffer;
}

async function getStorageKey(): Promise<CryptoKey> {
  let encodedKey = window.localStorage.getItem(SECRET_KEY);
  if (!encodedKey) {
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"],
    );
    encodedKey = JSON.stringify(await crypto.subtle.exportKey("jwk", key));
    window.localStorage.setItem(SECRET_KEY, encodedKey);
  }
  return crypto.subtle.importKey(
    "jwk", JSON.parse(encodedKey), { name: "AES-GCM" }, false, ["decrypt", "encrypt"],
  );
}

async function readEntries(): Promise<DictionaryEntry[]> {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (!stored) return DEFAULT_ENTRIES;
  try {
    const { iv, data } = JSON.parse(stored) as { iv: string; data: string };
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(iv) }, await getStorageKey(), fromBase64(data),
    );
    const entries = JSON.parse(new TextDecoder().decode(decrypted));
    return Array.isArray(entries) ? deduplicateEntries(entries) : DEFAULT_ENTRIES;
  } catch {
    return DEFAULT_ENTRIES;
  }
}

async function writeEntries(entries: DictionaryEntry[]): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, await getStorageKey(),
    new TextEncoder().encode(JSON.stringify(entries)),
  );
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ iv: toBase64(iv), data: toBase64(encrypted) }));
}

function parseCsvRow(row: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === '"' && row[index + 1] === '"') { value += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { values.push(value.trim()); value = ""; }
    else value += character;
  }
  values.push(value.trim());
  return values;
}

export function parseDictionaryCsv(content: string): DictionaryEntry[] {
  const rows = content.split(/\r?\n/).filter((row) => row.trim());
  if (!rows.length) throw new Error("CSV file is empty.");
  const seenTargets = new Set<string>();
  return rows.flatMap((row) => {
    const values = parseCsvRow(row);
    const targetWord = values[0]?.trim();
    const replacementWord = values[1]?.trim();
    const targetKey = targetWord?.toLocaleLowerCase();
    if (!targetWord || !targetKey || seenTargets.has(targetKey)) {
      return [];
    }
    seenTargets.add(targetKey);
    return [{ id: crypto.randomUUID(), targetWord, replacementWord: replacementWord ?? "" }];
  });
}

export function exportDictionaryCsv(entries: DictionaryEntry[]): void {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const content = entries.map((entry) => `${escape(entry.targetWord)},${escape(entry.replacementWord)}`).join("\n");
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8;" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "text-replacement-dictionary.csv";
  link.click();
  URL.revokeObjectURL(url);
}

export function useEncryptedDictionary() {
  const [entries, setEntries] = useState<DictionaryEntry[]>([]);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const hasStoredEntries = Boolean(window.localStorage.getItem(STORAGE_KEY));
    const defaultsMigrated = window.localStorage.getItem(DEFAULTS_MIGRATED_KEY) === "true";
    let needsDefaultMigration = !defaultsMigrated;
    const loadEntries = () => readEntries().then((loadedEntries) => {
      const shouldMigrateDefaults = hasStoredEntries && needsDefaultMigration;
      const nextEntries = shouldMigrateDefaults
        ? [
          ...DEFAULT_ENTRIES.filter(
            (defaultEntry) =>
              !loadedEntries.some((entry) => entry.id === defaultEntry.id),
          ),
          ...loadedEntries,
        ]
        : loadedEntries;
      setEntries(nextEntries);
      void writeEntries(nextEntries);
      window.localStorage.setItem(DEFAULTS_MIGRATED_KEY, "true");
      needsDefaultMigration = false;
    });
    void loadEntries();
    window.addEventListener(DICTIONARY_UPDATED_EVENT, loadEntries);
    const worker = new Worker(new URL("../worker.js", import.meta.url), { type: "module" });
    workerRef.current = worker;
    return () => {
      window.removeEventListener(DICTIONARY_UPDATED_EVENT, loadEntries);
      worker.terminate();
    };
  }, []);
  const save = (nextEntries: DictionaryEntry[]) => {
    setEntries(nextEntries);
    void writeEntries(nextEntries).then(() => {
      window.dispatchEvent(new Event(DICTIONARY_UPDATED_EVENT));
    });
  };
  const replaceTranscript = useCallback((text: string, chunks: TranscriptChunk[], entriesOverride = entries) => new Promise<{ text: string; chunks: TranscriptChunk[] }>((resolve, reject) => {
    const worker = workerRef.current;
    if (!worker) { reject(new Error("Dictionary worker is not ready.")); return; }
    const handleMessage = (event: MessageEvent) => {
      if (event.data.status !== "dictionary_replaced") return;
      worker.removeEventListener("message", handleMessage);
      resolve({ text: event.data.text, chunks: event.data.chunks });
    };
    worker.addEventListener("message", handleMessage);
    worker.postMessage({ type: "replace_dictionary", text, chunks, entries: entriesOverride });
  }), [entries]);
  const replaceChunks = useCallback(
    (chunks: TranscriptChunk[], entriesOverride?: DictionaryEntry[]): Promise<TranscriptChunk[]> =>
      replaceTranscript("", chunks, entriesOverride).then((result) => result.chunks),
    [replaceTranscript],
  );

  return {
    entries,
    addEntry: (targetWord: string, replacementWord: string): string | undefined => {
      const target = targetWord.trim(); const replacement = replacementWord.trim();
      if (!target) return "Enter a target word.";
      if (target === replacement) {
        return "Target and replacement words must be different.";
      }
      if (entries.some((entry) => entry.targetWord.trim().toLocaleLowerCase() === target.toLocaleLowerCase())) {
        return `A rule for "${target}" already exists.`;
      }
      save([{ id: crypto.randomUUID(), targetWord: target, replacementWord: replacement }, ...entries]);
      return undefined;
    },
    deleteEntry: (id: string) => save(entries.filter((entry) => entry.id !== id)),
    importEntries: (content: string) => {
      const importedEntries = parseDictionaryCsv(content);
      save(importedEntries);
      return importedEntries;
    },
    exportEntries: () => exportDictionaryCsv(entries),
    replaceTranscript,
    replaceChunks,
  };
}