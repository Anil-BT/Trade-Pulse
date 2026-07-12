# Firebase setup for TradePulse

Use Firebase for **Auth** (who you are) and **Firestore** (saved strategies).  
Candle history still comes from Yahoo / Upstox — you usually **do not** need Firebase Storage for that.

App already ships with client wiring. It stays offline (localStorage) until you add env vars.

---

## 1. Firebase Console (project: tradepulse)

Open [Firebase Console](https://console.firebase.google.com/) → your **tradepulse** project.

### Authentication

1. **Build → Authentication → Get started**
2. **Sign-in method** enable:
   - **Google** (recommended)
   - **Email/Password** (optional, also wired in the UI)
3. Under **Settings → Authorized domains**, add:
   - `localhost`
   - `tradepulse-nu.vercel.app` (and any custom domain)

### Firestore

1. **Build → Firestore Database → Create database**
2. Start in **production mode**
3. Pick a region (e.g. `asia-south1` for India)
4. **Rules** tab → paste:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Saved strategies
    match /users/{userId}/strategies/{strategyId} {
      allow read, write: if request.auth != null
        && request.auth.uid == userId;
    }
    // Day-level backtest cache (same strategy + day → skip broker)
    match /users/{userId}/dayCaches/{docId} {
      allow read, write: if request.auth != null
        && request.auth.uid == userId;
    }
    // Full F&O universe scan results (successful symbols only)
    match /users/{userId}/scanResults/{docId} {
      allow read, write: if request.auth != null
        && request.auth.uid == userId;
    }
  }
}
```

5. **Publish**

Data shape:

```
users/{uid}/strategies/{strategyId}
  name: string
  strategy: { name, entry[], exit[], ... }
  createdAt: number
  updatedAt: number

users/{uid}/dayCaches/{fingerprint_YYYY-MM-DD}
  fingerprint: string   // strategy + symbol + settings hash
  day: string           // YYYY-MM-DD
  symbol, interval, source
  trades: Trade[]
  candles: Candle[]     // that session only (optional/light)
  savedAt: number

users/{uid}/scanResults/{fingerprint_from_to}
  fingerprint: string   // strategy + FNO_UNIVERSE + settings
  strategyName, from, to, interval, source
  rows: ScanRow[]       // status ok | no_trades only (errors skipped)
  summary, skippedErrors, savedAt
```

### Storage (optional — only if you need files later)

Not required for strategies. Use later for:

- exported CSV archives
- large shared report blobs

If you enable it:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{userId}/{allPaths=**} {
      allow read, write: if request.auth != null
        && request.auth.uid == userId
        && request.resource.size < 10 * 1024 * 1024;
    }
  }
}
```

---

## 2. Web app config

1. Project **Settings** (gear) → **Your apps** → Web (`</>`)  
   If you already registered **tradepulse**, open it.
2. Copy the `firebaseConfig` values.

Local file `.env.local` (never commit):

```bash
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=tradepulse-xxxxx.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=tradepulse-xxxxx
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=tradepulse-xxxxx.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=1:...:web:...
```

Vercel → Project **tradepulse** → **Settings → Environment Variables**  
Add the same six keys for **Production** (and Preview if you want).  
Redeploy after saving.

---

## 3. How the app uses it

| Feature | Without Firebase | With Firebase + signed in |
|--------|-------------------|---------------------------|
| Save strategy | `localStorage` | Firestore `users/{uid}/strategies` |
| Save F&O scan | — | Firestore `users/{uid}/scanResults` (no-error symbols) |
| Day cache (single symbol) | — | Firestore `users/{uid}/dayCaches` (auto on chunk) |
| Cross-device | No | Yes |
| Sign in UI | Hidden | Header **Sign in** |
| First sign-in | — | Local strategies auto-migrated if cloud empty |

Code map:

- `src/lib/firebase/client.ts` — init
- `src/lib/firebase/auth-context.tsx` — session
- `src/lib/firebase/strategies.ts` — Firestore CRUD
- `src/lib/firebase/scan-results.ts` — F&O scan save
- `src/lib/firebase/day-cache.ts` — single-symbol day cache
- `src/components/AuthBar.tsx` — UI
- `src/components/StrategyLibrary.tsx` — save/load cloud or local

---

## 4. When you need what

| Need | Product |
|------|---------|
| Login / identity | **Authentication** |
| Named strategies, prefs, run history metadata | **Firestore** |
| Large binary files / CSVs | **Storage** (optional) |
| Historical OHLCV for backtests | **Not Firebase** — Yahoo / Upstox |
| Server secrets (admin, private keys) | **Never** in `NEXT_PUBLIC_*` |

`NEXT_PUBLIC_*` values are public by design (browser SDK). Security is **Auth + security rules**, not hiding the API key.

---

## 5. Quick test

1. Set env vars, restart `npm run dev`
2. Header shows **Sign in**
3. Sign in with Google
4. Save a strategy → check Firestore console under `users/{yourUid}/strategies`
5. Another browser / device → sign in → strategies appear

---

## 6. Common errors

| Error | Fix |
|-------|-----|
| Sign-in UI missing | Env vars not loaded; restart dev server / redeploy |
| `auth/unauthorized-domain` | Add domain under Auth → Settings → Authorized domains |
| `permission-denied` | Publish Firestore rules above |
| Popup blocked | Allow popups for the site, or use email sign-in |
| Empty strategies after login | Cloud empty + migration only if cloud empty; save once |

---

## 7. Optional next steps

- Save last scan summary under `users/{uid}/runs/{id}`
- Admin SDK on Vercel only if you need server-side privileged access (not required for strategy sync)
- App Check if you want abuse protection on public API keys
