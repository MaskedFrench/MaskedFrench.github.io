#!/usr/bin/env python3
"""Inline CSS, fonts and scripts into index.html so the workbench is one file."""
import base64, mimetypes, os, re

def data_uri(path):
    mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    return f"data:{mime};base64," + base64.b64encode(open(path, "rb").read()).decode()

html = open("index.src.html", encoding="utf-8").read()

def css(m):
    path = m.group(1)
    text = open(path, encoding="utf-8").read()
    def fix(u):
        target = u.group(1).strip('"\'')
        if target.startswith("data:"):
            return u.group(0)
        return 'url("%s")' % data_uri(target)
    text = re.sub(r'url\(\s*["\']?([^)"\']+)["\']?\s*\)', fix, text)
    return "<style>\n" + text + "\n</style>"

html = re.sub(r'<link\s+rel="stylesheet"\s+href="([^"]+)"\s*/?>', css, html)
html = re.sub(r'<script\s+src="([^"]+)"\s*>\s*</script>',
              lambda m: "<script>\n" + open(m.group(1), encoding="utf-8").read() + "\n</script>", html)
html = re.sub(r'<link\s+rel="icon"\s+href="([^"]+)"\s+type="[^"]+"\s*/?>',
              lambda m: '<link rel="icon" href="%s">' % data_uri(m.group(1)), html)
html = html.replace("<!DOCTYPE html>",
                    "<!DOCTYPE html>\n<!-- Self-contained build. Sources: index.src.html, sarops.css, engine.js, app.js. Rebuild: python3 build.py -->", 1)
open("index.html", "w", encoding="utf-8").write(html)
print("index.html", round(os.path.getsize("index.html") / 1024), "KB")
