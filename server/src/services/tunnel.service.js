const { spawn } = require('child_process');

let activePublicUrl = '';
let tunnelProcess = null;

function getPublicUrl() {
  return activePublicUrl || process.env.PUBLIC_URL || '';
}

function setPublicUrl(url) {
  activePublicUrl = url;
  process.env.PUBLIC_URL = url;
}

function startAutoTunnel(targetPort = 5000) {
  if (process.env.DISABLE_AUTO_TUNNEL === 'true') {
    return;
  }

  if (tunnelProcess) {
    return;
  }

  console.log(`[Tunnel] Launching Cloudflare Tunnel on http://localhost:${targetPort}...`);

  try {
    const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${targetPort}`], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const parseOutput = (chunk) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/i);
      if (match && match[0]) {
        const foundUrl = match[0].trim();
        setPublicUrl(foundUrl);
        console.log(`\n======================================================================`);
        console.log(`\x1b[32m✔ CLOUDFLARE PUBLIC URL READY:\x1b[0m ${foundUrl}`);
        console.log(`Universal Join Link: ${foundUrl}/join?code=XYZ`);
        console.log(`======================================================================\n`);
      }
    };

    tunnel.stdout.on('data', parseOutput);
    tunnel.stderr.on('data', parseOutput);

    tunnel.on('error', (err) => {
      console.warn('[Tunnel] cloudflared launch error:', err.message);
    });

    tunnel.on('close', (code) => {
      console.log(`[Tunnel] cloudflared exited with code ${code}. Reconnecting in 5s...`);
      tunnelProcess = null;
      setTimeout(() => startAutoTunnel(targetPort), 5000);
    });

    tunnelProcess = tunnel;
  } catch (err) {
    console.warn('[Tunnel] Could not launch cloudflared:', err.message);
  }
}

module.exports = {
  startAutoTunnel,
  getPublicUrl,
  setPublicUrl,
};
