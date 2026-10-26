#!/usr/bin/env node
/**
 * html2pdf.mjs — Render HTML files or URLs to PDF with the installed
 * Microsoft Edge (fallback: Chrome) over the DevTools Protocol.
 *
 * Zero npm dependencies: needs Node >= 22 (global fetch + WebSocket).
 *
 *   node html2pdf.mjs --input page.html --output page.pdf
 *   node html2pdf.mjs --input .\pages --output .\pdf
 *   node html2pdf.mjs --input https://example.com --output site.pdf
 *
 * Run `node html2pdf.mjs --help` for the full option list.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, stat, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION = '1.0.0';

/* ------------------------------------------------------------------ */
/* paper sizes (mm, portrait)                                          */
/* ------------------------------------------------------------------ */
const FORMATS = {
  A3: [297, 420],
  A4: [210, 297],
  A5: [148, 210],
  A6: [105, 148],
  B5: [176, 250],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6],
  Tabloid: [279.4, 431.8],
  Ledger: [431.8, 279.4],
};

const DEFAULT_BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */
function parseArgs(argv) {
  const o = {
    input: null,
    output: null,
    format: null,
    landscape: false,
    margin: '10mm',
    marginTop: null,
    marginRight: null,
    marginBottom: null,
    marginLeft: null,
    scale: 1,
    background: true,
    preferCssPageSize: null,
    header: null,
    footer: null,
    headerTitle: null,
    title: null,
    cssFile: null,
    css: null,
    wait: 0,
    selector: null,
    timeout: 60000,
    browser: null,
    quiet: false,
    keepOpen: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`option ${a} needs a value`);
      return v;
    };
    const num = (min, max) => {
      const v = Number(next());
      if (!Number.isFinite(v)) fail(`option ${a} needs a number`);
      return Math.min(max, Math.max(min, v));
    };
    switch (a) {
      case '--input': case '-i': o.input = next(); break;
      case '--output': case '-o': o.output = next(); break;
      case '--format': case '-f': o.format = next(); break;
      case '--landscape': case '-l': o.landscape = true; break;
      case '--margin': case '-m': o.margin = next(); break;
      case '--margin-top': o.marginTop = next(); break;
      case '--margin-right': o.marginRight = next(); break;
      case '--margin-bottom': o.marginBottom = next(); break;
      case '--margin-left': o.marginLeft = next(); break;
      case '--scale': o.scale = num(0.1, 2); break;
      case '--no-background': o.background = false; break;
      case '--prefer-css-page-size': o.preferCssPageSize = true; break;
      case '--no-prefer-css-page-size': o.preferCssPageSize = false; break;
      case '--header': o.header = next(); break;
      case '--footer': o.footer = next(); break;
      case '--header-title': o.headerTitle = next(); break;
      case '--title': o.title = next(); break;
      case '--css-file': o.cssFile = next(); break;
      case '--css': o.css = next(); break;
      case '--wait': o.wait = Math.max(0, num(0, 600000)); break;
      case '--selector': o.selector = next(); break;
      case '--timeout': o.timeout = Math.max(1000, num(1000, 600000)); break;
      case '--browser': o.browser = next(); break;
      case '--quiet': case '-q': o.quiet = true; break;
      case '--keep-open': o.keepOpen = true; break;
      case '--help': case '-h': o.help = true; break;
      default: fail(`unknown option ${a} (try --help)`);
    }
  }
  return o;
}

function fail(msg) {
  console.error(`html2pdf: ${msg}`);
  process.exit(2);
}

function usage() {
  return `html2pdf ${VERSION} — HTML/URL -> PDF via Edge or Chrome (DevTools Protocol)

Usage:
  node html2pdf.mjs --input <file.html|dir|https://url> --output <out.pdf|dir> [options]

Input/output:
  A single .html/.htm file makes <out.pdf>. A directory converts every
  .html/.htm inside it (non-recursive) into the output directory. A http(s)
  URL prints the live page. Without --output, PDFs land next to the source.

Page:
  -f, --format <name|WxH>   A3 A4 A5 A6 B5 Letter Legal Tabloid Ledger,
                            or "210x297mm" / "8.5x11in". Default: A4,
                            but CSS @page wins unless you pass --format.
  -l, --landscape           landscape orientation
  -m, --margin <len>        uniform margin, default 10mm ("0", "12mm", "0.5in")
      --margin-top <len>    per-side override (same units)
      --margin-right <len>
      --margin-bottom <len>
      --margin-left <len>
      --scale <n>           content scale 0.1-2, default 1
      --prefer-css-page-size   always honor CSS @page size
      --no-background       do not print background colors/images (default: print)

Look:
      --header <text>       header line; {page} {total} {title} {url} {date}
      --footer <text>       footer line, e.g. "第 {page} / {total} 页"
      --header-title <t>    text for {title} (default: document title)
      --title <t>           PDF metadata title / document title override
      --css "<rules>"       extra CSS injected before printing
      --css-file <file>     extra CSS read from a file

Timing:
      --wait <ms>           extra settle delay after load
      --selector <css>      wait until this element exists
      --timeout <ms>        navigation timeout, default 60000

Engine:
      --browser <exe>       browser executable (default: Edge, then Chrome)
      --keep-open           keep the temp browser profile for debugging
  -q, --quiet               print only the resulting path(s)
  -h, --help                this text

Exit codes: 0 ok, 1 conversion failed, 2 bad usage.
`;
}

