# UI screenshots

Taken with Playwright (`node web/scripts/screenshots.mjs`) against the running demo stack (`npm run dev`): desktop 1440x900 and phone 390x844 (2x). Every number comes from the live API on the local demo chain (play money). Pot / attempt / streak figures present at first start are seeded demo data; wins, blocks and the chat shown in the `guardian-*` shots are real actions performed during the capture, against the real model configured in `.env` (Groq).

| Page | Desktop | Phone |
|---|---|---|
| Landing: hero | `landing-hero-desktop.png` | `landing-hero-phone.png` |
| Landing: sticky "how it works" | `landing-how-1-desktop.png`, `landing-how-3-desktop.png` | `landing-how-1-phone.png` (stacked) |
| Landing: gallery of the three states | `landing-gallery-desktop.png` | `landing-gallery-phone.png` (swipe) |
| Landing: Guardian list, CTA, footer | `landing-list-desktop.png`, `landing-cta-footer-desktop.png` | `landing-list-phone.png`, `landing-cta-footer-phone.png` |
| Arena | `arena-desktop.png` | `arena-phone.png` |
| Guardian: idle | `guardian-idle-desktop.png` | `guardian-idle-phone.png` |
| Guardian: zero-wallet sign-in | `guardian-signin-desktop.png` | `guardian-signin-phone.png` |
| Guardian: live chat | `guardian-chat-desktop.png` | `guardian-chat-phone.png` |
| Guardian: win ("Pot released") | `guardian-won-desktop.png` | not captured (the phone run targets a Guardian that holds) |
| Guardian: Prove it | `guardian-prove-desktop.png` | `guardian-prove-phone.png` |
| Guardian: BLOCKED by the vault | `guardian-blocked-desktop.png` | `guardian-blocked-phone.png` |
