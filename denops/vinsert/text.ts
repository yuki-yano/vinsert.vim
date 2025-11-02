const CONTROL_CHARS_EXCEPT_LF = /[^\P{Cc}\n]/gu;

export function sanitizeText(text: string): string {
  return text.replace(CONTROL_CHARS_EXCEPT_LF, "").normalize("NFC");
}
