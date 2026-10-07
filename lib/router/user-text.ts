/**
 * Brand for raw user message text. The server stores, hashes and span-locates it; it never interprets it.
 * The architecture guard (tests/architecture/user-text-guard.test.ts) fails when a UserText-typed expression
 * is used as the receiver of string methods, regex input, a comparison operand, etc., outside the allowlist.
 */
export type UserText = string & { readonly __userText: unique symbol };

export const USER_TEXT_MAX_CHARS = 8000;

/** Brand a raw string at ingress (request parse / stored user message read). No transformation. */
export function brandUserText(value: string): UserText { return value as UserText; }

/** Size-only check (the one permitted `trim`); allowlisted by name in the guard. */
export function assertUserTextSize(text: UserText): void {
  if (!text.trim().length || text.length > USER_TEXT_MAX_CHARS) throw new Error('Message must be 1-8000 characters.');
}
