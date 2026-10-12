'use strict';
// Keep the original fragment in page memory when section links change the hash.
// Only an explicit copy exports it; no requests, storage, analytics or redemption.
const giftFragment = window.location.hash;
const button = document.querySelector('#copy-instructions');
const status = document.querySelector('#copy-status');
button.hidden = false;
button.addEventListener('click', async () => {
  const params = new URLSearchParams(giftFragment.slice(1));
  const code = params.get('code');
  if (code !== null && (!/^[A-Za-z0-9_-]{43}$/.test(code) || params.getAll('code').length !== 1)) {
    status.textContent = 'This gift link looks incomplete. Ask the sender for the original link.';
    return;
  }
  const link = new URL('https://amiller.github.io/abalone/redeem');
  if (code !== null) link.hash = new URLSearchParams({ code }).toString();
  const intent = code === null
    ? 'Help me use existing access or obtain a coupon.'
    : 'I would like to redeem this coupon and save the access credential for a fresh Abalone terminal.';
  const instruction = 'Help me understand Abalone and set up an incognito session. Read the setup skill linked from '
    + link.href + ' before installing. Explain the local changes and trust boundaries. '
    + intent + ' Keep my private documents and conversation out of this setup chat.';
  try {
    await navigator.clipboard.writeText(instruction);
    status.textContent = code === null
      ? 'Copied. Paste into your coding agent to choose your access path.'
      : 'Copied with your gift link. Paste only into the setup agent you trust.';
  } catch {
    status.textContent = 'Copy this page’s full address into your coding agent; clipboard access is unavailable.';
  }
});