/* ------------------------------------------------------------------ */
/* units                                                               */
/* ------------------------------------------------------------------ */
function toInches(value, what = 'length') {
  const m = String(value).trim().match(/^([\d.]+)\s*(mm|cm|in|pt|px)?$/i);
  if (!m) fail(`cannot parse ${what} "${value}"`);
  const n = Number(m[1]);
  const unit = (m[2] || 'mm').toLowerCase();
  return n / { mm: 25.4, cm: 2.54, in: 1, pt: 72, px: 96 }[unit];
}

function parseFormat(name) {
  if (!name) return null;
  const key = Object.keys(FORMATS).find((k) => k.toLowerCase() === String(name).toLowerCase());
  if (key) return FORMATS[key];
  const m = String(name).trim().match(/^([\d.]+)\s*x\s*([\d.]+)\s*(mm|cm|in|pt)?$/i);
  if (!m) fail(`unknown format "${name}" (try A4, Letter, or 210x297mm)`);
  const unit = m[3] || 'mm';
  return [toInches(`${m[1]}${unit}`) * 25.4, toInches(`${m[2]}${unit}`) * 25.4];
}

/* ------------------------------------------------------------------ */
/* CDP plumbing                                                        */
/* ------------------------------------------------------------------ */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('browser connection closed'));
      this.pending.clear();
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const fn of (this.handlers.get(msg.method) || []).slice()) fn(msg.params);
    }
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('browser connection closed'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevToolsPort(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const txt = (await readFile(file, 'utf8')).trim();
      if (txt) return txt.split(/\r?\n/)[0].trim();
    }
    await sleep(100);
  }
  throw new Error('browser did not expose a DevTools port in time');
}

