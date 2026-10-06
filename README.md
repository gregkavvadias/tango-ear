# Tango Ear

Train your ear to recognise tango orchestras using your own music files. It's an installable web app (PWA): the same code runs in a desktop browser and as an app on Android.

## Run on this PC

```
cd C:\Users\gregk\source\repos\tango-ear
py -m http.server 8000
```

Then open http://localhost:8000 in Chrome or Edge, and choose your tango music folder. The folder and its scanned contents are remembered, so next time the library is ready straight away (or after a single "Reopen" click if the browser asks for permission again). After adding or moving music, use **Rescan** in the Library tab.

Headphone and lock-screen buttons work during playback: previous replays the clip, next moves on to the next round (or to another part of the track if you haven't answered yet).

## Install on Android

Android only offers "Install app" for pages served over **HTTPS**, so the folder needs hosting somewhere static. It's plain files with no build step: GitHub Pages, Netlify Drop and Cloudflare Pages all work. Open the URL in Chrome on the phone, choose ⋮ → **Add to Home screen / Install app**, then use **Choose individual files** to select your tango tracks.

Your music never leaves the device: files are read locally in the browser. Stats and settings are stored per device.

## How tracks are identified

- **Orchestra:** from the Artist / Album Artist / Conductor tags, falling back to album and folder names. Anything unrecognised can be assigned by hand in the **Library** tab.
- **Singer:** matched against known singers in the artist, title, comment and file name.
- **Year:** recording years between 1900 and 1989 from date tags, custom tags, comments or file names. CD release years (e.g. 2005) are ignored.

The orchestra knowledge base (profiles, eras, singers, "often confused with" notes) lives in `js/data.js` and is easy to extend.
