/** Markup that is already safe, e.g. from the `html` tag. */
export class Html {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

export const escapeHtml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

type Part = Html | string | number | null | undefined | false | Part[];

const render = (part: Part): string =>
  part === null || part === undefined || part === false
    ? ''
    : Array.isArray(part)
      ? part.map(render).join('')
      : part instanceof Html
        ? part.value
        : escapeHtml(String(part));

/** Template literal that escapes every value unless it is Html. */
export function html(strings: TemplateStringsArray, ...values: Part[]): Html {
  return new Html(strings.reduce((out, text, index) => out + text + render(values[index]), ''));
}

const STYLE = `
:root { --ink:#1d1d1f; --muted:#5f6368; --accent:#4f46e5; --border:#dadce0; --surface:#fff;
  --page:#f6f7f9; --danger:#b0402e; --ok:#1e7d4f; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --ink:#ececf1; --muted:#a0a3ab; --accent:#8b85ff;
  --border:#3a3d45; --surface:#1f2126; --page:#15171a; --danger:#ff8b7a; --ok:#5fd39b; } }
* { box-sizing: border-box; }
body { margin:0; font:15px/1.5 system-ui, sans-serif; color:var(--ink); background:var(--page); }
main { max-width: 560px; margin: 48px auto; padding: 0 16px; }
.card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:24px; }
h1 { font-size:24px; margin:0 0 8px; letter-spacing:-0.01em; }
h2 { font-size:17px; margin:24px 0 8px; }
p { margin:0 0 12px; } .muted { color:var(--muted); font-size:13px; }
label { display:block; font-size:13px; font-weight:600; margin:14px 0 4px; }
input[type=text], input[type=email] { width:100%; height:36px; padding:0 10px; font:inherit;
  color:inherit; background:var(--surface); border:1px solid var(--border); border-radius:6px; }
button { margin-top:18px; height:36px; padding:0 14px; font:inherit; font-weight:600;
  color:#fff; background:var(--accent); border:0; border-radius:6px; cursor:pointer; }
button.secondary { color:var(--ink); background:transparent; border:1px solid var(--border); }
button.danger { color:var(--danger); background:transparent; border:1px solid var(--danger); }
.error { color:var(--danger); } .ok { color:var(--ok); }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.suffix { color:var(--muted); white-space:nowrap; }
a { color:var(--accent); } code { font-size:13px; }
main.wide { max-width: 760px; }
.check { display:flex; gap:8px; align-items:flex-start; font-weight:400; font-size:14px; margin:12px 0 0; }
.check input { margin-top:4px; }
.doc h2 { font-size:18px; margin:28px 0 8px; } .doc h3 { font-size:15px; margin:20px 0 6px; }
.doc ol, .doc ul { padding-left:22px; margin:0 0 12px; } .doc li { margin:0 0 6px; }
.table { overflow-x:auto; margin:0 0 12px; }
table { border-collapse:collapse; font-size:13px; width:100%; }
th, td { text-align:left; vertical-align:top; padding:6px 8px; border-bottom:1px solid var(--border); }
footer { margin:24px 0 0; display:flex; gap:16px; flex-wrap:wrap; font-size:13px; }
footer a { color:var(--muted); }
`;

const FOOTER = `<footer><a href="/impressum">Impressum</a><a href="/datenschutz">Datenschutz</a><a href="/agb">AGB</a><a href="/rechtliches">Rechtliches</a></footer>`;

/** A whole page; `refresh` reloads it after that many seconds, `wide` suits long texts. */
export function page(title: string, body: Html, refresh?: number, wide = false): string {
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${
    refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''
  }
<title>${escapeHtml(title)} · Lenipo Cloud</title><style>${STYLE}</style></head>
<body><main${wide ? ' class="wide"' : ''}>${body.value}${FOOTER}</main></body></html>`;
}
