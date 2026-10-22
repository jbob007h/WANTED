# Builds public/index.html from the claude.ai version of the game plus connector.js.
# Usage: python3 build.py path/to/game.html
import sys, re, subprocess, tempfile, os
src = open(sys.argv[1], encoding='utf-8').read()
conn = open('connector.js', encoding='utf-8').read()
head = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        '<title>WANTED</title><link rel="icon" type="image/png" href="/favicon.png">'
        '<meta name="description" content="WANTED: a first-person arena shooter with live duels. By judah.">'
        '<meta property="og:title" content="WANTED"><meta property="og:description" content="1v1 arena duels. By judah.">'
        '<meta property="og:type" content="website"><meta property="og:image" content="__ORIGIN__/thumbnail.jpg">'
        '<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="__ORIGIN__/thumbnail.jpg">'
        '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
        'body{margin:0;font:14px system-ui,-apple-system,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>'
        '</head><body>')
html = head + '<script>\n' + conn + '\n</script>\n' + src + '\n</body></html>\n'
# wording that only made sense on claude.ai (note: no plain apostrophes inside JS strings)
html = html.replace("Name checking needs a signed-in viewer who can save to this game, so this name is only kept on this device.",
                    "Can’t reach the game server right now, so this name is only kept on this device.")
html = html.replace('<p class="admnote">Live players need a signed-in view of the game.</p>', '<p class="admnote">Not connected to the game server.</p>')
# every script must parse before we write the file
for i, b in enumerate(re.findall(r'<script>(.*?)</script>', html, re.S)):
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8') as f: f.write(b); name = f.name
    r = subprocess.run(['node', '--check', name], capture_output=True, text=True); os.unlink(name)
    if r.returncode: sys.exit('script %d does not parse:\n%s' % (i, r.stderr[:600]))
open('public/index.html', 'w', encoding='utf-8').write(html)
print('built public/index.html', len(html), 'bytes; all scripts parse')
