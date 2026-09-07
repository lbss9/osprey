import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import en from "./en.json";
import ptBR from "./pt-BR.json";

export const LANGUAGES = [
  { code: "en", label: "EN", name: "English" },
  { code: "pt-BR", label: "PT", name: "Português (BR)" },
] as const;

export type LangCode = (typeof LANGUAGES)[number]["code"];

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      "pt-BR": { translation: ptBR },
      pt: { translation: ptBR },
    },
    fallbackLng: "en",
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "osprey-lang",
      caches: ["localStorage"],
    },
    interpolation: { escapeValue: false },
  });

i18n.on("languageChanged", (lng) => {
  document.documentElement.setAttribute("lang", lng);
});
document.documentElement.setAttribute("lang", i18n.language || "en");

/**
 * Translate a backend error string (`errors.<key>` or `errors.<key>|detail`).
 */
export function translateError(err: unknown): string {
  const raw = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
  const [key, ...rest] = raw.split("|");
  const detail = rest.join("|");
  if (key.startsWith("errors.") && i18n.exists(key)) {
    const base = i18n.t(key);
    return detail ? `${base}: ${detail}` : base;
  }
  return raw;
}

export default i18n;
