// Landing progressive enhancement: copy-to-clipboard, scroll reveal, and a
// live GitHub star count with graceful fallback. Plain DOM, no framework —
// mirrors the dashboard's vanilla-JS approach.
(function () {
  function execCopy(text) {
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy') ? resolve() : reject(new Error('copy failed'));
      } catch (e) {
        reject(e);
      }
      document.body.removeChild(ta);
    });
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      // Fall back to execCommand when the async API is blocked (e.g. no permission).
      return navigator.clipboard.writeText(text).catch(function () {
        return execCopy(text);
      });
    }
    return execCopy(text);
  }

  // Copy buttons: copy the .cmd-text inside the enclosing terminal / install block.
  document.querySelectorAll('.copy-btn[data-copy-prev]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var box = btn.closest('.terminal, .install-block');
      var src = box && box.querySelector('.cmd-text');
      if (!src) return;
      copyText(src.textContent.trim()).then(
        function () {
          var original = btn.textContent;
          btn.textContent = 'Copied ✓';
          btn.classList.add('copied');
          setTimeout(function () {
            btn.textContent = original;
            btn.classList.remove('copied');
          }, 1600);
        },
        function () {},
      );
    });
  });

  // Mobile menu toggle.
  var toggle = document.querySelector('.nav-toggle');
  var menu = document.getElementById('nav-links');
  if (toggle && menu) {
    var setMenu = function (open) {
      menu.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    };
    toggle.addEventListener('click', function () {
      setMenu(!menu.classList.contains('is-open'));
    });
    menu.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        setMenu(false);
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setMenu(false);
    });
  }

  // Live GitHub star count (best-effort; silently keeps the static label on failure).
  var gh = document.querySelector('.gh-star[data-gh]');
  if (gh && 'fetch' in window) {
    fetch('https://api.github.com/repos/' + gh.getAttribute('data-gh'), {
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        if (!data || typeof data.stargazers_count !== 'number') return;
        var n = data.stargazers_count;
        var label = gh.querySelector('.gh-label');
        if (label) label.textContent = n >= 1000 ? (n / 1000).toFixed(1) + 'k stars' : n + ' stars';
      })
      .catch(function () {});
  }

  // Scroll reveal — skip entirely under reduced-motion or without IO support.
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var els = document.querySelectorAll('.reveal');
  if (reduce || !('IntersectionObserver' in window)) {
    els.forEach(function (el) {
      el.classList.add('in');
    });
    return;
  }
  var io = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 },
  );
  els.forEach(function (el) {
    io.observe(el);
  });
})();
