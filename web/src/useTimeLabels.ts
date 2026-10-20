import { useRef } from "react";
import { useI18n } from "./i18n";
import { formatDuration } from "./timing";

/** Throttle text only. Geometry continues to use the current precise clock. */
export function useTimeLabels(active = false) {
  const { language } = useI18n();
  const cache = useRef(
    new Map<string, { at: number; text: string; language: string }>(),
  );
  return (key: string, ms: number | null | undefined, settled = false) => {
    const previous = cache.current.get(key);
    const now = performance.now();
    if (
      active &&
      !settled &&
      previous &&
      previous.language === language &&
      now - previous.at < 500
    )
      return previous.text;
    const text =
      active && !settled && ms != null
        ? formatDuration(
            ms < 1000
              ? Math.floor(ms / 100) * 100
              : Math.floor(ms / 1000) * 1000,
            language,
          )
        : formatDuration(ms, language);
    cache.current.set(key, { at: now, text, language });
    return text;
  };
}
