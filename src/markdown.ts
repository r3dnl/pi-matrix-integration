/* eslint-disable no-control-regex -- U+0000 is the code-span placeholder
 * sentinel in this converter (NUL cannot occur in Matrix event text, so it
 * is safe as an internal marker); every flagged regex is that sentinel. */
/**
 * Pi Matrix Integration — outgoing Markdown → HTML converter.
 *
 * Element Web does not parse markdown in `body`: the Matrix protocol has no
 * native markdown message type, so literal `**bold**` / backticks / table
 * pipes show up as plain text. The only rendering path Element implements is
 * `format: "org.matrix.custom.html"` + `formatted_body` (see
 * a planned improvement). With `sendFormatted`
 * on, the extension therefore sends both fields:
 *
 *   { "msgtype": "m.text", "body": <original markdown>,
 *     "format": "org.matrix.custom.html", "formatted_body": <this output> }
 *
 * The plain `body` is kept as the fallback for non-HTML clients (and shows
 * the raw, still-readable text where a client strips unsupported constructs).
 *
 * The converter is minimal and dependency-free on purpose: Pi's jiti loader
 * only aliases `@earendil-works/*` + `typebox`, so `import "marked"` would
 * fail at runtime inside Pi. It emits only the restricted tag subset
 * Element's sanitizer keeps (headings, p, strong, em, code, pre, a,
 * ul/ol/li, blockquote, br) plus table/th/td using the md2htmx reference
 * styling — table rendering is client-dependent; where a client
 * strips tables, the plain `body` fallback keeps the content readable.
 * Inline code spans ship as `<font color="#3385ff">` around the <code> —
 * see INLINE_CODE_STYLE; where a client strips the tag the span still
 * renders as plain <code>.
 * Element's sanitizer drops inline style on <code> but keeps the legacy
 * `<font color>` tag (the ask-user-mirror's green decision numbers prove
 * it renders in the room) — so the color wraps the span, not the element.
 *
 * Safety: the raw text is HTML-escaped *first*; markdown transforms run on
 * the escaped text, so LLM/user text cannot inject `<script>` or raw
 * entities. Per the addendum's gotcha, block output never contains a
 * trailing newline inside `<p>` or nested block elements.
 *
 * Table styling after md2htmx (CC-BY-SA), github.com/pflegende/2konsolidate
 * — styling reference only; the converter code is written from scratch.
 */

/** A markdown table block found during conversion. */
export interface TableBlock {
  /** The table's HTML (with the md2htmx reference styling). */
  html: string;
  /** The original markdown lines of the table — its plain-text fallback. */
  source: string;
  /** 0-based index of the table's first line in the normalized input. */
  lineStart: number;
  /** 0-based index of the table's last line (inclusive). */
  lineEnd: number;
}

/** Result of converting a markdown string to the restricted HTML subset. */
export interface MarkdownConversion {
  /** Full conversion, tables inlined at their original positions. */
  html: string;
  /** Conversion with table blocks removed (for sending tables separately). */
  htmlWithoutTables: string;
  /** Table blocks found, in document order. */
  tables: TableBlock[];
}

export const CELL_STYLE = 'style="padding:8px"';
export const TABLE_OPEN = '<table border="1" style="border-collapse:collapse; width:100%">';

/** Escape raw text before any markdown transformation runs. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Heuristic for "content is already HTML, ship it as-is": the text starts
 * with an opening tag (a `label: ` message prefix such as `🎯 Milestone: `
 * is tolerated) and contains a closing or self-closing tag. Documented
 * false-positive boundary: markdown that carries a literal `<x>…</x>` pair
 * after a label passes through unconverted.
 */
export function looksLikeHtml(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!/^(?:[^<>]*: )?<[a-z]/i.test(t)) return false;
  return /<\/[a-z][a-z0-9]*>|<[a-z][a-z0-9]*(?:\s[^<>]*)?\/>/i.test(t);
}

/** Inline code span color: blue (#3385ff, Element's accent) so the room
 * distinguishes `inline code` from prose. Shipped as `<font color>` around
 * the <code> — Element strips inline `style` on <code> (confirmed live in
 * the room) but honors the legacy font tag, same mechanism as the
 * ask-user-mirror's colored table cells. */
export const INLINE_CODE_STYLE = '#3385ff';

