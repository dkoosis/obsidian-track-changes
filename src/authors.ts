// Author detection and per-author color assignment.
//
// A CriticMarkup comment is "named" if its body starts with `<Name>:` where
// `<Name>` is a single token (alpha-leading, \w/./- body, max 30 chars).
// Otherwise it's unnamed — the local user, rendered as "You".
//
// Each named author gets a hue from a small palette. Well-known LLM names
// (Claude, GPT, Gemini, …) are pinned to specific palette indices so the
// same model gets the same color across documents. Unknown names fall
// through to a hash. The palette itself lives in `styles.css` as
// `--tc-author-hue-N` CSS variables.

export const AUTHOR_RE = /^\s*([A-Za-z][\w.-]{0,29})\s*:\s*/;

// AUTHOR_RE anchored as a whole-string match: the token rule with no
// surrounding prefix/colon. A name that fails this must not be prefixed onto a
// comment — the parser wouldn't recognise it as `<Name>:`, so it would leak
// into the body and render as "You".
const VALID_AUTHOR_RE = /^[A-Za-z][\w.-]{0,29}$/;

/** True if `name` is a token the parser will recognise as a `<Name>:` author. */
export function isValidAuthorName(name: string): boolean {
  return VALID_AUTHOR_RE.test(name);
}

// Hue indices match --tc-author-hue-N in styles.css:
//   0 blue, 1 purple, 2 green, 3 orange, 4 pink, 5 teal, 6 yellow, 7 red.
// Indices 4 and 6 are unused by KNOWN_AUTHORS — they remain available for the hash fallback.
const KNOWN_AUTHORS: Record<string, number> = {
  claude: 7,
  gpt: 2,
  "gpt-4": 2,
  "gpt-4o": 2,
  "gpt-5": 2,
  chatgpt: 2,
  openai: 2,
  gemini: 0,
  "gemini-pro": 0,
  bard: 0,
  copilot: 1,
  "github-copilot": 1,
  mistral: 3,
  mixtral: 3,
  llama: 5,
};

export function authorHueIndex(name: string): number {
  const lower = name.toLowerCase();
  const known = KNOWN_AUTHORS[lower];
  if (known !== undefined) return known;
  let h = 0;
  for (let i = 0; i < lower.length; i++) h = (h * 31 + lower.charCodeAt(i)) >>> 0;
  return h % 8;
}