function pickBrowser(explicit) {
  const cands = explicit ? [explicit] : [process.env.HTML2PDF_BROWSER, ...DEFAULT_BROWSERS].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  throw new Error(`no browser found (tried: ${cands.join(', ')}) — pass --browser`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildTemplate(kind, text, titleOverride = null) {
  const html = String(text)
    .split(/(\{(?:page|total|title|url|date)\})/g)
    .map((t) => {
      switch (t) {
        case '{page}': return '<span class="pageNumber"></span>';
        case '{total}': return '<span class="totalPages"></span>';
        case '{title}': return titleOverride ? escapeHtml(titleOverride) : '<span class="title"></span>';
        case '{url}': return '<span class="url"></span>';
        case '{date}': return '<span class="date"></span>';
        default: return escapeHtml(t);
      }
    })
    .join('');
  // Chromium renders headers/footers in a separate document that ignores inherited
  // font-family, so the family (and size/colour) must be forced from inside a <style>.
  // Open-source families first: never silently embed a commercial font subset.
  const skin =
    'width:100%;box-sizing:border-box;padding:0 10mm;color:#666;font-size:8px;' +
    'font-family:"Noto Sans SC Static","Noto Sans SC","Source Han Sans SC",sans-serif;';
  const align = kind === 'header' ? 'text-align:right;' : 'text-align:center;';
  return (
    '<style>html,body{margin:0;padding:0;background:transparent}'
    + `.hf{${skin}${align}}</style>`
    + `<div class="hf">${html}</div>`
  );
}

/* ------------------------------------------------------------------ */
/* browser session                                                     */
/* ------------------------------------------------------------------ */
async function startBrowser(browserPath) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'html2pdf-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter',
    '--allow-file-access-from-files',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    'about:blank',
  ];
  const proc = spawn(browserPath, args, { stdio: 'ignore', windowsHide: true });
  const port = await waitForDevToolsPort(path.join(profile, 'DevToolsActivePort'), 20000);
  if (!/^\d+$/.test(port)) throw new Error(`unexpected DevTools port "${port}"`);

  const deadline = Date.now() + 20000;
  let target = null;
  while (!target && Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && !/^devtools:/.test(t.url));
    } catch { /* still starting */ }
    if (!target) await sleep(100);
  }
  if (!target) throw new Error('browser started but exposed no page target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('CDP handshake timeout')), 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error('CDP handshake failed')); }, { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setEmulatedMedia', { media: 'print' });

  return {
    cdp,
    async close(keepOpen = false) {
      try { ws.close(); } catch {}
      try { proc.kill(); } catch {}
      if (keepOpen) {
        console.error(`html2pdf: profile kept at ${profile}`);
        return;
      }
      for (let i = 0; i < 20; i++) {
        try { await rm(profile, { recursive: true, force: true }); break; } catch { await sleep(150); }
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* one job                                                             */
/* ------------------------------------------------------------------ */
async function renderJob(session, job, opt, geom, injectedCss) {
  const { cdp } = session;
  let loaded = false;
  const onLoad = () => { loaded = true; };
  cdp.on('Page.loadEventFired', onLoad);

  const deadline = Date.now() + opt.timeout;
  const nav = await cdp.send('Page.navigate', { url: job.url });
  if (nav.errorText && !/ERR_ABORTED/.test(nav.errorText)) {
    throw new Error(`navigation failed: ${nav.errorText}`);
  }
  while (!loaded && Date.now() < deadline) await sleep(30);
  if (!loaded) throw new Error(`page load timed out after ${opt.timeout}ms`);

  await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      try { await document.fonts.ready; } catch (e) {}
      const imgs = Array.from(document.images).filter(i => !i.complete);
      await Promise.all(imgs.map(i => new Promise(r => {
        i.addEventListener('load', r, { once: true });
        i.addEventListener('error', r, { once: true });
        setTimeout(r, 10000);
      })));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return true;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  if (opt.selector) {
    const sel = JSON.stringify(opt.selector);
    let found = false;
    while (!found && Date.now() < deadline) {
      const r = await cdp.send('Runtime.evaluate', { expression: `!!document.querySelector(${sel})`, returnByValue: true });
      found = !!r.result?.value;
      if (!found) await sleep(100);
    }
    if (!found) throw new Error(`selector not found: ${opt.selector}`);
  }

  if (opt.title) {
    await cdp.send('Runtime.evaluate', {
      expression: `document.title = ${JSON.stringify(opt.title)}; true`,
      returnByValue: true,
    });
  }

  if (injectedCss) {
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const s = document.createElement('style');
        s.textContent = ${JSON.stringify(injectedCss)};
        document.head.appendChild(s);
        return true;
      })()`,
      returnByValue: true,
    });
  }

  if (opt.wait > 0) await sleep(opt.wait);

  const printed = await cdp.send('Page.printToPDF', {
    printBackground: !!opt.background,
    preferCSSPageSize: !!geom.useCssSize,
    paperWidth: geom.paperWidth,
    paperHeight: geom.paperHeight,
    marginTop: geom.margins.top,
    marginBottom: geom.margins.bottom,
    marginLeft: geom.margins.left,
    marginRight: geom.margins.right,
    scale: opt.scale,
    landscape: !!opt.landscape,
    displayHeaderFooter: Boolean(opt.header || opt.footer),
    headerTemplate: opt.header ? buildTemplate('header', opt.header, opt.headerTitle) : '<div></div>',
    footerTemplate: opt.footer ? buildTemplate('footer', opt.footer, opt.headerTitle) : '<div></div>',
    transferMode: 'ReturnAsBase64',
    pageRanges: '',
  });
  if (!printed?.data) throw new Error('printToPDF returned no data');

  const buf = Buffer.from(printed.data, 'base64');
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('output is not a PDF (bad signature)');
  if (buf.length < 1024) throw new Error(`output suspiciously small (${buf.length} bytes)`);

  await mkdir(path.dirname(job.out), { recursive: true });
  await writeFile(job.out, buf);

  const pages = (buf.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g) || []).length;
  return { pages, bytes: buf.length };
}

/* ------------------------------------------------------------------ */
/* jobs                                                                */
/* ------------------------------------------------------------------ */
const HTML_RE = /\.(html?|xhtml)$/i;

async function collectJobs(opt) {
  const raw = opt.input;
  if (/^https?:\/\//i.test(raw)) {
    const out = path.resolve(opt.output || 'page.pdf');
    return [{ label: raw, url: raw, out: /\.pdf$/i.test(out) ? out : `${out}.pdf` }];
  }

  const abs = path.resolve(raw);
  if (!existsSync(abs)) throw new Error(`input not found: ${abs}`);

  const st = await stat(abs);
  if (st.isDirectory()) {
    const files = (await readdir(abs, { withFileTypes: true }))
      .filter((d) => d.isFile() && HTML_RE.test(d.name))
      .map((d) => path.join(abs, d.name))
      .sort();
    if (!files.length) throw new Error(`no .html/.htm files in ${abs}`);
    const outDir = path.resolve(opt.output || abs);
    return files.map((f) => ({
      label: f,
      url: pathToFileURL(f).href,
      out: path.join(outDir, path.basename(f).replace(HTML_RE, '.pdf')),
    }));
  }

  if (!HTML_RE.test(abs)) throw new Error(`not an HTML file: ${abs}`);
  const out = path.resolve(opt.output || abs.replace(HTML_RE, '.pdf'));
  const outFile = /\.pdf$/i.test(out) ? out : `${out}.pdf`;
  return [{ label: abs, url: pathToFileURL(abs).href, out: outFile }];
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */
async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (!opt.input) fail('--input is required');

  const fmt = parseFormat(opt.format);
  const useCssSize = opt.preferCssPageSize !== null ? opt.preferCssPageSize : !fmt;
  // Page geometry stays in the declared (portrait) orientation; Chromium rotates
  // the sheet itself when `landscape` is set, so swapping here would rotate twice.
  const [wmm, hmm] = fmt || FORMATS.A4;
  const displayW = opt.landscape ? Math.max(wmm, hmm) : wmm;
  const displayH = opt.landscape ? Math.min(wmm, hmm) : hmm;

  const marginsSrc = {
    top: opt.marginTop ?? opt.margin,
    right: opt.marginRight ?? opt.margin,
    bottom: opt.marginBottom ?? opt.margin,
    left: opt.marginLeft ?? opt.margin,
  };
  if (opt.header && opt.marginTop === null && toInches(marginsSrc.top) * 25.4 < 15) marginsSrc.top = '15mm';
  if (opt.footer && opt.marginBottom === null && toInches(marginsSrc.bottom) * 25.4 < 15) marginsSrc.bottom = '15mm';

  const geom = {
    useCssSize,
    paperWidth: wmm / 25.4,
    paperHeight: hmm / 25.4,
    margins: {
      top: toInches(marginsSrc.top),
      right: toInches(marginsSrc.right),
      bottom: toInches(marginsSrc.bottom),
      left: toInches(marginsSrc.left),
    },
  };

  let injectedCss = '';
  // A document that declares `@page { size: ... }` keeps that size/orientation even
  // when preferCSSPageSize is false, so an explicit --format/--landscape needs a
  // matching @page rule to actually take effect. User-supplied CSS is appended after
  // this rule, so `--css "@page{...}"` can still win.
  if (!useCssSize) {
    injectedCss += `@page { size: ${displayW}mm ${displayH}mm; margin: ${marginsSrc.top} ${marginsSrc.right} ${marginsSrc.bottom} ${marginsSrc.left}; }\n`;
  }
  if (opt.cssFile) {
    const f = path.resolve(opt.cssFile);
    if (!existsSync(f)) throw new Error(`css file not found: ${f}`);
    injectedCss += await readFile(f, 'utf8');
  }
  if (opt.css) injectedCss += '\n' + opt.css;

  const jobs = await collectJobs(opt);
  const browser = pickBrowser(opt.browser);
  const t0 = Date.now();
  const session = await startBrowser(browser);
  const results = [];
  try {
    for (const job of jobs) {
      try {
        const info = await renderJob(session, job, opt, geom, injectedCss);
        results.push({ ok: true, ...job, ...info });
      } catch (err) {
        results.push({ ok: false, ...job, error: err.message });
      }
    }
  } finally {
    await session.close(opt.keepOpen);
  }

  const failed = results.filter((r) => !r.ok);
  const okList = results.filter((r) => r.ok);

  if (opt.quiet) {
    for (const r of okList) console.log(r.out);
    for (const r of failed) console.error(`FAILED ${r.label}: ${r.error}`);
  } else {
    const size = `${Math.round(displayW)}x${Math.round(displayH)}mm`;
    for (const r of results) {
      if (!r.ok) {
        console.log(`FAIL  : ${r.label}\n        原因: ${r.error}`);
      } else if (results.length === 1) {
        console.log(`PDF  : ${r.out}`);
        console.log(`源   : ${r.label}`);
        console.log(`页面 : ${r.pages} 页 · ${(r.bytes / 1024).toFixed(1)} KB · ${geom.useCssSize ? 'CSS @page' : size}${opt.landscape ? ' 横向' : ''}`);
      } else {
        console.log(`OK    : ${path.basename(r.out)} · ${r.pages}p · ${(r.bytes / 1024).toFixed(0)} KB`);
      }
    }
    if (results.length > 1) console.log(`合计 : ${okList.length} 成功 / ${failed.length} 失败`);
    if (okList.length) console.log(`耗时 : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  return failed.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error(`html2pdf: ${err.message}`);
    process.exit(1);
  });
