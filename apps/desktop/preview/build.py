"""Generate a browser-openable copy of the built renderer.

Copies the stub bridge next to the build output and writes preview.html — the
real index.html with the stub loaded ahead of the app bundle. Run after
`electron-vite build`, then open apps/desktop/out/renderer/preview.html.

Development aid: everything it writes lands in out/, which is not tracked.
"""
import io
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'out', 'renderer')

shutil.copyfile(os.path.join(HERE, 'stub.js'), os.path.join(OUT, 'stub.js'))

html = io.open(os.path.join(OUT, 'index.html'), encoding='utf-8').read()
# The packaged CSP has no 'unsafe-eval' and blocks the CDN art the fixtures
# point at; the preview is local-only, so it simply drops the policy.
start = html.find('<meta\n      http-equiv="Content-Security-Policy"')
end = html.find('/>', start) + 2
html = html[:start] + html[end:]
html = html.replace(
    '<script type="module"',
    '<script src="./stub.js"></script>\n    <script type="module"',
    1,
)
io.open(os.path.join(OUT, 'preview.html'), 'w', encoding='utf-8', newline='\n').write(html)
print('preview:', os.path.normpath(os.path.join(OUT, 'preview.html')))
