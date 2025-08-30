// ==UserScript==
// @name         Letterboxd Unfollower — Popup + Exceptions + Unfollowed Guard
// @namespace    nigel/letterboxd/unfollower
// @version      1.4.2
// @description  Find users who don't follow back, unfollow them via hidden iframes, manage exceptions & unfollowed lists, and block re-following unfollowed users. Header button toggles popup, state syncs across tabs.
// @author       you
// @match        https://letterboxd.com/*
// @icon         https://letterboxd.com/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------- Utilities ----------------
  const uW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const norm = (u) => (u || '').replace(/^\/|\/$/g, '').trim().toLowerCase();

  function getLoggedInUser() {
    try { if (uW.person && uW.person.username) return uW.person.username; } catch (e) {}
    for (const s of $all('script')) {
      const m = (s.textContent || '').match(/person\.username\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    }
    return null;
  }

  const loggedIn = getLoggedInUser();
  if (!loggedIn) return;

  // Keys per account
  const KEY = {
    exceptions: `lbxd_exceptions_${loggedIn}`,
    unfollowed: `lbxd_unfollowed_${loggedIn}`,
    opts: `lbxd_options_${loggedIn}`,
    uiOpen: `lbxd_ui_open_${loggedIn}`,
  };

  // Storage helpers (store everything lowercased for reliable matching)
  function loadSet(key) {
    const arr = GM_getValue(key, []);
    return new Set((Array.isArray(arr) ? arr : []).map(norm));
  }
  function updateSet(key, mutator) {
    const fresh = loadSet(key);
    mutator(fresh);
    GM_setValue(key, Array.from(fresh));
    return fresh;
  }

  const exceptions = loadSet(KEY.exceptions);
  const unfollowed = loadSet(KEY.unfollowed);

  // NOTE: bump default scan timeout a bit to reduce false aborts
  const defaultOpts = { disableFollowOnUnfollowed: true, concurrency: 3, scanTimeoutMs: 12000, clickDelayMs: 350 };
  const opts = Object.assign(defaultOpts, GM_getValue(KEY.opts, {}));
  const saveOpts = () => GM_setValue(KEY.opts, opts);

  // Cross-tab sync
  let refreshBadges = null;
  GM_addValueChangeListener(KEY.exceptions, (_n, _o, v, remote) => {
    if (!remote) return;
    exceptions.clear(); (v || []).map(norm).forEach((x) => exceptions.add(x));
    refreshBadges && refreshBadges();
  });
  GM_addValueChangeListener(KEY.unfollowed, (_n, _o, v, remote) => {
    if (!remote) return;
    unfollowed.clear(); (v || []).map(norm).forEach((x) => unfollowed.add(x));
    refreshBadges && refreshBadges();
    guardApplyAll();
  });
  GM_addValueChangeListener(KEY.uiOpen, (_n, _o, v, remote) => {
    if (!remote) return;
    v ? ensurePopup() : destroyPopup();
  });

  // --------------- Page helpers ---------------
  function getPageOwner() {
    const ownerAttr = document.body.getAttribute('data-owner');
    if (ownerAttr) return norm(ownerAttr);
    const m = location.pathname.match(/^\/([^/]+)\/?/);
    if (m && m[1] && !['films','lists','members','journal','search','activity','settings','sign-in','create-account'].includes(m[1])) {
      return norm(m[1]);
    }
    return null;
  }

  // Robust username extraction for followers/following tables
  function extractNamesFromHTML(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = new Set();

    // 1) Standard username anchor in tables
    $all('a.name', doc).forEach(a => {
      const href = a.getAttribute('href') || '';
      const slug = norm(href);
      if (slug) out.add(slug);
    });

    // 2) Fallback: server-rendered follow-button wrappers carry data-username
    $all('.js-follow-button-wrapper[data-username]', doc).forEach(w => {
      const u = norm(w.getAttribute('data-username'));
      if (u) out.add(u);
    });

    return Array.from(out);
  }

  async function fetchPage(url) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), opts.scanTimeoutMs);
    try {
      const res = await fetch(url, { credentials: 'include', signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally { clearTimeout(t); }
  }

  // Retry wrapper to dodge transient network hiccups / slow pages
  async function fetchPageWithRetry(url, tries = 3) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try { return await fetchPage(url); }
      catch (e) { lastErr = e; await sleep(400 * (i + 1)); }
    }
    throw lastErr || new Error('fetch failed');
  }

  async function paginateUserList(user, kind) {
    let page = 1; const out = new Set();
    while (true) {
      const html = await fetchPageWithRetry(`https://letterboxd.com/${user}/${kind}/page/${page}`);
      const names = extractNamesFromHTML(html);
      if (!names.length) break;
      names.forEach(n => out.add(n));
      page++; await sleep(60);
    }
    return Array.from(out).sort();
  }

  function partitionDontFollowBack(followers, following) {
    const fset = new Set(followers), Fset = new Set(following);
    return {
      dontFollowBack: following.filter(n => !fset.has(n)).sort(),
      fans: followers.filter(n => !Fset.has(n)).sort(),
    };
  }

  // --------------- Unfollow engine ---------------
  function createHiddenIframe(src) {
    const iframe = document.createElement('iframe');
    iframe.src = src;
    Object.assign(iframe.style, { position: 'fixed', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none', zIndex: '-1' });
    document.body.appendChild(iframe);
    return iframe;
  }

  async function clickUnfollowInFrame(iframe) {
    await new Promise((res, rej) => { iframe.addEventListener('load', res, { once: true }); iframe.addEventListener('error', rej, { once: true }); });
    const doc = iframe.contentDocument;
    if (!doc) throw new Error('no doc');
    const btn = doc.querySelector('a.js-button-following, button.js-button-following, [data-action$="/unfollow/"]');
    if (btn) { btn.click(); await sleep(opts.clickDelayMs); return !!doc.querySelector('a.js-button-follow, button.js-button-follow, [data-action$="/follow/"]'); }
    return true;
  }

  async function unfollowUsers(usernames, onProgress) {
    const queue = usernames.slice(); let ok = 0, fail = 0;
    const workers = Math.max(1, Math.min(opts.concurrency, 6));
    async function worker() {
      while (queue.length) {
        const u = queue.shift(); let iframe;
        try {
          iframe = createHiddenIframe(`https://letterboxd.com/${u}/`);
          const success = await clickUnfollowInFrame(iframe);
          if (success) {
            const updated = updateSet(KEY.unfollowed, s => s.add(norm(u)));
            unfollowed.clear(); updated.forEach(x => unfollowed.add(x));
            ok++;
          } else fail++;
        } catch { fail++; }
        finally {
          if (iframe && iframe.parentNode) iframe.remove();
          onProgress && onProgress({ ok, fail, done: ok + fail, total: usernames.length, current: u });
          await sleep(80);
        }
      }
    }
    await Promise.all(Array.from({ length: workers }, worker));
    return { ok, fail };
  }

  // --------------- Follow guard (global & robust) ---------------
  function markAndDisable(btn) {
    if (!btn || btn.getAttribute('data-lbxd-blocked') === '1') return;
    btn.setAttribute('data-lbxd-blocked', '1');
    btn.style.background = '#D22';
    btn.style.borderColor = '#B11';
    btn.style.pointerEvents = 'none';
    btn.style.filter = 'saturate(140%)';
    btn.style.opacity = '0.85';
    btn.title = 'Blocked: in your Unfollowed list';
    if (btn.textContent && btn.textContent.trim().toLowerCase().includes('follow')) btn.textContent = 'Blocked';
  }
  function unmark(btn) {
    if (!btn) return;
    btn.removeAttribute('data-lbxd-blocked');
    btn.style.background = '';
    btn.style.borderColor = '';
    btn.style.pointerEvents = '';
    btn.style.filter = '';
    btn.style.opacity = '';
    if (btn.title && btn.title.includes('Blocked')) btn.title = '';
  }

  function isAnyFollowBtn(el) {
    if (!el) return null;
    let n = el;
    for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
      if (!n.matches) continue;
      if (n.matches('a.js-button-follow, a[data-action$="/follow/"], button.js-button-follow')) return n;
    }
    return null;
  }

  // Apply guard to page owner + any list/table rows visible
  function guardApplyAll() {
    if (!opts.disableFollowOnUnfollowed) return;

    // Page owner follow button
    const owner = getPageOwner();
    if (owner && unfollowed.has(owner)) {
      const btn = document.querySelector('a.js-button-follow, a[data-action$="/follow/"], button.js-button-follow');
      if (btn) markAndDisable(btn);
    }

    // Any rows/cards with a username wrapper
    $all('.js-follow-button-wrapper[data-username]').forEach(wrap => {
      const user = norm(wrap.getAttribute('data-username'));
      const followA = wrap.querySelector('a.js-button-follow, a[data-action$="/follow/"], button.js-button-follow');
      if (!followA) return;
      if (unfollowed.has(user)) markAndDisable(followA); else unmark(followA);
    });
  }

  // Capture-level blocker: prevents follow action anywhere on the page
  document.addEventListener('click', (e) => {
    if (!opts.disableFollowOnUnfollowed) return;
    const btn = isAnyFollowBtn(e.target);
    if (!btn) return;

    const wrap = btn.closest('.js-follow-button-wrapper[data-username]');
    const user = wrap ? norm(wrap.getAttribute('data-username')) : getPageOwner();

    if (user && unfollowed.has(user)) {
      e.preventDefault(); e.stopPropagation();
      markAndDisable(btn);
    }
  }, true);

  // Mutation observer to catch dynamically added lists / buttons
  const mo = new MutationObserver(() => guardApplyAll());
  mo.observe(document.documentElement, { childList: true, subtree: true });
  guardApplyAll();

  // --------------- Header toggle button ---------------
  GM_addStyle(`#lbxd-toggle-btn.button.-secondary{padding:6px 10px;line-height:1.1}`);
  function injectHeaderButton() {
    if (document.getElementById('lbxd-toggle-btn')) return;

    const header = document.getElementById('header');
    if (!header) return;

    const logWrap =
      header.querySelector('.add-menu-wrapper') ||
      header.querySelector('.js-add-new') ||
      header.querySelector('a.button.-action');

    const rightCluster = (logWrap && logWrap.parentElement) ||
      header.querySelector('.show-when-logged-in') ||
      header;

    const btn = document.createElement('a');
    btn.id = 'lbxd-toggle-btn';
    btn.className = 'button -secondary';
    btn.textContent = 'Unfollower';
    btn.href = 'javascript:void(0)';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const now = !!GM_getValue(KEY.uiOpen, false);
      GM_setValue(KEY.uiOpen, !now);
      (!now) ? ensurePopup() : destroyPopup();
    });

    if (logWrap && logWrap.parentElement) {
      btn.style.marginRight = '8px';
      logWrap.parentElement.insertBefore(btn, logWrap); // before +LOG
    } else {
      btn.style.marginLeft = '8px';
      rightCluster.appendChild(btn);
    }
  }
  injectHeaderButton();
  const headerBtnObserver = new MutationObserver(() => injectHeaderButton());
  headerBtnObserver.observe(document.documentElement, { childList: true, subtree: true });

  // --------------- Popup (created on demand) ---------------
  let el = null;
  let lastScan = null;

  function ensurePopup() { if (!el) buildPopup(); }
  function destroyPopup() { if (el && el.parentNode) el.remove(); el = null; }

  // Styles
  GM_addStyle(`
    .lbxd-mini{position:fixed;right:16px;bottom:16px;width:360px;background:rgba(20,24,28,.98);color:#E6EDF3;border:1px solid #2a2f35;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.4);font-family:ui-sans-serif,system-ui,sans-serif;z-index:999999999}
    .lbxd-mini header{display:flex;justify-content:space-between;padding:10px;font-weight:600;cursor:move;background:#14181C;border-bottom:1px solid #2a2f35;border-radius:12px 12px 0 0}
    .lbxd-mini .btn{padding:6px 10px;font-size:13px;border:1px solid #384049;border-radius:6px;background:#1b2228;color:#E6EDF3;cursor:pointer}
    .lbxd-mini .btn.-primary{background:#1f6feb;border-color:#1a5ec7;color:#fff}
    .lbxd-mini .btn.-danger{background:#b42318;border-color:#8f1e14;color:#fff}
    .lbxd-mini .btn:disabled{opacity:.5;cursor:not-allowed}
    .lbxd-mini main{padding:10px;display:grid;gap:10px}
    .lbxd-mini .row{display:flex;gap:6px;flex-wrap:wrap}
    .lbxd-mini .pill{background:#20262c;border:1px solid #2b333b;border-radius:999px;padding:2px 8px;font-size:12px}
    .lbxd-mini textarea{width:100%;min-height:80px;background:#0f1418;color:#e6edf3;border:1px solid #2a2f35;border-radius:8px;padding:6px;font-size:12px}
    .lbxd-mini footer{padding:8px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid #2a2f35;border-radius:0 0 12px 12px}
    .lbxd-mini .progress{height:6px;background:#0f1418;border:1px solid #2a2f35;border-radius:999px;overflow:hidden;flex:1;margin-right:6px}
    .lbxd-mini .bar{height:100%;width:0;background:#1f6feb;transition:width .2s}
    /* modal editor */
    .lbxd-ex-editor{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000000000;display:flex;align-items:center;justify-content:center}
    .lbxd-ex-editor .box{width:480px;max-width:95vw;background:#14181C;border:1px solid #2a2f35;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.4)}
    .lbxd-ex-editor header{padding:10px 12px;font-weight:600;border-bottom:1px solid #2a2f35}
    .lbxd-ex-editor .content{padding:10px 12px}
    .lbxd-ex-editor textarea{width:100%;height:240px;background:#0f1418;color:#e6edf3;border:1px solid #2a2f35;border-radius:8px;padding:8px;font-size:12px}
    .lbxd-ex-editor footer{display:flex;gap:8px;justify-content:flex-end;padding:10px 12px;border-top:1px solid #2a2f35}
    .lbxd-ex-editor .btn{padding:6px 10px;border:1px solid #384049;border-radius:6px;background:#1b2228;color:#E6EDF3;cursor:pointer}
    .lbxd-ex-editor .btn.-primary{background:#1f6feb;border-color:#1a5ec7;color:#fff}
  `);

  function buildPopup() {
    if (el) return;
    el = document.createElement('div');
    el.className = 'lbxd-mini';
    el.innerHTML = `
      <header><div>Letterboxd Unfollower</div><div class="x" style="cursor:pointer">✕</div></header>
      <main>
        <div class="row">
          <span class="pill">Logged in as <strong>${loggedIn}</strong></span>
          <span class="pill">Exceptions: <strong class="exCount">${exceptions.size}</strong></span>
          <span class="pill">Unfollowed: <strong class="ufCount">${unfollowed.size}</strong></span>
        </div>
        <div class="row">
          <button class="btn -primary scanBtn">Scan</button>
        </div>
        <div class="row">
          <button class="btn addExBtn">+ Exception</button>
          <button class="btn remExBtn">− Remove Exception (this user)</button>
          <button class="btn editExBtn">Edit Exceptions</button>
        </div>
        <div class="row">
          <button class="btn addUfBtn">+ Add Unfollowed (this user)</button>
          <button class="btn remUfBtn">− Remove Unfollowed (this user)</button>
          <button class="btn editUfBtn">Edit Unfollowed</button>
        </div>
        <div class="row">
          <label><input type="checkbox" class="guardChk"> Guard follow button</label>
        </div>
        <div class="row">
          <button class="btn -danger unfollowBtn" disabled>Unfollow non-followers</button>
          <button class="btn exportBtn">Export</button>
          <button class="btn importBtn">Import</button>
          <button class="btn clearBtn">Clear Unfollowed</button>
        </div>
        <div class="row"><textarea class="log" readonly></textarea></div>
      </main>
      <footer><div class="progress"><div class="bar"></div></div><div class="count">0/0</div></footer>
    `;
    document.body.appendChild(el);

    // draggable
    (function () {
      const header = el.querySelector('header'); let sx, sy, ox, oy, drag = false;
      header.addEventListener('mousedown', e => { drag = true; sx = e.clientX; sy = e.clientY; const r = el.getBoundingClientRect(); ox = r.left; oy = r.top; e.preventDefault(); });
      window.addEventListener('mousemove', e => { if (!drag) return; el.style.left = (ox + e.clientX - sx) + 'px'; el.style.top = (oy + e.clientY - sy) + 'px'; el.style.right = 'auto'; el.style.bottom = 'auto'; });
      window.addEventListener('mouseup', () => drag = false);
    })();

    // refs
    const closeBtn = el.querySelector('.x'), scanBtn = el.querySelector('.scanBtn'),
      addExBtn = el.querySelector('.addExBtn'), remExBtn = el.querySelector('.remExBtn'), editExBtn = el.querySelector('.editExBtn'),
      addUfBtn = el.querySelector('.addUfBtn'), remUfBtn = el.querySelector('.remUfBtn'), editUfBtn = el.querySelector('.editUfBtn'),
      unfollowBtn = el.querySelector('.unfollowBtn'), exportBtn = el.querySelector('.exportBtn'),
      importBtn = el.querySelector('.importBtn'), clearBtn = el.querySelector('.clearBtn'),
      guardChk = el.querySelector('.guardChk'), logArea = el.querySelector('.log'),
      bar = el.querySelector('.bar'), count = el.querySelector('.count'),
      exCount = el.querySelector('.exCount'), ufCount = el.querySelector('.ufCount');

    guardChk.checked = !!opts.disableFollowOnUnfollowed;

    function log(line) { logArea.value += (logArea.value ? '\n' : '') + line; logArea.scrollTop = logArea.scrollHeight; }
    function setProgress(done, total) { bar.style.width = (total ? Math.round(done / total * 100) : 0) + '%'; count.textContent = `${done}/${total}`; }
    refreshBadges = function refreshBadges() { exCount.textContent = exceptions.size; ufCount.textContent = unfollowed.size; };

    // events
    closeBtn.onclick = () => { GM_setValue(KEY.uiOpen, false); destroyPopup(); };
    guardChk.onchange = () => { opts.disableFollowOnUnfollowed = guardChk.checked; saveOpts(); guardApplyAll(); };

    // Exceptions
    addExBtn.onclick = () => {
      const owner = getPageOwner(); if (!owner) { log('No user detected.'); return; }
      if (owner === norm(loggedIn)) { log('That’s you.'); return; }
      const updated = updateSet(KEY.exceptions, s => s.add(owner));
      exceptions.clear(); updated.forEach(x => exceptions.add(x));
      refreshBadges(); log(`Added exception: ${owner}`);
    };
    remExBtn.onclick = () => {
      const owner = getPageOwner(); if (!owner) { log('No user detected.'); return; }
      if (!exceptions.has(owner)) { log(`Not in exceptions: ${owner}`); return; }
      const updated = updateSet(KEY.exceptions, s => s.delete(owner));
      exceptions.clear(); updated.forEach(x => exceptions.add(x));
      refreshBadges(); log(`Removed exception: ${owner}`);
    };

    // Unfollowed
    addUfBtn.onclick = () => {
      const owner = getPageOwner(); if (!owner) { log('No user detected.'); return; }
      const updated = updateSet(KEY.unfollowed, s => s.add(owner));
      unfollowed.clear(); updated.forEach(x => unfollowed.add(x));
      refreshBadges(); log(`Added to Unfollowed: ${owner}`);
      guardApplyAll();
    };
    remUfBtn.onclick = () => {
      const owner = getPageOwner(); if (!owner) { log('No user detected.'); return; }
      if (!unfollowed.has(owner)) { log(`Not in Unfollowed: ${owner}`); return; }
      const updated = updateSet(KEY.unfollowed, s => s.delete(owner));
      unfollowed.clear(); updated.forEach(x => unfollowed.add(x));
      refreshBadges(); log(`Removed from Unfollowed: ${owner}`);
      // Unmark any visible buttons for this user
      $all('.js-follow-button-wrapper[data-username]').forEach(w => {
        if (norm(w.getAttribute('data-username')) === owner) unmark(w.querySelector('a.js-button-follow, a[data-action$="/follow/"], button.js-button-follow'));
      });
      const pageBtn = document.querySelector('a.js-button-follow, a[data-action$="/follow/"], button.js-button-follow');
      if (pageBtn && getPageOwner() === owner) unmark(pageBtn);
    };

    // Editors
    function openListEditor(kind, title) {
      document.querySelector('.lbxd-ex-editor')?.remove();
      const overlay = document.createElement('div');
      overlay.className = 'lbxd-ex-editor';
      overlay.innerHTML = `
        <div class="box">
          <header>${title}</header>
          <div class="content">
            <p style="opacity:.8;margin:0 0 6px 0;">One username per line.</p>
            <textarea class="ta"></textarea>
          </div>
          <footer>
            <button class="btn cancelBtn">Cancel</button>
            <button class="btn -primary saveBtn">Save</button>
          </footer>
        </div>`;
      document.body.appendChild(overlay);
      const ta = $('.ta', overlay);
      const source = (kind === 'exceptions') ? exceptions : unfollowed;
      ta.value = Array.from(source).sort().join('\n');
      $('.cancelBtn', overlay).onclick = () => overlay.remove();
      $('.saveBtn', overlay).onclick = () => {
        const next = new Set(ta.value.split('\n').map(s => norm(s)).filter(Boolean));
        const k = (kind === 'exceptions') ? KEY.exceptions : KEY.unfollowed;
        const updated = updateSet(k, s => { s.clear(); next.forEach(x => s.add(x)); });
        const target = (kind === 'exceptions') ? exceptions : unfollowed;
        target.clear(); updated.forEach(x => target.add(x));
        refreshBadges(); log(`${title} saved.`);
        overlay.remove();
        if (kind === 'unfollowed') guardApplyAll();
      };
      overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
      ta.focus();
    }
    editExBtn.onclick = () => openListEditor('exceptions', 'Edit Exceptions');
    editUfBtn.onclick = () => openListEditor('unfollowed', 'Edit Unfollowed');

    clearBtn.onclick = () => { updateSet(KEY.unfollowed, s => s.clear()); unfollowed.clear(); refreshBadges(); log('Cleared unfollowed list.'); guardApplyAll(); };

    exportBtn.onclick = () => {
      const payload = { account: loggedIn, when: new Date().toISOString(), options: opts, exceptions: Array.from(exceptions), unfollowed: Array.from(unfollowed) };
      navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).then(() => log('Exported to clipboard.')).catch(() => log(JSON.stringify(payload, null, 2)));
    };
    importBtn.onclick = () => {
      const text = prompt('Paste JSON:'); if (!text) return;
      try {
        const data = JSON.parse(text);
        if (Array.isArray(data.exceptions)) updateSet(KEY.exceptions, s => { s.clear(); data.exceptions.map(norm).forEach(x => s.add(x)); });
        if (Array.isArray(data.unfollowed)) updateSet(KEY.unfollowed, s => { s.clear(); data.unfollowed.map(norm).forEach(x => s.add(x)); });
        if (data.options) Object.assign(opts, data.options), saveOpts();
        exceptions.clear(); loadSet(KEY.exceptions).forEach(x => exceptions.add(x));
        unfollowed.clear(); loadSet(KEY.unfollowed).forEach(x => unfollowed.add(x));
        refreshBadges(); log('Import complete.');
        guardApplyAll();
      } catch { alert('Invalid JSON.'); }
    };

    scanBtn.onclick = async () => {
      try {
        scanBtn.disabled = unfollowBtn.disabled = true;
        log('Scanning...');
        setProgress(0, 0);
        const [followers, following] = await Promise.all([
          paginateUserList(norm(loggedIn), 'followers'),
          paginateUserList(norm(loggedIn), 'following'),
        ]);
        const { dontFollowBack } = partitionDontFollowBack(followers, following);
        const filtered = dontFollowBack.filter(u => !exceptions.has(u));
        lastScan = { followers, following, dontFollowBack, filtered };
        log(`Followers: ${followers.length}, Following: ${following.length}`);
        log(`Don't follow back: ${dontFollowBack.length}, After exceptions: ${filtered.length}`);
        setProgress(0, filtered.length);
        unfollowBtn.disabled = filtered.length === 0;
      } catch (e) {
        log(`Scan failed: ${e && e.message ? e.message : e}`);
      } finally {
        scanBtn.disabled = false;
      }
    };

    unfollowBtn.onclick = async () => {
      if (!lastScan || !lastScan.filtered.length) { log('Nothing to unfollow.'); return; }
      if (!confirm(`Unfollow ${lastScan.filtered.length}?`)) return;
      unfollowBtn.disabled = scanBtn.disabled = true;
      const res = await unfollowUsers(lastScan.filtered, p => { setProgress(p.done, p.total); if (p.current) log(`Processed ${p.current}`); });
      log(`Done. Success ${res.ok}, Fail ${res.fail}`);
      refreshBadges(); unfollowBtn.disabled = scanBtn.disabled = false;
      guardApplyAll();
    };
  }

  // Open/close on load based on saved state
  if (GM_getValue(KEY.uiOpen, false)) ensurePopup();

  // Also menu item in TM
  GM_registerMenuCommand('Toggle Unfollower popup', () => {
    const now = !!GM_getValue(KEY.uiOpen, false);
    GM_setValue(KEY.uiOpen, !now);
    (!now) ? ensurePopup() : destroyPopup();
  });
})();
