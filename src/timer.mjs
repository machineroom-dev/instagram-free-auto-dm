// The local timer: launchd on macOS, cron on Linux, `node cli.mjs poll` every 5 minutes. The paths are the
// ones on your machine at install time; nothing machine-specific lives in the repo.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const LABEL = 'local.instagram-free-auto-dm';
export const CRON_TAG = '# instagram-free-auto-dm';
export const INTERVAL_SEC = 300;

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function plistXml({ nodePath, cliPath, workDir, logPath, intervalSec = INTERVAL_SEC }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xml(nodePath)}</string>
        <string>${xml(cliPath)}</string>
        <string>poll</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(workDir)}</string>
    <key>StartInterval</key>
    <integer>${intervalSec}</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xml(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

export function cronLine({ nodePath, cliPath, workDir, logPath, minutes = INTERVAL_SEC / 60 }) {
  return `*/${minutes} * * * * cd ${sh(workDir)} && ${sh(nodePath)} ${sh(cliPath)} poll >> ${sh(logPath)} 2>&1 ${CRON_TAG}`;
}
export const withoutOurLine = (crontab) => crontab.split('\n').filter((l) => l.trim() && !l.includes(CRON_TAG)).join('\n');
export const withOurLine = (crontab, line) => `${[withoutOurLine(crontab), line].filter(Boolean).join('\n')}\n`;

export function timer(action, { cliPath, workDir, logPath, platform = process.platform, spawn = spawnSync, home = process.env.HOME, uid = process.getuid?.(), nodePath = process.execPath }) {
  const args = { nodePath, cliPath, workDir, logPath };
  if (platform === 'darwin') {
    const plist = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const domain = `gui/${uid}`;
    if (action === 'install') {
      fs.mkdirSync(path.dirname(plist), { recursive: true });
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(plist, plistXml(args));
      spawn('launchctl', ['bootout', `${domain}/${LABEL}`], { encoding: 'utf8' });   // "not loaded" is fine
      const r = spawn('launchctl', ['bootstrap', domain, plist], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`launchctl bootstrap failed: ${(r.stderr || r.stdout || '').trim()}`);
      return `installed ${plist}: runs every ${INTERVAL_SEC / 60} minutes and once now; log at ${logPath}`;
    }
    if (action === 'remove') {
      spawn('launchctl', ['bootout', `${domain}/${LABEL}`], { encoding: 'utf8' });
      try { fs.unlinkSync(plist); } catch { /* not installed */ }
      return `removed ${LABEL}`;
    }
    const r = spawn('launchctl', ['print', `${domain}/${LABEL}`], { encoding: 'utf8' });
    if (r.status !== 0) return 'not installed';
    return (r.stdout || '').split('\n').filter((l) => /state|last exit|run interval|runs/i.test(l)).map((l) => l.trim()).join('\n') || 'installed';
  }
  if (platform === 'linux') {
    const cur = spawn('crontab', ['-l'], { encoding: 'utf8' });
    const existing = cur.status === 0 ? cur.stdout : '';
    if (action === 'show') return existing.split('\n').find((l) => l.includes(CRON_TAG)) ?? 'not installed';
    const next = action === 'install' ? withOurLine(existing, cronLine(args)) : `${withoutOurLine(existing)}\n`;
    if (action === 'install') fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const r = spawn('crontab', ['-'], { input: next.trim() ? next : '', encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`crontab failed: ${(r.stderr || r.stdout || '').trim()}`);
    return action === 'install' ? `installed in your crontab: every ${INTERVAL_SEC / 60} minutes; log at ${logPath}` : 'removed from your crontab';
  }
  throw new Error(`no local timer for ${platform}; use the Cloudflare Worker (SETUP.md, part D2)`);
}
