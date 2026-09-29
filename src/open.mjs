/**
 * Opens the setup page for the person who just started the relay.
 *
 * Preference is a Chromium browser in "app" mode, which gives a clean window
 * with no tabs or address bar, so the tool feels like a small desktop app. If
 * no such browser is found we fall back to whatever normally opens links. A
 * failure here is never fatal: the relay is running either way and the page is
 * one URL away.
 */
import { spawn } from 'node:child_process';
import { log } from './log.mjs';

function launch(command, args) {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false });
      child.on('error', () => resolve(false));
      // A browser that is going to reject the command usually does so at once;
      // if it is still alive after a moment, treat it as launched.
      setTimeout(() => {
        child.unref();
        resolve(true);
      }, 600);
    } catch {
      resolve(false);
    }
  });
}

function candidates(url) {
  const appFlag = `--app=${url}`;
  if (process.platform === 'win32') {
    const programFiles = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(
      Boolean
    );
    const chromium = [
      'Microsoft\\Edge\\Application\\msedge.exe',
      'Google\\Chrome\\Application\\chrome.exe',
    ];
    const paths = [];
    for (const base of programFiles) {
      for (const exe of chromium) paths.push([`${base}\\${exe}`, [appFlag]]);
    }
    // Last resort: whatever the system associates with http.
    paths.push(['cmd', ['/c', 'start', '""', url]]);
    return paths;
  }
  if (process.platform === 'darwin') {
    return [
      ['open', ['-na', 'Google Chrome', '--args', appFlag]],
      ['open', ['-na', 'Microsoft Edge', '--args', appFlag]],
      ['open', [url]],
    ];
  }
  return [
    ['google-chrome', [appFlag]],
    ['chromium', [appFlag]],
    ['chromium-browser', [appFlag]],
    ['xdg-open', [url]],
  ];
}

export async function openUi(url) {
  for (const [command, args] of candidates(url)) {
    if (await launch(command, args)) return true;
  }
  log.warn(`could not open a browser automatically; open ${url} yourself`);
  return false;
}
