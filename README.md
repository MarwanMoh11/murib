# مُعرِب · Mu'rib

A personal study app for Chinese→Arabic translation: photograph a handout and get every word numbered with pinyin, its إعراب, a word-by-word gloss and an exam-grade Arabic translation, plus flashcards, an i'rab quiz and an examiner that grades your own translation.

Static site (GitHub Pages, `docs/`) behind a password. Claude is called directly with your own Anthropic API key; your library is saved to a private GitHub repo. Both credentials are stored only as AES-GCM ciphertext (`docs/config.enc.json`) under a PBKDF2 key derived from your password.

```bash
npm install
npm run build        # dist/platform.js + docs/index.html
```

- `src/core.js` — prompts, text pipeline, response normalizers
- `src/app.js`, `src/styles.css`, `src/index.html` — the app
- `src/platform/` — lock/setup screens, Anthropic backend, GitHub storage, vault
- `docs/index.html#mock` — offline demo with fake AI, no keys needed
- `#analytics` — your visits & usage dashboard (not linked anywhere in the app; `#mock&analytics` for the demo). Visit logs live in the data repo under `analytics/`.
- First run: open the site with `#setup` (or with no `config.enc.json`) to create the encrypted config.
