(function () {
  const params = new URLSearchParams(window.location.search);
  const originalUrl   = params.get('url')   || '';
  const originalTitle = params.get('title') || originalUrl;

  document.getElementById('pageTitle').textContent = originalTitle;
  document.getElementById('pageUrl').textContent   = originalUrl;
  document.title = 'Sleeping: ' + originalTitle;

  function awaken() {
    if (originalUrl) window.location.href = originalUrl;
  }

  document.getElementById('awakenBtn').addEventListener('click', awaken);
  document.body.addEventListener('click', awaken);
})();
