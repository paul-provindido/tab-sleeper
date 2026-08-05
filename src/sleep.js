(function () {
  const params = new URLSearchParams(window.location.search);
  const originalUrl   = params.get('url')   || '';
  const originalTitle = params.get('title') || originalUrl;

  document.getElementById('pageTitle').textContent = originalTitle;
  document.getElementById('pageUrl').textContent   = originalUrl;
  document.title = originalTitle;

  function isSafeUrl(url) {
    try {
      const { protocol } = new URL(url);
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }

  function awaken() {
    if (isSafeUrl(originalUrl)) window.location.replace(originalUrl);
  }

  const iconUrl = params.get('icon') || '';
  if (iconUrl) {
    try {
      const { protocol } = new URL(iconUrl);
      if (['http:', 'https:', 'data:'].includes(protocol)) {
        const img = document.getElementById('favicon');
        img.addEventListener('error', () => { img.style.display = 'none'; });
        img.src = iconUrl;
        img.style.display = '';
      }
    } catch {}
  }

  document.body.addEventListener('click', awaken);
})();