/** Session/meta code span color: muted grey, de-emphasized. Same
 * `<font color>` + `<code>` mechanism as the blue inline code above —
 * used for the extension's lone-code-span meta line (the pi session id). */
export const GREY_CODE_STYLE = '#8a8a8a';

/**
 * Plain-text fallback for an as-is HTML payload: strip tags, restore
 * block/line breaks, decode the common entities. Whitespace runs are kept
 * so `<pre>` code blocks read correctly; the `label: ` prefix survives.
 */
export function stripHtmlTags(html: string): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|pre|blockquote|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Inline markdown on already-escaped text: code spans, links, bold, italic.
 * Code spans are protected from the other transforms via placeholders, so
 * `**` inside backticks stays literal.
 */
export function applyInlineMarkdown(text: string): string {
  const codeSpans: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(`<font color="${INLINE_CODE_STYLE}"><code>${code}</code></font>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  s = s
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
      // url is already escaped; keep the href clean regardless.
      const safeUrl = url.replace(/"/g, "&quot;");
      return `<a href="${safeUrl}">${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    // `_em_` only at word boundaries — `snake_case` identifiers stay literal
    .replace(/(^|[^\w])_([^_\s][^_]*)_(?=[^\w]|$)/g, (_m, pre: string, inner: string) => `${pre}<em>${inner}</em>`)
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codeSpans[Number(i)] ?? "");
  return s;
}

// ---- GFM table detection ----------------------------------------------------

function isTableRowLine(line: string): boolean {
  return line.trim().includes("|");
}

function isTableSeparatorLine(line: string): boolean {
  let t = line.trim();
  if (t === "") return false;
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  const cells = t.split("|").map((c) => c.trim());
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/** A table starts at `i` when line i is a row and line i+1 is the `---` separator. */
function isTableStart(lines: string[], i: number): boolean {
  return (
    isTableRowLine(lines[i]) && i + 1 < lines.length && isTableSeparatorLine(lines[i + 1])
  );
}

function parseTableCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

function renderTableBlock(lines: string[], start: number, end: number): string {
  const header = parseTableCells(lines[start]);
  const headerCells = header.map((c) => `<th ${CELL_STYLE}>${applyInlineMarkdown(escapeHtml(c))}</th>`).join("");
  const bodyRows: string[] = [];
  for (let r = start + 2; r <= end; r++) {
    const cells = parseTableCells(lines[r])
      .map((c) => `<td ${CELL_STYLE}>${applyInlineMarkdown(escapeHtml(c))}</td>`)
      .join("");
    bodyRows.push(`<tr>${cells}</tr>`);
  }
  return `${TABLE_OPEN}<tr>${headerCells}</tr>${bodyRows.join("")}</table>`;
}

// ---- Block-level rendering ----------------------------------------------------

function renderFencedCode(blockLines: string[], lang?: string): string {
  // No trailing newline inside <pre>: it collapses oddly through the sanitizer.
  // Element's own editor tags fenced blocks with a language hint
  // (class="language-ts") — that's what enables syntax highlighting in the
  // room. The hint is restricted to a safe character set (attribute value).
  const cls = lang && /^[a-z0-9+#-]+$/i.test(lang) ? ` class="language-${lang}"` : "";
  return `<pre><code${cls}>${blockLines.map(escapeHtml).join("\n")}</code></pre>`;
}

function renderList(items: string[], ordered: boolean): string {
  const tag = ordered ? "ol" : "ul";
  const lis = items.map((item) => `<li>${applyInlineMarkdown(escapeHtml(item))}</li>`).join("");
  return `<${tag}>${lis}</${tag}>`;
}

function renderParagraph(lines: string[]): string {
  // Author line breaks become <br> (safe inside <p>); blocks stay flat,
  // no nested block elements or trailing newlines.
  const inner = lines.map((l) => applyInlineMarkdown(escapeHtml(l.trim()))).join("<br>");
  return `<p>${inner}</p>`;
}

/** A line that is exactly one inline code span (`` `…` ``) with nothing else.
 * The extension emits its meta line (the pi session id) this way; the
 * formatter renders it as a de-emphasized (grey) code span in its own block. */
export function isLoneInlineCodeSpan(line: string): boolean {
  return /^`[^`]+`$/.test(line.trim());
}

/**
 * Convert a markdown string to the restricted HTML subset Element renders.
 * Supports: headings (#..######), bold/italic, inline code, fenced code
 * blocks, unordered/ordered lists, links, blockquotes, and GFM pipe
 * tables (header + `---` separator + body rows, optional leading/trailing
 * pipes). Everything is escaped first; only the listed tag set is emitted.
 */
export function convertMarkdown(markdown: string): MarkdownConversion {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const withTables: string[] = [];
  const withoutTables: string[] = [];
  const tables: TableBlock[] = [];

  const push = (full: string, without?: string) => {
    withTables.push(full);
    withoutTables.push(without ?? full);
  };

  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (trimmed === "") {
      i++;
      continue;
    }

    // Fenced code block: the opening-fence language hint (```ts) becomes
    // class="language-ts" on <code> so Element can syntax-highlight.
    if (trimmed.startsWith("```")) {
      const lang = trimmed.slice(3).trim().split(/\s+/)[0];
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip the closing fence (or run past EOF)
      push(renderFencedCode(buf, lang));
      continue;
    }

    // GFM table: header row + `---` separator + consecutive body rows
    if (isTableStart(lines, i)) {
      let end = i + 1;
      while (end + 1 < lines.length && isTableRowLine(lines[end + 1])) {
        end++;
      }
      const html = renderTableBlock(lines, i, end);
      tables.push({
        html,
        source: lines.slice(i, end + 1).join("\n"),
        lineStart: i,
        lineEnd: end,
      });
      push(html, ""); // tables are omitted from the no-tables version
      i = end + 1;
      continue;
    }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      push(`<h${level}>${applyInlineMarkdown(escapeHtml(heading[2].trim()))}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        buf.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      const inner = buf.map((l) => applyInlineMarkdown(escapeHtml(l))).join("<br>");
      push(`<blockquote>${inner}</blockquote>`);
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i++;
      }
      push(renderList(items, false));
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i++;
      }
      push(renderList(items, true));
      continue;
    }

    // Meta line: a lone inline code span (the extension's pi session id) —
    // rendered as a de-emphasized (grey) code span, its own block.
    if (isLoneInlineCodeSpan(trimmed)) {
      push(`<p><font color="${GREY_CODE_STYLE}"><code>${escapeHtml(trimmed.slice(1, -1))}</code></font></p>`);
      i++;
      continue;
    }

    // Paragraph: consecutive plain lines up to a blank line or block start
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trim().startsWith("```") &&
      !lines[i].trim().startsWith(">") &&
      !/^[-*]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim()) &&
      !/^#{1,6}\s/.test(lines[i].trim()) &&
      !isTableStart(lines, i) &&
      !isLoneInlineCodeSpan(lines[i].trim())
    ) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length > 0) {
      push(renderParagraph(buf));
    }
  }

  return {
    html: withTables.join(""),
    htmlWithoutTables: withoutTables.join(""),
    tables,
  };
}

