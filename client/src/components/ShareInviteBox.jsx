import { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { apiRequest } from '../services/api';

function ShareInviteBox({ groupName = 'Riding Group', inviteCode, expiresAt, onDone }) {
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [qrGenerating, setQrGenerating] = useState(false);
  const [networkInfo, setNetworkInfo] = useState(null);

  // Poll host network info from backend to get the live public URL
  useEffect(() => {
    let isMounted = true;
    function fetchNetwork() {
      apiRequest('/health/network')
        .then((data) => {
          if (!isMounted || !data) return;
          setNetworkInfo(data);
        })
        .catch(() => {});
    }

    fetchNetwork();
    const interval = setInterval(fetchNetwork, 4000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const isLocalhost =
    currentOrigin.includes('localhost') || currentOrigin.includes('127.0.0.1');

  // Single Universal Origin Resolution:
  // 1. If backend has a live public tunnel URL (e.g. Pinggy/Cloudflare), use it as the universal link!
  // 2. If client is already visiting through a public URL or LAN IP, use that!
  // 3. If on localhost, use primary LAN IP (e.g. https://172.21.22.32:5173) so phones on Wi-Fi work immediately.
  const port = typeof window !== 'undefined' ? window.location.port : '5173';
  const protocol = typeof window !== 'undefined' ? window.location.protocol : 'https:';
  const primaryLanIp = networkInfo?.primaryLanIp || '127.0.0.1';
  const lanOrigin = `${protocol}//${primaryLanIp}${port ? `:${port}` : ''}`;

  let universalOrigin = currentOrigin;
  if (networkInfo?.publicUrl) {
    universalOrigin = networkInfo.publicUrl;
  } else if (isLocalhost && primaryLanIp && primaryLanIp !== '127.0.0.1') {
    universalOrigin = lanOrigin;
  }

  const inviteUrl = `${universalOrigin.replace(/\/$/, '')}/join?code=${inviteCode}`;
  const shareText = `🏍️ Join our riding group "${groupName}" on GROUP-LOCK!\nTap the link to join directly from any phone: ${inviteUrl}\n\nInvite Code: ${inviteCode}`;

  // Stage 7/Invite: Offline instant QR code generation via QRCode library
  useEffect(() => {
    let isMounted = true;
    setQrGenerating(true);

    QRCode.toDataURL(inviteUrl, {
      width: 280,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#020617', light: '#ffffff' },
    })
      .then((url) => {
        if (isMounted) {
          setQrDataUrl(url);
          setQrGenerating(false);
        }
      })
      .catch((err) => {
        console.warn('[ShareInviteBox] Local QR generation fallback:', err);
        if (isMounted) {
          setQrDataUrl(`https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(inviteUrl)}`);
          setQrGenerating(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [inviteUrl]);

  function handleCopyLink() {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(inviteUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    }
  }

  function handleCopyCode() {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(inviteCode);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2500);
    }
  }

  function handleWhatsAppShare() {
    const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(shareText)}`;
    window.open(waUrl, '_blank', 'noopener,noreferrer');
  }

  async function handleNativeShare() {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `Join ${groupName} on GROUP-LOCK`,
          text: `Join our riding group "${groupName}" on GROUP-LOCK!`,
          url: inviteUrl,
        });
      } catch (err) {
        // User cancelled
      }
    } else {
      handleCopyLink();
    }
  }

  return (
    <div className="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 border border-slate-700 rounded-2xl p-5 sm:p-6 text-white shadow-2xl space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-xl">
            🔗
          </div>
          <div>
            <h4 className="text-base font-bold text-white tracking-tight">Invite Riders to Group</h4>
            <p className="text-xs text-slate-400">Anyone on any phone can join directly via this link</p>
          </div>
        </div>
        {expiresAt && (
          <span className="text-[11px] text-amber-400/90 bg-amber-400/10 border border-amber-400/20 px-2.5 py-1 rounded-full font-medium">
            Expires in 24h
          </span>
        )}
      </div>

      {/* Direct Universal Invite Link Input with Copy Button */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
            Universal Join Link
          </label>
          <span className="text-[10px] text-emerald-400 font-semibold flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
            Active for all phones & networks
          </span>
        </div>

        <div className="flex rounded-xl overflow-hidden border border-slate-700 bg-slate-950/60 focus-within:border-emerald-500 transition-colors shadow-inner">
          <input
            type="text"
            readOnly
            value={inviteUrl}
            onClick={handleCopyLink}
            className="flex-1 px-3.5 py-3 bg-transparent text-xs sm:text-sm font-mono text-emerald-400 select-all focus:outline-none truncate"
          />
          <button
            type="button"
            onClick={handleCopyLink}
            className="px-4 py-3 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white text-xs font-bold transition-colors flex items-center gap-1.5 shrink-0"
          >
            {copiedLink ? (
              <>
                <span>✓</span>
                <span>Copied!</span>
              </>
            ) : (
              <>
                <span>📋</span>
                <span>Copy Link</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Action Buttons: WhatsApp Share, QR Scan, and Invite Code */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
        {/* Code Box */}
        <div className="bg-slate-950/50 border border-slate-700/80 rounded-xl p-3 flex items-center justify-between">
          <div>
            <span className="text-[10px] text-slate-400 uppercase font-semibold block tracking-wider">
              Invite Code
            </span>
            <span className="text-xl font-mono font-bold tracking-widest text-white">
              {inviteCode}
            </span>
          </div>
          <button
            type="button"
            onClick={handleCopyCode}
            className="text-xs text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-600 px-3 py-1.5 rounded-lg transition-colors font-medium"
          >
            {copiedCode ? '✓ Copied' : 'Copy'}
          </button>
        </div>

        {/* Share Buttons */}
        <div className="flex items-center gap-2">
          {/* WhatsApp Share Button */}
          <button
            type="button"
            onClick={handleWhatsAppShare}
            className="flex-1 bg-[#25D366] hover:bg-[#20bd5a] text-slate-950 font-bold text-xs sm:text-sm py-3 px-3 rounded-xl transition-all shadow-md flex items-center justify-center gap-2"
          >
            <span className="text-base">💬</span>
            <span>WhatsApp</span>
          </button>

          {/* QR Code Toggle */}
          <button
            type="button"
            onClick={() => setShowQr(!showQr)}
            className={`px-3.5 py-3 rounded-xl border text-xs sm:text-sm font-bold transition-all flex items-center justify-center gap-1.5 ${
              showQr
                ? 'bg-purple-600 border-purple-500 text-white'
                : 'bg-slate-800 hover:bg-slate-700 border-slate-600 text-white'
            }`}
            title="Show QR Code to scan with phone"
          >
            <span>📱</span>
            <span>QR</span>
          </button>

          {/* Native / More Share */}
          {typeof navigator !== 'undefined' && 'share' in navigator && (
            <button
              type="button"
              onClick={handleNativeShare}
              className="bg-slate-800 hover:bg-slate-700 border border-slate-600 text-white text-xs py-3 px-3 rounded-xl transition-all flex items-center justify-center"
              title="More share options"
            >
              <span>↗</span>
            </button>
          )}
        </div>
      </div>

      {/* QR Code Scanner Overlay */}
      {showQr && (
        <div className="bg-slate-950/90 border border-purple-500/40 rounded-2xl p-4 text-center space-y-3 animate-fadeIn">
          <div>
            <p className="text-xs font-bold text-purple-300">
              Point your smartphone camera at this QR code to join:
            </p>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Works instantly on iOS Camera and Android Google Lens
            </p>
          </div>

          <div className="bg-white p-3.5 rounded-2xl inline-block shadow-2xl mx-auto border-2 border-purple-400/30">
            {qrGenerating && !qrDataUrl ? (
              <div className="w-48 h-48 flex flex-col items-center justify-center text-slate-400 text-xs">
                <span className="text-2xl animate-spin mb-2">🔄</span>
                <span>Generating QR...</span>
              </div>
            ) : (
              <img
                src={qrDataUrl}
                alt={`Join ${groupName} QR Code`}
                className="w-48 h-48 mx-auto object-contain block transition-transform duration-300 hover:scale-105"
              />
            )}
          </div>

          <div className="flex flex-col items-center gap-2">
            <div className="bg-slate-900 border border-slate-700 px-3 py-1 rounded-lg">
              <span className="text-[10px] text-slate-400 font-medium block">INVITE CODE:</span>
              <span className="text-sm font-mono font-black text-amber-400 tracking-wider">
                {inviteCode}
              </span>
            </div>

            {qrDataUrl && (
              <a
                href={qrDataUrl}
                download={`GroupLock-${groupName.replace(/\s+/g, '-')}-QR.png`}
                className="inline-flex items-center gap-1.5 text-xs text-purple-200 hover:text-white bg-purple-900/60 hover:bg-purple-800 border border-purple-500/50 px-3 py-1.5 rounded-lg transition font-medium shadow"
              >
                <span>💾</span>
                <span>Save QR Image to Phone</span>
              </a>
            )}

            <p className="text-[10px] font-mono text-slate-400 break-all truncate max-w-xs mx-auto">
              {inviteUrl}
            </p>
          </div>
        </div>
      )}

      <p className="text-[11px] text-slate-400 italic">
        💡 Unregistered riders who click this link will be prompted to sign up, and will automatically enter the group immediately!
      </p>

      {onDone && (
        <div className="pt-2 flex justify-end">
          <button
            type="button"
            onClick={onDone}
            className="bg-white text-slate-900 hover:bg-slate-100 text-xs font-bold px-4 py-2 rounded-lg transition-colors"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}

export default ShareInviteBox;
