import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const [packed] = JSON.parse(execFileSync(npm, ['pack', '--json'], { encoding: 'utf8' }));

if (!packed?.filename) {
  console.error('local-install: npm pack produced no tarball');
  process.exit(1);
}

try {
  execFileSync(npm, ['install', '-g', packed.filename], { stdio: 'inherit' });
} finally {
  rmSync(packed.filename, { force: true });
}
