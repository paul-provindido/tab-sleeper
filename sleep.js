(function () {
  const params = new URLSearchParams(window.location.search);
  const originalUrl   = params.get('url')   || '';
  const originalTitle = params.get('title') || originalUrl;

  document.getElementById('pageTitle').textContent = originalTitle;
  document.getElementById('pageUrl').textContent   = originalUrl;
  document.title = 'Sleeping: ' + originalTitle;

  function isSafeUrl(url) {
    try {
      const { protocol } = new URL(url);
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }

  function awaken() {
    if (isSafeUrl(originalUrl)) window.location.href = originalUrl;
  }

  document.getElementById('awakenBtn').addEventListener('click', awaken);
  document.body.addEventListener('click', awaken);
})();