// ---- Incoming HTML → markdown -------------------------------------------------

/** Decode the entity set `escapeHtml` writes (and the sanitizer emits). */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // last: `&amp;lt;` decodes to the literal `&lt;`
}

/** Inline-level HTML → markdown: code spans, emphasis, links, stray tags. */
function htmlInlineToMarkdown(s: string): string {
  const codes: string[] = [];
  let t = s.replace(/<code(?:\s[^>]*)?>([\s\S]*?)<\/code>/gi, (_m, code: string) => {
    codes.push(`\`${decodeEntities(code).replace(/\s+/g, ' ')}\``);
    return `\u0000C${codes.length - 1}\u0000`;
  });
  t = t
    .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, (_m, _tag: string, inner: string) => `*${inner}*`)
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, (_m, _tag: string, inner: string) => `**${inner}**`)
    .replace(
      /<a href="([^"]*)">([\s\S]*?)<\/a>/gi,
      (_m, url: string, label: string) => `[${label.trim()}](${decodeEntities(url)})`,
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  t = decodeEntities(t);
  return t.replace(/\u0000C(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? '');
}

/**
 * Inverse of `convertMarkdown` for incoming `formatted_body` payloads:
 * HTML → markdown. The Pi session is markdown-native, so injecting the raw
 * HTML costs tokens and reads worse in the terminal. Handles the restricted
 * subset Element emits (p/br, h1-h6, ul/ol/li, blockquote, strong/b,
 * em/i, inline + fenced code, links, tables); unknown tags are stripped
 * and entities decoded, so richer client HTML degrades to readable text.
 * Ceiling: nested lists and colspan/rowspan cells flatten (documented).
 */
