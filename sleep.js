(function () {
  const params = new URLSearchParams(window.location.search);
  const originalUrl   = params.get('url')   || '';
  const originalTitle = params.get('title') || originalUrl;

  document.getElementById('pageTitle').textContent = originalTitle;
  document.getElementById('pageUrl').textContent   = originalUrl;
  document.title = 'Sleeping: ' + originalTitle;

  document.getElementById('awakenBtn').addEventListener('click', () => {
    if (originalUrl) {
      window.location.href = originalUrl;
    }
  });
})();

/**
TO DO:
Add sleep tab in chrome icon at the top
Add sleep all tabs
Add exclusion rules
*/