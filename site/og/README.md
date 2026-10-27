# Share card

`og.html` is the source of `site/www/og.png` (1200×630, linked from `og:image`). It lives outside `site/www` so it isn't pinned. Re-render after changing it, from `site/`:

```
CH=$(ls -d ~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-*/chrome-headless-shell | tail -1)
"$CH" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=1200,630 \
  --virtual-time-budget=5000 --allow-file-access-from-files --screenshot=/tmp/og2x.png "file://$PWD/og/og.html"
sips -z 630 1200 /tmp/og2x.png --out www/og.png
```

Render at 2× and downscale for crisp text; the time budget lets the Geist webfonts load.
