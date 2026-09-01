/*
 * tools/bundle.js
 * CSS と JS を index.html に埋め込んで、1ファイルだけで動く版を作る。
 *   node tools/bundle.js
 *     dist/sanpo-bingo.html  … そのまま開ける単体HTML（メール添付や共有向け）
 *     dist/artifact.html     … Artifact など、html/head/body を自前で用意する環境向け
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

let html = read('index.html');

// 外部ファイルの読み込みを、中身そのものに置き換える
html = html.replace('<link rel="stylesheet" href="styles.css">', () =>
  '<style>\n' + read('styles.css').trim() + '\n</style>');

html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) =>
  '<script>\n' + read(src).trim() + '\n</script>');

// 単体ファイルでは sw.js / manifest.json / icon.svg が隣にないので外す
html = html
  .replace(/^.*<link rel="manifest"[^>]*>\n/m, '')
  .replace(/^.*<link rel="icon"[^>]*>\n/m, '')
  .replace(/^.*<link rel="apple-touch-icon"[^>]*>\n/m, '')
  .replace('<head>', '<head>\n<script>window.SANPO_SINGLE_FILE = true;</script>');

fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'sanpo-bingo.html'), html);

// Artifact 版は、外側の html/head/body タグを取り除いた中身だけにする
const head = html.slice(html.indexOf('<head>') + 6, html.indexOf('</head>')).trim();
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).trim();
const keep = head.split('\n').filter((line) => !/^<meta /.test(line.trim()));
fs.writeFileSync(path.join(dist, 'artifact.html'), keep.join('\n') + '\n\n' + body + '\n');

const kb = (f) => Math.round(fs.statSync(path.join(dist, f)).size / 1024) + 'KB';
console.log('dist/sanpo-bingo.html', kb('sanpo-bingo.html'));
console.log('dist/artifact.html   ', kb('artifact.html'));
