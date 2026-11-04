import { escapeHtml, Html } from './html.js';

/**
 * The little Markdown the legal documents use (E-157): headings, paragraphs, lists, tables,
 * bold, links and code. Everything is escaped first; only these constructs become markup.
 */
export function markdown(source: string): Html {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min((heading[1]?.length ?? 1) + 1, 4);
      const text = heading[2] ?? '';
      out.push(`<h${level} id="${anchor(text)}">${inline(text)}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|/.test(lines[index] ?? '')) {
        const cells = (lines[index] ?? '')
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((cell) => cell.trim());
        if (!cells.every((cell) => /^:?-{3,}:?$/.test(cell))) rows.push(cells);
        index += 1;
      }
      const [head, ...body] = rows;
      out.push(
        `<div class="table"><table><thead><tr>${(head ?? []).map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${body
          .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    const bullet = /^\s*(-|\d+\.)\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (index < lines.length && (lines[index] ?? '').trim() !== '') {
        const current = lines[index] ?? '';
        if (bullet.test(current)) items.push(current.replace(bullet, ''));
        else items[items.length - 1] += ` ${current.trim()}`;
        index += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? '').trim() !== '' &&
      !/^(#{1,4})\s/.test(lines[index] ?? '') &&
      !bullet.test(lines[index] ?? '') &&
      !/^\s*\|/.test(lines[index] ?? '')
    ) {
      paragraph.push((lines[index] ?? '').trim());
      index += 1;
    }
    out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
  }
  return new Html(out.join('\n'));
}

function anchor(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/g, '-')
    .replace(/^-|-$/g, '');
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:|\/)[^)\s]*)\)/g, '<a href="$2">$1</a>');
}
