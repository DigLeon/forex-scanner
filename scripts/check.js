const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(root)
  .filter(name => name.endsWith('.js'))
  .map(name => path.join(root, name));

let failed = false;

function checkFile(file) {
  const result = spawnSync(process.execPath, ['--check', file], {
    stdio: 'inherit'
  });
  if (result.status !== 0) failed = true;
}

for (const file of files) {
  checkFile(file);
}

// The GUI JavaScript is inline in public/index.html, so check it too.
const htmlPath = path.join(root, 'public', 'index.html');
if (fs.existsSync(htmlPath)) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/i);

  if (!match) {
    console.error('GUI check failed: inline <script> not found in public/index.html');
    failed = true;
  } else {
    const tempFile = path.join(os.tmpdir(), `forex-scanner-ui-${process.pid}.js`);
    try {
      fs.writeFileSync(tempFile, match[1], 'utf8');
      checkFile(tempFile);
    } finally {
      try { fs.unlinkSync(tempFile); } catch (_) {}
    }
  }
}

if (failed) {
  process.exit(1);
}

console.log(`Syntax check passed for ${files.length} server JavaScript files and the GUI script.`);
