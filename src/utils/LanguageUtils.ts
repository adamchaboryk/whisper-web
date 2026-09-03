// List of right-to-left language codes supported by Whisper and common web standards
export const RTL_LANGUAGES = new Set([
  "ar", // Arabic
  "he", // Hebrew
  "fa", // Persian
  "ur", // Urdu
  "ps", // Pashto
  "sd", // Sindhi
  "yi", // Yiddish
]);

// Regular expressions for detecting non-Latin scripts from character codes
const ARABIC_SCRIPT_REGEX =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const HEBREW_SCRIPT_REGEX = /[\u0590-\u05FF\uFB1D-\uFB4F]/g;
const JAPANESE_SCRIPT_REGEX = /[\u3040-\u309F\u30A0-\u30FF]/g;
const KOREAN_SCRIPT_REGEX = /[\uAC00-\uD7AF\u1100-\u11FF]/g;
const CHINESE_SCRIPT_REGEX = /[\u4E00-\u9FFF]/g;
const CYRILLIC_SCRIPT_REGEX = /[\u0400-\u04FF]/g;
const GREEK_SCRIPT_REGEX = /[\u0370-\u03FF]/g;
const DEVANAGARI_SCRIPT_REGEX = /[\u0900-\u097F]/g;
const THAI_SCRIPT_REGEX = /[\u0E00-\u0E7F]/g;

const SCRIPT_RULES: [string, RegExp][] = [
  ["ar", ARABIC_SCRIPT_REGEX],
  ["he", HEBREW_SCRIPT_REGEX],
  ["ja", JAPANESE_SCRIPT_REGEX],
  ["ko", KOREAN_SCRIPT_REGEX],
  ["zh", CHINESE_SCRIPT_REGEX],
  ["ru", CYRILLIC_SCRIPT_REGEX],
  ["el", GREEK_SCRIPT_REGEX],
  ["hi", DEVANAGARI_SCRIPT_REGEX],
  ["th", THAI_SCRIPT_REGEX],
];

function countMatches(str: string, regex: RegExp): number {
  regex.lastIndex = 0;
  let count = 0;
  while (regex.test(str)) {
    count++;
  }
  return count;
}

/**
 * Returns text direction ('rtl' or 'ltr') for a given language code.
 */
export function getLanguageDirection(language?: string): "rtl" | "ltr" {
  if (!language) return "ltr";
  const normalized = language.toLowerCase().split("-")[0];
  return RTL_LANGUAGES.has(normalized) ? "rtl" : "ltr";
}

/**
 * Detects the language from Unicode script analysis of the text.
 * Especially reliable for distinctive scripts like Arabic and Hebrew.
 */
export function detectScriptLanguage(text: string): string | undefined {
  if (!text || !text.trim()) return undefined;

  // Sample up to the first 1,000 characters to determine the script without scanning full hours of audio
  const sample = text.length > 1000 ? text.slice(0, 1000) : text;

  let bestLang: string | undefined = undefined;
  let maxCount = 0;

  for (let i = 0; i < SCRIPT_RULES.length; i++) {
    const [lang, regex] = SCRIPT_RULES[i];
    const count = countMatches(sample, regex);
    if (count > maxCount) {
      maxCount = count;
      bestLang = lang;
    }
  }

  return bestLang;
}

/**
 * Resolves the primary language and text direction for transcript output.
 * Handles Whisper's translation subtask (which produces English), script detection
 * (e.g. Arabic, Hebrew), and explicitly configured/detected language codes.
 */
export function resolveLanguageAndDirection(
  text?: string,
  configuredLanguage?: string,
  subtask?: string,
): { language: string; dir: "rtl" | "ltr" } {
  // If task is translation, Whisper always outputs English.
  if (subtask === "translate") {
    return { language: "en", dir: "ltr" };
  }

  const scriptLanguage = text ? detectScriptLanguage(text) : undefined;

  // If text contains a strong script (e.g. Arabic or Hebrew characters), prioritize it
  if (scriptLanguage) {
    return {
      language: scriptLanguage,
      dir: getLanguageDirection(scriptLanguage),
    };
  }

  // If configured/passed language is a specific language (and not 'auto')
  if (configuredLanguage && configuredLanguage !== "auto") {
    const normalized = configuredLanguage.toLowerCase().split("-")[0];
    return {
      language: normalized,
      dir: getLanguageDirection(normalized),
    };
  }

  return { language: "en", dir: "ltr" };
}

