/**
 * Sarvam AI: Indian-language output for the verdict.
 *
 * The reason this is not a nice-to-have. The driver who most needs "will I make
 * it, honestly" is not reading a Wh/km figure in English on a dashboard. They
 * want a sentence, in their language, ideally spoken, while they are deciding
 * whether to leave now. So the verdict is generated once in English and then
 * translated and voiced.
 *
 * Everything here degrades. No API key, a rate limit, a dropped request: the
 * caller gets the English text back with `available: false` and a stated
 * reason. Nothing in the product is gated on this working.
 */

const TRANSLATE_URL = "https://api.sarvam.ai/translate";
const TTS_URL = "https://api.sarvam.ai/text-to-speech";

/** Sarvam's translate endpoint caps input length, so long verdicts are chunked. */
const MAX_CHARS = 900;

export const SUPPORTED_LANGUAGES = [
  { code: "en-IN", label: "English", native: "English" },
  { code: "hi-IN", label: "Hindi", native: "हिन्दी" },
  { code: "mr-IN", label: "Marathi", native: "मराठी" },
  { code: "ta-IN", label: "Tamil", native: "தமிழ்" },
  { code: "te-IN", label: "Telugu", native: "తెలుగు" },
  { code: "kn-IN", label: "Kannada", native: "ಕನ್ನಡ" },
  { code: "bn-IN", label: "Bengali", native: "বাংলা" },
  { code: "gu-IN", label: "Gujarati", native: "ગુજરાતી" },
  { code: "pa-IN", label: "Punjabi", native: "ਪੰਜਾਬੀ" },
  { code: "ml-IN", label: "Malayalam", native: "മലയാളം" },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];

export const isSupportedLanguage = (code: string): code is LanguageCode =>
  SUPPORTED_LANGUAGES.some((l) => l.code === code);

export interface SpokenVerdict {
  language: string;
  text: string;
  /** base64 WAV, or null when TTS was unavailable. */
  audioBase64: string | null;
  available: boolean;
  /** Present when `available` is false. Shown in the UI rather than swallowed. */
  reason?: string;
}

/** Split on sentence boundaries, packing up to the endpoint's character cap. */
function chunk(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const out: string[] = [];
  let current = "";
  for (const s of sentences) {
    if ((current + s).length > MAX_CHARS && current.length > 0) {
      out.push(current.trim());
      current = s;
    } else {
      current += s;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

async function postJson(
  url: string,
  key: string,
  body: unknown,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-subscription-key": key,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Translates the verdict and, when asked, voices it.
 *
 * `mode: "modern-colloquial"` is the deliberate choice: the formal register
 * renders "87% confidence" into something no driver says out loud. The point of
 * this feature is a sentence a person would actually speak.
 */
export async function speakVerdict(
  englishText: string,
  language: string,
  withAudio: boolean,
): Promise<SpokenVerdict> {
  if (language === "en-IN") {
    return { language, text: englishText, audioBase64: null, available: true };
  }

  const key = process.env.SARVAM_API_KEY;
  if (!key) {
    return {
      language,
      text: englishText,
      audioBase64: null,
      available: false,
      reason: "SARVAM_API_KEY is not set, so the verdict stays in English.",
    };
  }

  let translated: string;
  try {
    const pieces = await Promise.all(
      chunk(englishText).map(async (piece) => {
        const json = await postJson(
          TRANSLATE_URL,
          key,
          {
            input: piece,
            source_language_code: "en-IN",
            target_language_code: language,
            model: "sarvam-translate:v1",
            mode: "modern-colloquial",
            enable_preprocessing: true,
          },
          12_000,
        );
        const out = json.translated_text;
        if (typeof out !== "string") throw new Error("translate returned no translated_text");
        return out;
      }),
    );
    translated = pieces.join(" ");
  } catch (err) {
    return {
      language,
      text: englishText,
      audioBase64: null,
      available: false,
      reason: `Translation failed (${err instanceof Error ? err.message : "unknown error"}).`,
    };
  }

  if (!withAudio) {
    return { language, text: translated, audioBase64: null, available: true };
  }

  try {
    // TTS gets the first two sentences only. A spoken paragraph of statistics is
    // worse than a spoken headline the driver can act on.
    const spoken = (translated.match(/[^.!?]+[.!?]*/g) ?? [translated]).slice(0, 2).join(" ");
    const json = await postJson(
      TTS_URL,
      key,
      {
        inputs: [spoken.slice(0, 480)],
        target_language_code: language,
        speaker: "anushka",
        model: "bulbul:v2",
        speech_sample_rate: 22050,
        enable_preprocessing: true,
      },
      15_000,
    );
    const audios = json.audios;
    const audio = Array.isArray(audios) && typeof audios[0] === "string" ? audios[0] : null;
    return {
      language,
      text: translated,
      audioBase64: audio,
      available: true,
      reason: audio ? undefined : "Translated, but text-to-speech returned no audio.",
    };
  } catch (err) {
    return {
      language,
      text: translated,
      audioBase64: null,
      available: true,
      reason: `Translated, but speech failed (${err instanceof Error ? err.message : "unknown error"}).`,
    };
  }
}
