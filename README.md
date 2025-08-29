# Tampermonkey Goodies — Simkl + Letterboxd

[![Userscript](https://img.shields.io/badge/Type-Userscripts-00aaff)](#)
[![Tampermonkey](https://img.shields.io/badge/Requires-Tampermonkey-black)](https://www.tampermonkey.net/)
[![Letterboxd](https://img.shields.io/badge/Site-Letterboxd-00e054)](https://letterboxd.com/)
[![Simkl](https://img.shields.io/badge/Site-Simkl-6f42c1)](https://simkl.com/)
[![License](https://img.shields.io/badge/License-MIT-green)](#license)

Two tiny userscripts to make movie life easier:

- **Simkl Letterboxd Popular Reviews Importer** — drops Letterboxd’s popular reviews onto Simkl movie pages and auto-refreshes as you navigate.
- **Letterboxd Unfollower** — scans who doesn’t follow back, bulk-unfollows, keeps **Exceptions**, and **blocks** re-following anyone you’ve unfollowed. Popup UI, progress bar, import/export—clean and fast.

> 🧰 **You need Tampermonkey** (Chrome/Edge/Brave/Firefox). Install it first: https://www.tampermonkey.net

---

## 🚀 Quick Install

Click a link, then hit **Raw** in GitHub to let Tampermonkey install it.

- **Simkl Importer (v2.1)**  
  GitHub: <https://github.com/westlandnigel/Trackingscripts/blob/main/Simkl%20Letterboxd%20Popular%20Reviews%20Importer-2.1.user.js>  
  Raw (direct install):  
  `https://raw.githubusercontent.com/westlandnigel/Trackingscripts/main/Simkl%20Letterboxd%20Popular%20Reviews%20Importer-2.1.user.js`

- **Letterboxd Unfollower (v1.3.1)**  
  GitHub: <https://github.com/westlandnigel/Trackingscripts/blob/main/Letterboxd%20Unfollower%20%E2%80%94%20Popup%20%2B%20Exceptions%20%2B%20Unfollowed%20Guard-1.3.1.user.js>  
  Raw (direct install):  
  `https://raw.githubusercontent.com/westlandnigel/Trackingscripts/main/Letterboxd%20Unfollower%20%E2%80%94%20Popup%20%2B%20Exceptions%20%2B%20Unfollowed%20Guard-1.3.1.user.js`

> Pro tip: open the Raw link on desktop for auto-install, or copy it into Tampermonkey → **Utilities → Install from URL**.

---

## 📝 What They Do

### 1) Simkl Letterboxd Popular Reviews Importer
- Finds the TMDB ID on Simkl, resolves the matching Letterboxd movie, pulls **Popular Reviews**, and injects them on the page.
- SPA-friendly: auto re-runs when you navigate between movies.

### 2) Letterboxd Unfollower — Popup + Exceptions + Guard

- **Scan** followers/following → shows “don’t follow back.”
- **Bulk Unfollow** via hidden iframes + progress bar.
- **Exceptions list** so your pals stay safe.
- **Guard mode** blocks the Follow button on anyone in **Unfollowed**.
- **Popup UI**: click **“Unfollower”** in the header (next to +LOG). Syncs across tabs.
- **Import/Export** your lists as JSON.

