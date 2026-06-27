ASK QUESTIONS! — Bear Camp visual assets
=========================================

WHAT GOES WHERE
---------------
1) Copy ALL of these PNG files into your repo's  public/  folder
   (same folder as index.html):
       og-bearcamp.png
       favicon-16.png
       favicon-32.png
       apple-touch-icon-180.png
       icon-192.png
       icon-512.png

2) Open  public/index.html  and paste the contents of
   index-head-snippet.html  inside the <head> … </head> section,
   replacing any existing <title>, favicon <link>, or og: <meta> tags.

3) Commit both the images and index.html. Vercel redeploys in ~1-2 min.

LOGO FILES (for emails, print, social avatars — not required by the app)
   logo-1024.png    – the round emblem, high-res
   emblem.svg       – vector version (scales to any size, editable)
   favicon-256.png  – medium emblem

OG / LINK-PREVIEW
   og-bearcamp.png  – 1200x630, this is what appears when you text or
                      email the link.  og-bearcamp.svg is the editable source.

WHY YOUR PREVIEW NEVER SHOWED BEFORE
   Link previews need ABSOLUTE image URLs (https://askquestionsapp.com/...),
   not relative ones. The snippet uses absolute URLs, so it'll work now.
   iMessage caches previews HARD — if you already texted the link, that old
   thread may keep showing nothing. Test with a fresh link, or the ?v=2 on
   the image URL forces scrapers to re-fetch (bump to ?v=3 if you revise art).