export function htmlToMarkdown(html: string): string {
  let s = String(html ?? '');
  const blocks: string[] = [];
  const stash = (md: string): string => {
    blocks.push(md);
    return `\u0000B${blocks.length - 1}\u0000`;
  };

  // Fenced code blocks → ``` fences (the HTML content is entity-escaped).
  s = s.replace(
    /<pre>\s*<code(\s+class="language-([a-z0-9+#-]+)")?>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_m, _cls: string, lang: string, code: string) =>
      stash(`\n\n\`\`\`${lang ?? ''}\n${decodeEntities(code).replace(/[\s]+$/, '')}\n\`\`\`\n\n`),
  );

  // Tables → GFM pipe tables (first row + th present → `| --- |` separator).
  s = s.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_m, inner: string) => {
    const rows = [...inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
      [...row[1].matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)]
        .map((cell) => htmlInlineToMarkdown(cell[1]).replace(/\s+$/, ''))
        .filter((cell) => cell !== ''),
    ).filter((cells) => cells.length > 0);
    if (rows.length === 0) return '';
    const pipe = (cells: string[]) => `| ${cells.join(' | ')} |`;
    const lines = [pipe(rows[0])];
    if (/<th[\s>]/.test(inner)) lines.push('|' + rows[0].map(() => ' --- |').join(''));
    for (const cells of rows.slice(1)) lines.push(pipe(cells));
    return stash(`\n\n${lines.join('\n')}\n\n`);
  });

  // Lists → `- ` / `1. ` lines.
  s = s.replace(/<(ul|ol)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, tag: string, inner: string) => {
    const items = [...inner.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)];
    if (items.length === 0) return '';
    const lines = items.map((item, n) =>
      `${tag === 'ol' ? `${n + 1}. ` : '- '}${htmlInlineToMarkdown(item[1]).replace(/\s+$/, '')}`,
    );
    return stash(`\n\n${lines.join('\n')}\n\n`);
  });

  // Headings.
  s = s.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_m, lvl: string, inner: string) =>
      stash(`\n\n${'#'.repeat(Number(lvl))} ${htmlInlineToMarkdown(inner).replace(/\s+$/, '')}\n\n`),
  );

  // Blockquotes: `> ` per line.
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) => {
    const md = inner
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*(?=<p)/g, '\n')
      .replace(/<[^>]+>/g, '');
    return stash(
      `\n\n${decodeEntities(md)
        .split('\n')
        .map((line) => (line.trim() === '' ? '' : `> ${line.replace(/^\s+/, '')}`))
        .join('\n')}\n\n`,
    );
  });

  // Paragraphs: <p>/<br> become line structure; inline code, emphasis and
  // links; then strip any tags we don't convert and decode entities.
  const codes: string[] = [];
  s = s
    .replace(/<code(?:\s[^>]*)?>([\s\S]*?)<\/code>/gi, (_m, code: string) => {
      codes.push(`\`${decodeEntities(code).replace(/\s+/g, ' ')}\``);
      return `\u0000C${codes.length - 1}\u0000`;
    })
    .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, (_m, _tag: string, inner: string) => `*${inner}*`)
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, (_m, _tag: string, inner: string) => `**${inner}**`)
    .replace(
      /<a href="([^"]*)">([\s\S]*?)<\/a>/gi,
      (_m, url: string, label: string) => `[${label.trim()}](${decodeEntities(url)})`,
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ');
  s = decodeEntities(s);
  s = s
    .replace(/\u0000B(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)] ?? '')
    .replace(/\u0000C(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Remove table blocks from the original markdown (line ranges come from
 * `convertMarkdown`). Used as the plain-text `body` when tables are sent in
 * separate messages (`tablesInSeparateMessage`).
 */
export function removeTableBlocks(markdown: string, tables: TableBlock[]): string {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const drop = new Set<number>();
  for (const table of tables) {
    for (let n = table.lineStart; n <= table.lineEnd; n++) {
      drop.add(n);
    }
  }
  return lines.filter((_, n) => !drop.has(n)).join("\n").trim();
}
